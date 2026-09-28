param(
    [Parameter(Mandatory=$true)][string]$ProductRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [string]$DataDir = (Join-Path $env:USERPROFILE '.feishu-codex'),
    [string]$OldRoot = 'D:\projectdemo\feishu-codex',
    [string]$BaselinePath,
    [switch]$NonInteractive,
    [switch]$WaitForDesktopExit,
    [switch]$CheckOnly,
    [string]$PreflightFile,
    [string]$ExpectedUserSid,
    [string]$StatusFile,
    [string]$RunId = ([Guid]::NewGuid().ToString('D')),
    [int]$DesktopWaitSeconds = 1800
)
$ErrorActionPreference = 'Stop'
# Status reporting is self-contained so missing helpers and other early errors
# are still visible to the desktop application. No credentials enter the log.
$script:MigrationStartedAt = [DateTime]::UtcNow.ToString('o')
$script:MigrationPhase = 'starting'
$script:MigrationLogKey = ''
$script:MigrationStatusAllowed = $false
$migrationMutex = $null
$ownsMigrationMutex = $false
$backup = $null
$changed = $false
$completed = $false
$rollbackAttempted = $false
$rollbackCompleted = $false
$rollbackError = $null
$requiresElevation = $false
$preflight = $null

function Write-MigrationStatus([string]$State, [string]$Phase, [string]$Message) {
    if (-not $script:MigrationStatusAllowed) { return }
    $script:MigrationPhase = $Phase
    $value = [ordered]@{
        version = 1; runId = $RunId; status = $State; state = $State; phase = $Phase; message = $Message
        pid = $PID; startedAt = $script:MigrationStartedAt; updatedAt = [DateTime]::UtcNow.ToString('o')
        backupDir = $backup; changed = [bool]$changed
        requiresElevation = [bool]$requiresElevation
        rollback = @{ attempted = [bool]$rollbackAttempted; completed = [bool]$rollbackCompleted; error = $rollbackError }
    }
    $temporary = $StatusFile + '.' + $PID + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        for ($attempt = 0; $attempt -lt 4; $attempt++) {
            try { Move-Item -LiteralPath $temporary -Destination $StatusFile -Force; break }
            catch { if ($attempt -eq 3) { throw }; Start-Sleep -Milliseconds 80 }
        }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
    $logKey = $State + '/' + $Phase + '/' + $Message
    if ($script:MigrationLogKey -ne $logKey) {
        $line = [DateTime]::UtcNow.ToString('o') + ' [' + $RunId + '] ' + $State + '/' + $Phase + ' ' + $Message
        [IO.File]::AppendAllText((Join-Path ([IO.Path]::GetDirectoryName($StatusFile)) 'migration-details.log'), $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Write-Output $Message
        $script:MigrationLogKey = $logKey
    }
}

try {
    try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    if ($CheckOnly) {
        if (-not $PreflightFile) { $PreflightFile = Join-Path $DataDir 'desktop\migration-preflight.json' }
        $StatusFile = $PreflightFile
    }
    if (-not $StatusFile) { $StatusFile = Join-Path $DataDir 'desktop\migration-status.json' }
    $StatusFile = [IO.Path]::GetFullPath($StatusFile)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StatusFile))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $mutexHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($DataDir.TrimEnd('\', '/').ToLowerInvariant()))).Replace('-', '') } finally { $hasher.Dispose() }
    $migrationMutex = [Threading.Mutex]::new($false, ('Local\FeishuCodexMigration-' + $mutexHash))
    try { $ownsMigrationMutex = $migrationMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMigrationMutex = $true }
    if (-not $ownsMigrationMutex) { throw '另一个接管程序正在处理此数据目录。请等待它完成，不要重复接管。' }
    $script:MigrationStatusAllowed = $true
    Write-MigrationStatus 'running' 'preflight' '正在检查安装文件和现有服务；此时尚未更改配置。'
    if ($DesktopWaitSeconds -lt 1 -or $DesktopWaitSeconds -gt 86400) { throw '等待时间必须为 1 到 86400 秒。' }
    $ProductRoot = [IO.Path]::GetFullPath($ProductRoot)
    $OldRoot = [IO.Path]::GetFullPath($OldRoot)
    . (Join-Path $PSScriptRoot 'shared-codex.ps1')
    . (Join-Path $PSScriptRoot 'desktop-migration-common.ps1')
    . (Join-Path $PSScriptRoot 'desktop-preflight.ps1')
    if ($ExpectedUserSid -and [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $ExpectedUserSid) { throw '管理员授权使用了另一个 Windows 账号。请使用当前登录账号授权，避免修改错误的用户配置。' }
    $preflight = Get-DesktopMigrationPreflight -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir -OldRoot $OldRoot -BaselinePath $BaselinePath -ExpectedUserSid $ExpectedUserSid
    $preflight | Add-Member -NotePropertyName runId -NotePropertyValue $RunId -Force
    $preflight | Add-Member -NotePropertyName pid -NotePropertyValue $PID -Force
    if (-not $CheckOnly) { Write-CodexRuntimeJson (Join-Path $DataDir 'desktop\migration-preflight.json') $preflight }
    $requiresElevation = [bool]$preflight.requiresElevation
    if ($CheckOnly) {
        $preflight | Add-Member -NotePropertyName runId -NotePropertyValue $RunId -Force
        $preflight | Add-Member -NotePropertyName pid -NotePropertyValue $PID -Force
        $preflight | Add-Member -NotePropertyName startedAt -NotePropertyValue $script:MigrationStartedAt -Force
        $preflight | Add-Member -NotePropertyName updatedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
        $resultStatus = if ($preflight.blocked) { 'failed' } elseif ($requiresElevation) { 'requires_elevation' } else { 'preflight_passed' }
        $preflight | Add-Member -NotePropertyName status -NotePropertyValue $resultStatus -Force
        $preflight | Add-Member -NotePropertyName state -NotePropertyValue $resultStatus -Force
        Write-CodexRuntimeJson $StatusFile $preflight
        Write-Output '只读预检已完成。没有停止服务、修改配置、创建或调整计划任务。'
        exit 0
    }
    if ($preflight.blocked) { throw (@($preflight.checks | Where-Object { $_.status -eq 'blocked' } | ForEach-Object { $_.message }) -join [Environment]::NewLine) }
    if ($requiresElevation) { throw '旧服务需要同一 Windows 用户的一次管理员授权才能核验和接管，请在授权提示中继续。' }
    if ($preflight.baselinePath) { $BaselinePath = [string]$preflight.baselinePath }
    Write-Host 'Feishu Codex 桌面版 · 首次接管' -ForegroundColor Cyan
    Write-Host '将保留旧服务用于回退，取消旧的登录自启，并移除共享地址的全局绑定。'
    Write-Host '飞书账号、授权和历史任务会保留。原 Codex 图标仍独立启动。'
    if (-not $NonInteractive) { Write-Host ''; Write-Host '请先结束正在运行的任务，并完全退出 Codex 桌面（包括托盘）。'; [void](Read-Host '完成后按回车继续') }
    foreach ($required in @((Join-Path $ProductRoot 'build\server\server.js'), (Join-Path $ProductRoot 'build\ui\index.html'), (Join-Path $ProductRoot 'desktop\host.mjs'), $NodePath, (Join-Path $OldRoot 'dist\server.js'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "所需文件不存在：$required" }
    }
    $desktopDeadline = [DateTime]::UtcNow.AddSeconds($DesktopWaitSeconds)
    while (@(Get-CodexDesktopProcesses).Count) {
        if (-not $WaitForDesktopExit) { throw 'Codex 桌面还在运行。请完全退出后重新执行，没有更改现有服务。' }
        Write-MigrationStatus 'waiting_for_codex' 'waiting_for_codex' '请完全退出官方 Codex（包括托盘），保留 Feishu Codex 打开。检测到退出后会自动继续；现在没有更改服务。'
        if ([DateTime]::UtcNow -ge $desktopDeadline) { throw '等待 Codex 退出已超时，尚未更改服务。退出官方 Codex 后，请重新点击接管。' }
        Start-Sleep -Seconds 2
    }
    Write-MigrationStatus 'running' 'preflight' 'Codex 桌面已退出，正在确认旧服务和任务状态。'
    # Recheck every dynamic identity after waiting, before any service is stopped.
    $preflight = Get-DesktopMigrationPreflight -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir -OldRoot $OldRoot -BaselinePath $BaselinePath -ExpectedUserSid $ExpectedUserSid
    $preflight | Add-Member -NotePropertyName runId -NotePropertyValue $RunId -Force
    $preflight | Add-Member -NotePropertyName pid -NotePropertyValue $PID -Force
    Write-CodexRuntimeJson (Join-Path $DataDir 'desktop\migration-preflight.json') $preflight
    $requiresElevation = [bool]$preflight.requiresElevation
    if ($preflight.blocked) { throw (@($preflight.checks | Where-Object { $_.status -eq 'blocked' } | ForEach-Object { $_.message }) -join [Environment]::NewLine) }
    if ($requiresElevation) { throw '进程权限在等待期间发生变化，仍需要一次管理员授权。' }
    if ($preflight.nativeDesktopRunning -or $preflight.activeCount -gt 0) { throw '还有桌面窗口或任务正在运行。请结束后重试；尚未更改服务。' }
    if (-not $BaselinePath) {
        $baselineRoot = Join-Path $DataDir 'desktop-baseline'
        $candidates = @(Get-ChildItem -LiteralPath $baselineRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
        foreach ($candidate in $candidates) {
            $infoFile = Join-Path $candidate.FullName 'baseline-info.json'
            if (Test-Path -LiteralPath $infoFile -PathType Leaf) {
                $info = [IO.File]::ReadAllText($infoFile) | ConvertFrom-Json
                if ($info.sourceRoot -ieq $OldRoot -and $info.version -eq '0.1.0') { $BaselinePath = $candidate.FullName; break }
            }
        }
    }
    if (-not $BaselinePath -or -not (Test-Path -LiteralPath (Join-Path $BaselinePath 'dist\server.js'))) { throw '未找到开发前的旧版部署备份，请用 -BaselinePath 指定已验证的备份目录。' }
    $runtime = Read-CodexRuntimeConfig $DataDir
    $wsUrl = if ($runtime.wsUrl) { [string]$runtime.wsUrl } else { 'ws://127.0.0.1:18791' }
    $uri = Get-CodexWebSocketUri $wsUrl
    $machineValue = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Machine')
    if ($machineValue) { throw '系统级共享地址由其他配置管理；请先处理系统级 CODEX_APP_SERVER_WS_URL，再执行接管。' }
    $environment = Get-DesktopEnvironmentBackup
    if ($environment.exists -and $environment.value -and ([string]$environment.value).TrimEnd('/') -ne $wsUrl.TrimEnd('/')) { throw '用户级共享地址不属于当前项目，未修改该设置。' }
    $activeHost = Join-Path $DataDir 'desktop\host-control.json'
    if (Test-Path -LiteralPath $activeHost) {
        $control = [IO.File]::ReadAllText($activeHost) | ConvertFrom-Json
        try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($control.port)/status" -TimeoutSec 2 } catch { $status = $null }
        if ($status -and $status.pid -eq $control.pid) { throw '桌面版后台正在运行，请先从托盘退出全部服务。' }
    }
    $bridgeListener = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bridgeListener) {
        Assert-FeishuCodexProcess $bridgeListener.OwningProcess $DataDir (Join-Path $OldRoot 'dist\server.js')
        $state = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/state' -TimeoutSec 5
        if (@($state.conversations | Where-Object { $_.busy -or $_.active }).Count -or @($state.pendingRequests).Count) { throw '飞书还有运行中的任务或待处理请求，请完成后再接管。' }
    }
    $runtimeListener = Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $ownedRuntime = $null
    if ($runtimeListener) {
        $ownedRuntime = Get-OwnedSharedCodexProcess $DataDir $wsUrl (Resolve-SharedCodexPath $runtime.codexPath)
        if (-not $ownedRuntime -or $ownedRuntime.ProcessId -ne $runtimeListener.OwningProcess -or $runtimeListener.LocalAddress -ne '127.0.0.1') { throw '共享端口身份不属于旧服务，未执行切换。' }
        $idleJson = & $NodePath (Join-Path $ProductRoot 'scripts\desktop-idle.mjs') $wsUrl
        if ($LASTEXITCODE -ne 0) { throw '共享后台仍有任务运行，或无法确认空闲，请稍后重试。' }
        $idle = $idleJson | ConvertFrom-Json
        if (-not $idle.ok -or $idle.activeCount -ne 0) { throw '尚未确认共享后台空闲。' }
    }
    Write-MigrationStatus 'running' 'backup' '检查通过，正在保存旧部署和回退备份。'
    $backup = Join-Path $DataDir ('desktop\migrations\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
    [void][IO.Directory]::CreateDirectory($backup)
    $tasks = @()
    foreach ($name in @('Feishu Codex', 'Feishu Codex Shared Runtime', 'Feishu Codex Desktop Host')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        $record = @{ name = $name; exists = [bool]$task; enabled = $false; running = $false; xmlFile = $null }
        if ($task) {
            $record.enabled = [bool]$task.Settings.Enabled; $record.running = $task.State -eq 'Running'; $record.xmlFile = $name.Replace(' ', '-') + '.xml'
            [IO.File]::WriteAllText((Join-Path $backup $record.xmlFile), (Export-ScheduledTask -TaskName $name), [Text.UTF8Encoding]::new($true))
        }
        $tasks += $record
    }
    foreach ($name in @('config.json', 'state.json', 'runtime.json')) {
        $source = Join-Path $DataDir $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name) }
    }
    $deploymentDirectory = Join-Path $backup 'old-deployment'
    [void][IO.Directory]::CreateDirectory($deploymentDirectory)
    foreach ($name in @('dist', 'public', 'scripts', 'package.json', 'package-lock.json')) {
        $source = Join-Path $BaselinePath $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $deploymentDirectory $name) -Recurse }
    }
    $manifest = @{ version = 1; createdAt = [DateTime]::UtcNow.ToString('o'); oldRoot = $OldRoot; baselinePath = $BaselinePath; productRoot = $ProductRoot; dataDir = $DataDir; nodePath = $NodePath; environment = $environment; tasks = $tasks; bridgeWasRunning = [bool]$bridgeListener; runtimeWasRunning = [bool]$runtimeListener; status = 'prepared' }
    Write-CodexRuntimeJson (Join-Path $backup 'manifest.json') $manifest
    Write-Host "回退备份：$backup"
    # From here every failure invokes the reverse operation using this manifest.
    $changed = $true
    Write-MigrationStatus 'migrating' 'stopping_old' '备份已完成，正在断开旧服务并切换后台。'
    foreach ($name in @('Feishu Codex', 'Feishu Codex Shared Runtime')) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $name | Out-Null } }
    if ($bridgeListener) {
        # Close inbound delivery first, then confirm no message crossed the
        # boundary before allowing the old server's shutdown implementation.
        Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/connection' -Method Post -Headers @{ 'X-Bridge-Token' = $state.csrfToken } -ContentType 'application/json' -Body '{"enabled":false}' -TimeoutSec 10 | Out-Null
        Start-Sleep -Milliseconds 500
        $quiet = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/state' -TimeoutSec 5
        if (@($quiet.conversations | Where-Object { $_.busy -or $_.active }).Count -or @($quiet.pendingRequests).Count) { throw '断开接收前有新任务开始，未停止旧服务。请等任务完成后重试。' }
        if ($ownedRuntime) {
            $idleJson = & $NodePath (Join-Path $ProductRoot 'scripts\desktop-idle.mjs') $wsUrl
            if ($LASTEXITCODE -ne 0) { throw '有新任务开始，未停止旧服务。' }
        }
        & (Join-Path $OldRoot 'scripts\stop.ps1') -DataDir $DataDir -Port 8790
    }
    if (@(Get-CodexDesktopProcesses).Count) { throw '切换期间 Codex 又被打开，已停止接管。请退出后重试。' }
    if ($ownedRuntime) {
        $idleJson = & $NodePath (Join-Path $ProductRoot 'scripts\desktop-idle.mjs') $wsUrl
        if ($LASTEXITCODE -ne 0) { throw '切换期间共享后台出现活动任务，已停止接管。' }
        Stop-DesktopVerifiedProcess $ownedRuntime $uri.Port $backup
    }
    $relayMetadataFile = Join-Path $DataDir 'desktop-tools-relay.pid.json'
    if (Test-Path -LiteralPath $relayMetadataFile) {
        $relayMetadata = [IO.File]::ReadAllText($relayMetadataFile) | ConvertFrom-Json
        $relay = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$relayMetadata.processId)" -ErrorAction SilentlyContinue
        if ($relay -and $relay.ExecutablePath -ieq $relayMetadata.executablePath -and (Test-CodexProcessStartTime $relay $relayMetadata.startedAt) -and $relay.CommandLine -match [regex]::Escape((Join-Path $OldRoot 'dist\desktop-tools-relay.js'))) { Stop-DesktopVerifiedProcess $relay 0 $backup }
        elseif ($relay) { throw '旧工具转接进程身份不匹配，未终止该进程。' }
    }
    [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
    Send-DesktopEnvironmentChanged
    if ($null -ne $env:CODEX_APP_SERVER_WS_URL) { Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue }
    $runtime.mode = 'shared'
    if (-not $runtime.wsUrl) { $runtime | Add-Member -NotePropertyName wsUrl -NotePropertyValue $wsUrl -Force }
    Write-CodexRuntimeJson (Join-Path $DataDir 'runtime.json') $runtime
    # Restore the saved connection preference after temporarily closing input.
    if (Test-Path -LiteralPath (Join-Path $backup 'config.json')) { Copy-Item -LiteralPath (Join-Path $backup 'config.json') -Destination (Join-Path $DataDir 'config.json') -Force }
    Write-CodexRuntimeJson (Join-Path $DataDir 'desktop\deployment.json') @{ version = 1; state = 'active'; productRoot = $ProductRoot; backup = $backup; installedAt = [DateTime]::UtcNow.ToString('o') }
    Write-MigrationStatus 'migrating' 'starting_new' '正在启动新的共享后台和飞书服务。'
    & (Join-Path $PSScriptRoot 'desktop-register.ps1') -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir
    & (Join-Path $PSScriptRoot 'desktop-start.ps1') -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $ready = $false
    do {
        Write-MigrationStatus 'migrating' 'verifying' '正在验证新后台连接，最长等待 90 秒。'
        try {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:18792/status' -TimeoutSec 3
            if ($status.runtime.state -eq 'ready' -and $status.bridge.state -eq 'ready') { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw '90 秒内新后台未就绪，将恢复旧服务。' }
    $manifest.status = 'complete'; Write-CodexRuntimeJson (Join-Path $backup 'manifest.json') $manifest
    $completed = $true
    Write-MigrationStatus 'succeeded' 'complete' '接管完成。工作台即将打开；之后可点击“打开 Codex”启动共享模式。'
    Write-Host ''
    Write-Host '接管完成。请返回 Feishu Codex 工作台，点击“打开 Codex”。' -ForegroundColor Green
    Write-Host '旧图标：独立 Codex。新图标：飞书工作台，关闭窗口后留在托盘。'
    Write-Host '两个旧的登录自启任务已禁用。新后台仅随新应用启动。'
    Write-Host '如需回退：运行此目录中的 desktop-rollback.ps1，并填写上面的备份路径。'
} catch {
    $failureMessage = $_.Exception.Message
    $failurePhase = $script:MigrationPhase
    Write-Host ("接管未完成：" + $failureMessage) -ForegroundColor Red
    if ($changed -and $backup) {
        $rollbackAttempted = $true
        try {
            Write-MigrationStatus 'migrating' 'rolling_back' '接管没有完成，正在恢复旧服务配置。'
            & (Join-Path $PSScriptRoot 'desktop-rollback.ps1') -BackupDir $backup -NonInteractive
            $rollbackCompleted = $true
            Write-Host '已恢复旧服务配置。' -ForegroundColor Yellow
        }
        catch { $rollbackError = $_.Exception.Message; Write-Host ("自动回退未完成，请保留备份并查看日志：" + $rollbackError) -ForegroundColor Red }
    }
    $suffix = if (-not $changed) { ' 尚未更改现有服务。' } elseif ($rollbackCompleted) { ' 已恢复旧服务配置。' } else { ' 自动回退未完成，请查看日志和回退备份。' }
    try { Write-MigrationStatus $(if ($requiresElevation -and -not $changed) { 'requires_elevation' } else { 'failed' }) $failurePhase ($failureMessage + $suffix) } catch { Write-Error ('无法写入接管状态：' + $_.Exception.Message) -ErrorAction Continue }
    if (-not $NonInteractive) { [void](Read-Host '按回车结束') }
    exit 1
} finally {
    if ($ownsMigrationMutex -and $migrationMutex) { $migrationMutex.ReleaseMutex() }
    if ($migrationMutex) { $migrationMutex.Dispose() }
}
if ($completed -and -not $NonInteractive) { [void](Read-Host '现在可以关闭此窗口，按回车结束') }
exit 0
