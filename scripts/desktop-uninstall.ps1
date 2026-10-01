param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [ValidateSet('Prepare', 'Cleanup', 'ClearData')][string]$Phase = 'Prepare',
    [string]$DataDir = $(if ($env:FEISHU_CODEX_DATA_DIR) { $env:FEISHU_CODEX_DATA_DIR } else { Join-Path $env:USERPROFILE '.feishu-codex' })
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'desktop-process-tree.ps1')
. (Join-Path $PSScriptRoot 'desktop-service-listeners.ps1')
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir).TrimEnd('\')) { throw '安装目录无效。' }
$productRoot = Join-Path $InstallDir 'resources\product'
$appExe = Join-Path $InstallDir 'Feishu Codex.exe'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$taskName = 'Feishu Codex Desktop Host'
$ownedTask = $null
$restoreTask = $false

function Read-State($Name) {
    $file = Join-Path $DataDir ('desktop\' + $Name + '.json')
    if (Test-Path -LiteralPath $file -PathType Leaf) { return [IO.File]::ReadAllText($file) | ConvertFrom-Json }
    return $null
}
function Write-UninstallLog($Message) {
    $directory = Join-Path $DataDir 'desktop'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    [IO.File]::AppendAllText((Join-Path $directory 'uninstall.log'), ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}
function Get-LiveIdentity($Identity) {
    if (-not $Identity -or $Identity.pid -le 0 -or -not $Identity.exe -or -not $Identity.startedAt) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Identity.pid)" -ErrorAction Stop
    if (Test-ProcessIdentity $Identity $candidate) { return $Identity }
    return $null
}
function Find-OwnedTask {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if (-not $task -or @($task.Actions).Count -ne 1) { return $null }
    $action = $task.Actions[0]
    $expected = '//B //NoLogo "' + (Join-Path $productRoot 'scripts\desktop-host.vbs') + '" "' + $productRoot + '" "' + (Join-Path $InstallDir 'resources\node\node.exe') + '" "' + $DataDir + '"'
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($action.Execute -ine (Join-Path $env:SystemRoot 'System32\wscript.exe') -or $action.WorkingDirectory -ine $productRoot -or $action.Arguments -ine $expected) { return $null }
    $owner = [string]$task.Principal.UserId
    if ($owner -ne $current.User.Value) {
        try { $owner = ([Security.Principal.NTAccount]::new($owner)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { return $null }
    }
    if ($owner -ne $current.User.Value) { return $null }
    return $task
}

try {
    Write-UninstallLog ('开始 ' + $Phase + '：' + $InstallDir)
    $deployment = Read-State 'deployment'
    $control = Read-State 'host-control'
    $ownsData = $deployment -and $deployment.productRoot -ieq $productRoot
    if ($Phase -eq 'ClearData' -and -not $ownsData) {
        foreach ($name in @('host', 'runtime', 'bridge', 'relay', 'desktop')) {
            if (Get-LiveIdentity (Read-State ($name + '-identity'))) { throw '保留的数据仍被其他安装使用，未清除任何数据。' }
        }
        if (@(Get-BlockingServiceListeners -DataDir $DataDir).Count) { throw '仍有本机服务正在运行，未清除任何数据。' }
    }
    if ($ownsData -and $control -and ($control.root -ine $productRoot -or $control.dataDir -ine $DataDir)) { throw '后台归属不一致，请打开应用恢复连接后重试。' }
    $serviceTrees = @()
    $serviceIdentities = @()
    $hostIdentity = $null
    if ($ownsData) {
        foreach ($name in @('host', 'runtime', 'bridge', 'relay')) {
            $identity = Get-LiveIdentity (Read-State ($name + '-identity'))
            if ($identity) {
                $serviceIdentities += $identity
                $serviceTrees += @(Get-OwnedProcessTree $identity)
                if ($name -eq 'host') { $hostIdentity = $identity }
            }
        }
    }
    # Capture before the host requests a normal window close: Electron children
    # may survive even when their parent has already exited.
    $desktopIdentity = if ($ownsData) { Get-LiveIdentity (Read-State 'desktop-identity') } else { $null }
    $desktopTree = if ($desktopIdentity) { @(Get-OwnedProcessTree $desktopIdentity) } else { @() }
    Write-UninstallLog ('退出检查：后台 PID=' + $hostIdentity.pid + '，桌面 PID=' + $desktopIdentity.pid + '，服务进程数=' + $serviceTrees.Count + '，桌面进程数=' + @($desktopTree).Count)
    if (-not $hostIdentity -and ($serviceIdentities.Count -or $desktopIdentity)) { throw '后台控制服务不可用，但仍有本应用启动的进程。请打开 Feishu Codex 恢复连接并退出全部服务，再重试卸载。' }
    if ($hostIdentity) {
        if (-not $control -or $control.pid -ne $hostIdentity.pid -or -not $control.token -or $control.port -lt 1024 -or $control.port -gt 65535) { throw '后台控制记录无效，已取消卸载。' }
        $listeners = @(Get-NetTCPConnection -LocalPort $control.port -State Listen -ErrorAction SilentlyContinue)
        if (-not $listeners.Count -or @($listeners | Where-Object { $_.OwningProcess -ne $hostIdentity.pid -or $_.LocalAddress -ne '127.0.0.1' }).Count) { throw '无法确认后台控制端口，已取消卸载。' }
    }
    $ownedTask = Find-OwnedTask
    if ($ownedTask) {
        $restoreTask = $ownedTask.Settings.Enabled
        Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
    }
    # Close only this installation's shell, so it cannot reopen the host while
    # we wait for its authenticated shutdown. Codex tasks run in the host.
    $shells = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -ieq $appExe })
    $shellTrees = @()
    foreach ($shell in $shells) { $shellTrees += @(Get-OwnedProcessTree (Get-ProcessIdentity $shell)) }
    Stop-OwnedProcessTree $shellTrees
    if ($hostIdentity) {
        try {
            $result = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $control.port + '/control') -Method Post -Headers @{ 'X-Host-Token' = $control.token } -ContentType 'application/json' -Body '{"action":"shutdownAll","uninstall":true}' -TimeoutSec 120
        } catch {
            $message = '无法安全退出后台，已取消卸载。请打开应用查看任务状态后重试。'
            $httpError = $_
            try {
                $body = $httpError.ErrorDetails.Message
                if (-not $body -and $httpError.Exception.Response) {
                    $reader = [IO.StreamReader]::new($httpError.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
                    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
                }
                $detail = $body | ConvertFrom-Json
                if ($detail.error) { $message = $detail.error }
            } catch {}
            throw $message
        }
        if ($result.ok -ne $true) { throw '后台尚未确认退出，已取消卸载。' }
        # Only after the idle barrier and successful graceful shutdown may any
        # captured survivors be ended. No image-wide taskkill is used.
        Start-Sleep -Milliseconds 500
        if (-not $result.PSObject.Properties['closedDesktop'] -or $result.closedDesktop) {
            Stop-OwnedProcessTree $desktopTree
        } else {
            # A separately opened Codex is allowed to remain open. Do not sweep
            # its children even if a stale desktop record still exists.
            $preserved = @($desktopTree | ForEach-Object { $_.pid })
            $serviceTrees = @($serviceTrees | Where-Object { $_.pid -notin $preserved })
            $savedDesktop = Read-State 'desktop-identity'
            if ($desktopIdentity -and $savedDesktop.pid -eq $desktopIdentity.pid -and $savedDesktop.exe -ieq $desktopIdentity.exe -and $savedDesktop.startedAt -eq $desktopIdentity.startedAt) {
                Remove-Item -LiteralPath (Join-Path $DataDir 'desktop\desktop-identity.json') -Force
            }
        }
        Stop-OwnedProcessTree $serviceTrees
    }
    $remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $appExe -or $_.ExecutablePath.StartsWith($InstallDir + '\resources\', [StringComparison]::OrdinalIgnoreCase)) })
    if ($remaining.Count) { throw '安装目录仍被进程使用，已取消卸载。请关闭应用后重试。' }
    if ($ownedTask) {
        if (-not (Find-OwnedTask)) { throw '后台启动项已变化，已取消清理。' }
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
        $restoreTask = $false
        Write-UninstallLog '已移除本安装的后台计划任务。'
    }
    if ($Phase -eq 'Cleanup') {
        $runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
        try {
            if ($runKey) {
                foreach ($name in $runKey.GetValueNames()) {
                    $value = [string]$runKey.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    if ($value -ieq ('"' + $appExe + '"') -or $value -ieq $appExe) { $runKey.DeleteValue($name, $false); Write-UninstallLog '已移除本安装的开机启动项。' }
                }
            }
        } finally { if ($runKey) { $runKey.Dispose() } }
    }
    Write-UninstallLog '退出检查通过；Codex 账号、配置和历史记录保持不变。'
    if ($Phase -eq 'ClearData') {
        if (@(Get-BlockingServiceListeners -DataDir $DataDir).Count) { throw '仍有本机服务正在运行，未清除任何数据。' }
        . (Join-Path $PSScriptRoot 'desktop-clear-data.ps1')
        Remove-FeishuApplicationData -DataDir $DataDir
    }
    Write-Output '已安全关闭本应用及其服务。'
    exit 0
} catch {
    if ($restoreTask -and (Find-OwnedTask)) { Enable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null }
    Write-UninstallLog ('操作中止：' + $_.Exception.Message)
    Write-Output $_.Exception.Message
    exit 1
}
