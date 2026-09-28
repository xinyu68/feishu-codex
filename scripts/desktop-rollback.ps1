param([string]$BackupDir, [switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
. (Join-Path $PSScriptRoot 'desktop-migration-common.ps1')
if (-not $BackupDir) { $BackupDir = Read-Host '请输入接管时显示的备份目录' }
$BackupDir = [IO.Path]::GetFullPath($BackupDir)
$manifestFile = Join-Path $BackupDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw '没有找到回退清单。' }
$manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
if ($manifest.version -ne 1 -or -not $manifest.dataDir -or -not $manifest.oldRoot) { throw '回退清单不完整。' }
if (-not $NonInteractive) { Write-Host '请先结束运行中的任务，并完全退出 Codex 桌面。'; [void](Read-Host '完成后按回车继续') }
if (@(Get-CodexDesktopProcesses).Count) { throw 'Codex 桌面仍在运行，没有执行回退。' }
$directory = Join-Path $manifest.dataDir 'desktop'
$controlFile = Join-Path $directory 'host-control.json'
$control = if (Test-Path -LiteralPath $controlFile) { [IO.File]::ReadAllText($controlFile) | ConvertFrom-Json } else { $null }
$status = $null
if ($control) { try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($control.port)/status" -TimeoutSec 3 } catch { } }
if ($status) {
    if ($status.pid -ne $control.pid) { throw '后台身份不匹配，未执行回退。' }
    Invoke-RestMethod -Uri "http://127.0.0.1:$($control.port)/control" -Method Post -Headers @{ 'X-Host-Token' = $control.token } -ContentType 'application/json' -Body '{"action":"shutdown"}' -TimeoutSec 90 | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $listeners = @(Get-NetTCPConnection -LocalPort 8790,18791,18792 -State Listen -ErrorAction SilentlyContinue)
        if (-not $listeners.Count) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($listeners.Count) { throw '新后台尚未完全退出，未恢复旧服务。' }
} else {
    # Never force-stop an unresponsive host. It might still own active work.
    $identityFile = Join-Path $directory 'host-identity.json'
    if (Test-Path -LiteralPath $identityFile) {
        $identity = [IO.File]::ReadAllText($identityFile) | ConvertFrom-Json
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$identity.pid)" -ErrorAction SilentlyContinue
        if (Test-DesktopRecordedIdentity $candidate $identity) { throw '新后台还活着但未响应。请先恢复连接，未强行停止任何任务。' }
    }
    foreach ($component in @('bridge', 'runtime', 'relay')) {
        $componentFile = Join-Path $directory ($component + '-identity.json')
        if (-not (Test-Path -LiteralPath $componentFile)) { continue }
        $identity = [IO.File]::ReadAllText($componentFile) | ConvertFrom-Json
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$identity.pid)" -ErrorAction SilentlyContinue
        if (Test-DesktopRecordedIdentity $candidate $identity) {
            throw '桌面后台已经退出，但仍有它启动的服务在运行。请打开 Feishu Codex，点击重试连接，再从托盘退出全部服务后重试回退；不会同时启动两个飞书接收服务。'
        }
    }
}
$newTask = Get-ScheduledTask -TaskName 'Feishu Codex Desktop Host' -ErrorAction SilentlyContinue
if ($newTask) { Disable-ScheduledTask -TaskName 'Feishu Codex Desktop Host' | Out-Null }
foreach ($name in @('config.json', 'runtime.json')) {
    $source = Join-Path $BackupDir $name
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $manifest.dataDir $name) -Force }
}
# Keep state.json and .codex history as they are, so new conversations are not
# erased by a rollback. The pre-migration state remains in the backup for audit.
$sourceRoot = Join-Path $BackupDir 'old-deployment'
foreach ($name in @('dist', 'public', 'scripts')) {
    $source = Join-Path $sourceRoot $name
    $target = Join-Path $manifest.oldRoot $name
    if (Test-Path -LiteralPath $source -PathType Container) {
        [void][IO.Directory]::CreateDirectory($target)
        foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
            $relative = $item.FullName.Substring($source.Length).TrimStart('\', '/')
            $destination = Join-Path $target $relative
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            Copy-Item -LiteralPath $item.FullName -Destination $destination -Force
        }
    }
}
Set-DesktopEnvironmentBackup $manifest.environment
foreach ($record in $manifest.tasks) {
    if ($record.exists) {
        $xml = [IO.File]::ReadAllText((Join-Path $BackupDir $record.xmlFile))
        Register-ScheduledTask -TaskName $record.name -Xml $xml -Force | Out-Null
        if ($record.enabled) { Enable-ScheduledTask -TaskName $record.name | Out-Null } else { Disable-ScheduledTask -TaskName $record.name | Out-Null }
    } elseif ($record.name -eq 'Feishu Codex Desktop Host') {
        # Our newly introduced demand task remains disabled for diagnosis.
        if (Get-ScheduledTask -TaskName $record.name -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $record.name | Out-Null }
    }
}
Write-CodexRuntimeJson (Join-Path $directory 'deployment.json') @{ version = 1; state = 'rolled-back'; productRoot = $manifest.productRoot; backup = $BackupDir }
if ($manifest.runtimeWasRunning -and (Get-ScheduledTask -TaskName 'Feishu Codex Shared Runtime' -ErrorAction SilentlyContinue)) { Start-ScheduledTask -TaskName 'Feishu Codex Shared Runtime' }
if ($manifest.bridgeWasRunning -and (Get-ScheduledTask -TaskName 'Feishu Codex' -ErrorAction SilentlyContinue)) { Start-ScheduledTask -TaskName 'Feishu Codex' }
$configFile = Join-Path $BackupDir 'config.json'
if ($manifest.bridgeWasRunning -and (Test-Path -LiteralPath $configFile)) {
    $savedConfig = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        try {
            $listener = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($listener) {
                Assert-FeishuCodexProcess $listener.OwningProcess $manifest.dataDir (Join-Path $manifest.oldRoot 'dist\server.js')
                $state = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/state' -TimeoutSec 3
                if ([bool]$state.config.enabled -eq [bool]$savedConfig.enabled) { break }
                Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/connection' -Method Post -Headers @{ 'X-Bridge-Token' = $state.csrfToken } -ContentType 'application/json' -Body (@{ enabled = [bool]$savedConfig.enabled } | ConvertTo-Json -Compress) -TimeoutSec 5 | Out-Null
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
}
Write-Host '已恢复旧服务配置和原有环境变量；原生任务历史未回退。' -ForegroundColor Green
if (-not $NonInteractive) { [void](Read-Host '按回车结束') }
