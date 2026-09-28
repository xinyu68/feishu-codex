[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Shared', 'Independent')]
    [string]$Mode,

    [string]$WsUrl,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [string]$DesktopProfile,
    [string]$CodexHome,
    [switch]$ShowWindow
)

# Diagnostic package-context launch only. This is not a production launcher.
# No user/machine environment changes, bot consumers, or process termination.
$ErrorActionPreference = 'Stop'

function Get-ProbeAbsolutePath([string]$Value, [string]$Label) {
    if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
        throw "$Label 必须填写 Windows 绝对路径。"
    }
    return [IO.Path]::GetFullPath($Value)
}

function Write-ProbeJson([string]$Path, $Value) {
    $temporaryPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporaryPath, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Get-ProbeProfileArgument([string]$CommandLine) {
    $pattern = '(?i)(?:^|\s)(?:"--user-data-dir=(?<whole>[^"]*)"|--user-data-dir(?:=|\s+)(?:"(?<quoted>[^"]*)"|(?<plain>\S+)))'
    $match = [regex]::Match($CommandLine, $pattern)
    if (-not $match.Success) { return $null }
    foreach ($name in @('whole', 'quoted', 'plain')) {
        if ($match.Groups[$name].Success) { return [IO.Path]::GetFullPath($match.Groups[$name].Value).TrimEnd('\', '/') }
    }
}

function Assert-ProbeProfileAvailable([string]$Profile) {
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $appProcesses = @($allProcesses | Where-Object {
        $_.Name -in @('ChatGPT.exe', 'Codex.exe') -and
        $_.ExecutablePath -match '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$'
    })
    foreach ($unknownProcess in @($allProcesses | Where-Object { $_.Name -eq 'ChatGPT.exe' -and -not $_.ExecutablePath })) {
        throw "无法确认 ChatGPT.exe 进程（PID $($unknownProcess.ProcessId)）的身份；为避免重复启动，已停止本次验证。"
    }
    $roots = @($appProcesses | Where-Object { $_.CommandLine -notmatch '(?i)(?:^|\s|"|\x27)--type(?:=|\s)' })
    if (-not $Profile -and $roots.Count) {
        throw "Codex 桌面仍在运行（PID $($roots.ProcessId -join ', ')）。请先完全退出 Codex，再继续验证。"
    }
    if (-not $Profile) { return }
    $targetProfile = [IO.Path]::GetFullPath($Profile).TrimEnd('\', '/')
    foreach ($root in $roots) {
        if (-not $root.CommandLine) { throw "无法确认 Codex 进程（PID $($root.ProcessId)）使用的桌面配置目录。" }
        $treeIds = @([uint32]$root.ProcessId)
        do {
            $newIds = @($allProcesses | Where-Object { $treeIds -contains [uint32]$_.ParentProcessId -and $treeIds -notcontains [uint32]$_.ProcessId } | ForEach-Object { [uint32]$_.ProcessId })
            $treeIds += $newIds
        } while ($newIds.Count)
        $profiles = @($appProcesses | Where-Object { $treeIds -contains [uint32]$_.ProcessId } | ForEach-Object {
            $argument = Get-ProbeProfileArgument $_.CommandLine
            if ($argument) {
                $argument
                # Owl renderers use <desktop profile>\web\Codex. The normal
                # main process itself may have no --user-data-dir argument.
                if ($argument.EndsWith('\web\Codex', [StringComparison]::OrdinalIgnoreCase)) {
                    $argument.Substring(0, $argument.Length - '\web\Codex'.Length)
                }
            }
        })
        if (-not $profiles.Count) {
            throw "无法确认 Codex 进程（PID $($root.ProcessId)）使用的桌面配置目录；为避免重复启动，已停止本次验证。"
        }
        foreach ($existingProfile in $profiles) {
            if ($existingProfile.Equals($targetProfile, [StringComparison]::OrdinalIgnoreCase) -or
                $existingProfile.StartsWith($targetProfile + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw "指定的桌面配置目录正被 Codex 进程（PID $($root.ProcessId)）使用。"
            }
        }
    }
}

$report = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString('o')
    expectedMode = $Mode
    started = $false
    pid = $null
    startTime = $null
    exe = $null
    error = $null
    launchMethod = 'Invoke-CommandInDesktopPackage (diagnostics only)'
}
$probeDirectory = $null
$probeResultFile = $null
$probeBootstrapFile = $null
$bootstrapCompleted = $false
$resultPathValidated = $false

try {
    $ResultPath = Get-ProbeAbsolutePath $ResultPath 'ResultPath'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($ResultPath))
    $resultPathValidated = $true
    if ($Mode -eq 'Shared') {
        if ($WsUrl -notmatch '\Aws://127\.0\.0\.1:([0-9]{1,5})/?\z' -or [int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt 65535) {
            throw '共享模式的 WsUrl 必须为 ws://127.0.0.1:<1-65535>，不能包含账号密码、路径、查询参数或片段。'
        }
    } elseif ($WsUrl) {
        throw '独立模式不能填写 WsUrl 参数。'
    }
    if ($DesktopProfile) { $DesktopProfile = Get-ProbeAbsolutePath $DesktopProfile 'DesktopProfile' }
    if ($CodexHome) { $CodexHome = Get-ProbeAbsolutePath $CodexHome 'CodexHome' }
    Assert-ProbeProfileAvailable $DesktopProfile
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
    if (-not $package) { throw '未找到已安装的商店版 Codex（OpenAI.Codex）。' }
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml') -Raw
    $application = @($manifest.Package.Applications.Application | Where-Object { $_.Executable -match '(?i)(?:^|[\\/])ChatGPT\.exe$' })
    if ($application.Count -ne 1) { throw '无法从安装包清单中唯一确定 ChatGPT.exe 启动入口。' }
    $executable = Join-Path $package.InstallLocation ([string]$application[0].Executable)
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '未找到 Codex 桌面的可执行文件。' }
    [void](Get-Command Invoke-CommandInDesktopPackage -ErrorAction Stop)
    $report.exe = $executable
    $report.packageFullName = [string]$package.PackageFullName
    $report.packageVersion = [string]$package.Version
    $report.appId = [string]$application[0].Id
    $report.desktopProfile = $(if ($DesktopProfile) { $DesktopProfile } else { $null })
    $report.codexHomeOverride = $(if ($CodexHome) { $CodexHome } else { $null })
    $report.showWindow = [bool]$ShowWindow
    Write-ProbeJson $ResultPath $report

    $probeDirectory = Join-Path ([IO.Path]::GetTempPath()) ('feishu-packaged-launch-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($probeDirectory)
    $probeResultFile = Join-Path $probeDirectory 'result.json'
    $probeBootstrapFile = Join-Path $probeDirectory 'bootstrap.ps1'
    $report.bootstrapResultPath = $probeResultFile
    $configuration = @{
        Mode = $Mode; WsUrl = $WsUrl; DesktopProfile = $DesktopProfile; CodexHome = $CodexHome
        ShowWindow = [bool]$ShowWindow; Executable = $executable; ResultPath = $probeResultFile
    }
    $encodedConfiguration = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($configuration | ConvertTo-Json -Compress)))
    $bootstrapSource = '$ErrorActionPreference = ''Stop''' + "`r`n"
    foreach ($functionName in @('Write-ProbeJson', 'Get-ProbeProfileArgument', 'Assert-ProbeProfileAvailable')) {
        $bootstrapSource += 'function ' + $functionName + ' {' + (Get-Command $functionName).Definition + "`r`n}`r`n"
    }
    $bootstrapSource += '$configuration = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' + $encodedConfiguration + ''')) | ConvertFrom-Json' + "`r`n"
    $bootstrapSource += @'
$result = [ordered]@{ wrapperPid = $PID; started = $false; pid = $null; startTime = $null; expectedMode = $configuration.Mode; exe = $configuration.Executable; error = $null }
$launchMutex = $null
$ownsMutex = $false
try {
    $profileIdentity = if ($configuration.DesktopProfile) { $configuration.DesktopProfile.TrimEnd('\', '/').ToLowerInvariant() } else { 'default-desktop-profile' }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $profileHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($profileIdentity))).Replace('-', '') } finally { $hasher.Dispose() }
    $launchMutex = [Threading.Mutex]::new($false, ('Local\FeishuCodexPackagedProbe-' + $profileHash))
    try { $ownsMutex = $launchMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw '另一个验证启动程序正在使用指定的桌面配置目录。' }
    Assert-ProbeProfileAvailable $configuration.DesktopProfile

    # Normalize only this temporary bootstrap's environment before constructing
    # ProcessStartInfo; .NET Framework rejects case-duplicate inherited keys.
    $inheritedEnvironment = [Environment]::GetEnvironmentVariables('Process')
    $childEnvironment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $inheritedEnvironment.Keys) {
        $canonicalKey = ([string]$key).ToUpperInvariant()
        if (-not $canonicalKey.StartsWith('=') -and
            (-not $childEnvironment.ContainsKey($canonicalKey) -or [StringComparer]::Ordinal.Equals([string]$key, $canonicalKey))) {
            $childEnvironment[$canonicalKey] = [string]$inheritedEnvironment[$key]
        }
    }
    [void]$childEnvironment.Remove('CODEX_APP_SERVER_WS_URL')
    [void]$childEnvironment.Remove('CODEX_APP_SERVER_FORCE_CLI')
    [void]$childEnvironment.Remove('CODEX_ELECTRON_USER_DATA_PATH')
    [void]$childEnvironment.Remove('ELECTRON_RUN_AS_NODE')
    if ($configuration.Mode -eq 'Shared') { $childEnvironment['CODEX_APP_SERVER_WS_URL'] = [string]$configuration.WsUrl }
    if ($configuration.DesktopProfile) {
        [void][IO.Directory]::CreateDirectory($configuration.DesktopProfile)
        $childEnvironment['CODEX_ELECTRON_USER_DATA_PATH'] = [string]$configuration.DesktopProfile
    }
    if ($configuration.CodexHome) {
        [void][IO.Directory]::CreateDirectory($configuration.CodexHome)
        $childEnvironment['CODEX_HOME'] = [string]$configuration.CodexHome
    }
    foreach ($key in @($inheritedEnvironment.Keys)) {
        if (-not ([string]$key).StartsWith('=')) { [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process') }
    }
    foreach ($entry in $childEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $configuration.Executable
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($configuration.Executable)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = -not $configuration.ShowWindow
    $startInfo.WindowStyle = if ($configuration.ShowWindow) { [Diagnostics.ProcessWindowStyle]::Normal } else { [Diagnostics.ProcessWindowStyle]::Hidden }
    if ($configuration.DesktopProfile) {
        # Quoted Windows arguments require trailing backslashes to be doubled.
        $argumentProfile = ([string]$configuration.DesktopProfile) -replace '(\\+)$', '$1$1'
        $startInfo.Arguments = '--user-data-dir="' + $argumentProfile + '"'
    }
    $startInfo.EnvironmentVariables.Clear()
    foreach ($entry in $childEnvironment.GetEnumerator()) { $startInfo.EnvironmentVariables[$entry.Key] = $entry.Value }
    $child = [Diagnostics.Process]::Start($startInfo)
    $result.pid = $child.Id
    $result.started = $true
    $result.startTime = $child.StartTime.ToUniversalTime().ToString('o')
    # This verifies process creation only, not backend mode or App readiness.
    if ($child.WaitForExit(300)) { throw "Codex 桌面启动后立即退出（退出码 $($child.ExitCode)）；验证脚本没有终止任何进程。" }
} catch {
    $result.error = $_.Exception.Message
} finally {
    try { Write-ProbeJson $configuration.ResultPath $result } finally {
        if ($ownsMutex) { $launchMutex.ReleaseMutex() }
        if ($launchMutex) { $launchMutex.Dispose() }
        # Never wait for or stop the App. The diagnostic bootstrap exits here.
        Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
    }
}
'@
    # PS 5.1 requires a BOM for non-ASCII paths/literals in script files.
    [IO.File]::WriteAllText($probeBootstrapFile, $bootstrapSource, [Text.UTF8Encoding]::new($true))
    $powershellExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $probeBootstrapFile + '"'
    Invoke-CommandInDesktopPackage -PackageFamilyName $package.PackageFamilyName -AppId $application[0].Id -Command $powershellExecutable -Args $arguments -PreventBreakaway | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (Test-Path -LiteralPath $probeResultFile -PathType Leaf) {
            $bootstrapResult = [IO.File]::ReadAllText($probeResultFile) | ConvertFrom-Json
            foreach ($property in $bootstrapResult.PSObject.Properties) { $report[$property.Name] = $property.Value }
            $bootstrapCompleted = $true
            break
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $bootstrapCompleted) {
        $report.bootstrapResultPath = $probeResultFile
        throw '等待 30 秒仍未收到启动结果，目前无法确认是否启动成功。请先检查报告中 bootstrapResultPath 指向的日志，再决定是否重试。验证脚本没有终止任何进程。'
    }
} catch {
    $report.error = $_.Exception.Message
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    if ($resultPathValidated) { Write-ProbeJson $ResultPath $report }
    if ($bootstrapCompleted -and $probeDirectory) {
        # Remove only known files in the exact temporary directory, never a tree.
        foreach ($knownFile in @($probeBootstrapFile, $probeResultFile)) {
            if (Test-Path -LiteralPath $knownFile) { Remove-Item -LiteralPath $knownFile -Force -ErrorAction SilentlyContinue }
        }
        try { [IO.Directory]::Delete($probeDirectory, $false) } catch { }
    }
}

$report | ConvertTo-Json -Depth 8
if ($report.error) { throw [InvalidOperationException]::new([string]$report.error) }
