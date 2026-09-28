function Get-DesktopMigrationPreflight {
    param([string]$ProductRoot, [string]$NodePath, [string]$DataDir, [string]$OldRoot, [string]$BaselinePath, [string]$ExpectedUserSid)
    $checks = [Collections.Generic.List[object]]::new()
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $userSid = $identity.User.Value
    $activeCount = 0
    $nativeDesktopRunning = $false
    $runtime = $null
    $wsUrl = $null
    $uri = $null
    function Add-PreflightCheck([string]$Id, [string]$Status, [string]$Message, $Details = $null) {
        [void]$checks.Add([pscustomobject]@{ id = $Id; status = $Status; message = $Message; details = $Details })
    }
    function Add-UnreadableIdentity([string]$Id, [string]$Label, [int]$ProcessNumber) {
        $status = if ($elevated) { 'blocked' } else { 'requires_elevation' }
        Add-PreflightCheck $Id $status ($Label + '（PID ' + $ProcessNumber + '）的完整进程身份不可读；需要同一 Windows 用户的一次管理员授权，不能仅凭 PID 接管。') @{ pid = $ProcessNumber }
    }
    function Read-PreflightIdentity([int]$ProcessNumber) {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessNumber" -ErrorAction Stop
        if (-not $candidate) { return $null }
        $resolvedPath = [string]$candidate.ExecutablePath
        if (-not $resolvedPath -and $candidate.CreationDate) {
            try {
                $handle = Get-Process -Id $ProcessNumber -ErrorAction Stop
                $ticks = $handle.StartTime.ToUniversalTime().Ticks
                if (($ticks - ($ticks % 10)) -eq $candidate.CreationDate.ToUniversalTime().Ticks) { $resolvedPath = [string]$handle.Path }
            } catch { }
        }
        return [pscustomobject]@{ pid = $ProcessNumber; name = [string]$candidate.Name; exe = $resolvedPath; commandLine = [string]$candidate.CommandLine; startedAt = $(if ($candidate.CreationDate) { $candidate.CreationDate.ToUniversalTime().ToString('o') } else { '' }) }
    }
    function Test-PreflightEntry([string]$CommandLine, [string]$Entry) {
        return $CommandLine -match ('(?:^|\s)"?' + [regex]::Escape($Entry) + '(?:"|\s|$)')
    }
    function Get-PreflightSummary {
        return [pscustomobject]@{
            version = 1; checkOnly = $true; changed = $false; elevated = [bool]$elevated; userSid = $userSid
            requiresElevation = @($checks | Where-Object { $_.status -eq 'requires_elevation' }).Count -gt 0
            blocked = @($checks | Where-Object { $_.status -eq 'blocked' }).Count -gt 0
            nativeDesktopRunning = [bool]$nativeDesktopRunning; activeCount = [int]$activeCount
            baselinePath = $BaselinePath; checks = $checks.ToArray(); checkedAt = [DateTime]::UtcNow.ToString('o')
        }
    }

    if ($ExpectedUserSid -and $ExpectedUserSid -ne $userSid) {
        Add-PreflightCheck 'windows_user' 'blocked' '管理员授权使用了另一个 Windows 账号。请使用当前登录账号授权，避免修改错误的用户配置。'
        return Get-PreflightSummary
    }
    Add-PreflightCheck 'windows_user' 'pass' 'Windows 用户身份已确认。' @{ sid = $userSid; elevated = $elevated }
    $required = @(
        (Join-Path $ProductRoot 'build\server\server.js'), (Join-Path $ProductRoot 'build\ui\index.html'), (Join-Path $ProductRoot 'desktop\host.mjs'),
        (Join-Path $ProductRoot 'scripts\desktop-idle.mjs'), (Join-Path $ProductRoot 'scripts\desktop-register.ps1'), (Join-Path $ProductRoot 'scripts\desktop-start.ps1'), (Join-Path $ProductRoot 'scripts\desktop-start.vbs'), (Join-Path $ProductRoot 'scripts\desktop-task-security.ps1'),
        (Join-Path $ProductRoot 'scripts\desktop-host.ps1'), (Join-Path $ProductRoot 'scripts\desktop-host.vbs'), (Join-Path $ProductRoot 'scripts\desktop-stop-owned.ps1'), (Join-Path $ProductRoot 'scripts\desktop-rollback.ps1'),
        (Join-Path $ProductRoot 'scripts\launch-packaged-probe.ps1'), (Join-Path $ProductRoot 'scripts\launch-packaged-shared.ps1'), (Join-Path $ProductRoot 'scripts\launch-packaged-shared.vbs'), $NodePath,
        (Join-Path $OldRoot 'dist\server.js'), (Join-Path $OldRoot 'scripts\stop.ps1'), (Join-Path $OldRoot 'scripts\shared-codex.ps1')
    )
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
    if ($missing.Count) { Add-PreflightCheck 'source_files' 'blocked' '安装文件或旧服务文件不完整。' @{ missing = $missing } }
    else { Add-PreflightCheck 'source_files' 'pass' '新旧启动文件和回退工具均存在。' }

    try {
        if (-not $BaselinePath) {
            foreach ($directory in @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'desktop-baseline') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
                $infoFile = Join-Path $directory.FullName 'baseline-info.json'
                if (-not (Test-Path -LiteralPath $infoFile -PathType Leaf)) { continue }
                $info = [IO.File]::ReadAllText($infoFile) | ConvertFrom-Json
                if ($info.sourceRoot -ieq $OldRoot -and $info.version -eq '0.1.0') { $BaselinePath = $directory.FullName; break }
            }
        }
        if (-not $BaselinePath -or -not (Test-Path -LiteralPath (Join-Path $BaselinePath 'dist\server.js') -PathType Leaf)) { Add-PreflightCheck 'baseline' 'blocked' '未找到开发前的旧版部署备份，请指定已验证的 BaselinePath。' }
        else { Add-PreflightCheck 'baseline' 'pass' '旧版部署回退基线已找到。' @{ path = $BaselinePath } }
    } catch { Add-PreflightCheck 'baseline' 'blocked' ('无法读取旧版部署备份：' + $_.Exception.Message) }

    try {
        $runtime = Read-CodexRuntimeConfig $DataDir
        $wsUrl = if ($runtime.wsUrl) { [string]$runtime.wsUrl } else { 'ws://127.0.0.1:18791' }
        $uri = Get-CodexWebSocketUri $wsUrl
        $nativePath = Resolve-SharedCodexPath $runtime.codexPath
        $mcpPath = Resolve-CodexMcpNodePath $runtime.mcpNodePath
        Add-PreflightCheck 'runtime_config' 'pass' '共享后台配置和原生运行文件可用。' @{ port = $uri.Port; nativePath = $nativePath; mcpNodePath = $mcpPath }
    } catch { Add-PreflightCheck 'runtime_config' 'blocked' ('无法确认共享后台配置：' + $_.Exception.Message) }
    try {
        $machineValue = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Machine')
        $userEnvironment = Get-DesktopEnvironmentBackup
        if ($machineValue) { Add-PreflightCheck 'environment' 'blocked' '系统级共享地址由其他配置管理，不会更改它。' }
        elseif ($userEnvironment.exists -and $userEnvironment.value -and $wsUrl -and ([string]$userEnvironment.value).TrimEnd('/') -ne $wsUrl.TrimEnd('/')) { Add-PreflightCheck 'environment' 'blocked' '用户级共享地址不属于当前项目，不会更改它。' }
        else { Add-PreflightCheck 'environment' 'pass' '用户环境归属已确认，系统级配置无需修改。' }
    } catch { Add-PreflightCheck 'environment' 'blocked' ('无法读取用户环境：' + $_.Exception.Message) }

    try {
        foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop)) {
            $processInfo = Read-PreflightIdentity ([int]$candidate.ProcessId)
            if (-not $processInfo.exe -or -not $processInfo.commandLine) {
                $nativeDesktopRunning = $true
                Add-UnreadableIdentity 'desktop_identity' 'Codex 桌面' ([int]$candidate.ProcessId)
            } elseif ($processInfo.exe -match '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$' -and $processInfo.commandLine -notmatch '(?i)(?:^|\s|"|\x27)--type(?:=|\s)') { $nativeDesktopRunning = $true }
        }
        if ($nativeDesktopRunning) { Add-PreflightCheck 'desktop_closed' 'waiting' '官方 Codex 仍在运行；只读预检可继续，正式接管前需要完整退出。' }
        else { Add-PreflightCheck 'desktop_closed' 'pass' '官方 Codex 已退出。' }
    } catch { Add-PreflightCheck 'desktop_closed' 'blocked' ('无法确认桌面状态：' + $_.Exception.Message) }

    try {
        $listeners = @(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count) {
            $listener = $listeners[0]
            $processInfo = Read-PreflightIdentity ([int]$listener.OwningProcess)
            $lockPath = Join-Path $DataDir 'service.lock'
            if (@($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $listener.OwningProcess }).Count) { Add-PreflightCheck 'bridge_identity' 'blocked' '8790 端口不完全属于预期的本机回环监听。' }
            elseif (-not $processInfo) { Add-PreflightCheck 'bridge_identity' 'blocked' '旧飞书进程在查询期间退出，请重新预检。' }
            elseif (-not $processInfo.exe -or -not $processInfo.commandLine -or -not $processInfo.startedAt) { Add-UnreadableIdentity 'bridge_identity' '旧飞书服务' $processInfo.pid }
            elseif ($processInfo.name -ine 'node.exe' -or -not (Test-PreflightEntry $processInfo.commandLine (Join-Path $OldRoot 'dist\server.js'))) { Add-PreflightCheck 'bridge_identity' 'blocked' '8790 监听进程的程序或命令行与旧飞书服务不匹配。' }
            elseif (-not (Test-Path -LiteralPath $lockPath) -or [int]([IO.File]::ReadAllText($lockPath).Trim()) -ne $processInfo.pid) { Add-PreflightCheck 'bridge_identity' 'blocked' '旧飞书服务的数据目录锁不匹配。' }
            else {
                Add-PreflightCheck 'bridge_identity' 'pass' '旧飞书服务完整身份、命令行、端口和目录锁均已核验。' @{ pid = $processInfo.pid; startedAt = $processInfo.startedAt; executablePath = $processInfo.exe }
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/health' -TimeoutSec 5
                if ($health.name -ne 'feishu-codex') { Add-PreflightCheck 'bridge_health' 'blocked' '旧服务健康响应不匹配。' }
                else {
                    $state = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/state' -TimeoutSec 5
                    $busyCount = @($state.conversations | Where-Object { $_.busy -or $_.active }).Count
                    if ($state.activeWork -and $busyCount -eq 0) { $busyCount = 1 }
                    $activeCount = [Math]::Max($activeCount, $busyCount)
                    if ($busyCount -or @($state.pendingRequests).Count) { Add-PreflightCheck 'bridge_idle' 'waiting' '飞书还有正在处理的任务；会在正式切换前重新检查。' }
                    else { Add-PreflightCheck 'bridge_idle' 'pass' '旧飞书服务当前空闲。' }
                }
            }
        } else { Add-PreflightCheck 'bridge_identity' 'pass' '旧飞书服务未运行，无需停止。' }
    } catch { Add-PreflightCheck 'bridge_identity' 'blocked' ('旧飞书服务预检失败：' + $_.Exception.Message) }

    if ($wsUrl -and $uri) {
        try {
            $listeners = @(Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction SilentlyContinue)
            if ($listeners.Count) {
                $listener = $listeners[0]
                $metadataFile = Join-Path $DataDir 'shared-codex.pid.json'
                $metadata = if (Test-Path -LiteralPath $metadataFile) { [IO.File]::ReadAllText($metadataFile) | ConvertFrom-Json } else { $null }
                $processInfo = Read-PreflightIdentity ([int]$listener.OwningProcess)
                if (@($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $listener.OwningProcess }).Count) { Add-PreflightCheck 'shared_identity' 'blocked' '共享端口不完全属于预期的本机回环监听。' }
                elseif (-not $metadata -or $metadata.processId -ne $listener.OwningProcess -or $metadata.wsUrl.TrimEnd('/') -ne $wsUrl.TrimEnd('/')) { Add-PreflightCheck 'shared_identity' 'blocked' '共享后台监听与原启动记录不匹配。' }
                elseif (-not $processInfo) { Add-PreflightCheck 'shared_identity' 'blocked' '共享后台在查询期间退出，请重新预检。' }
                elseif (-not $processInfo.exe -or -not $processInfo.commandLine -or -not $processInfo.startedAt) { Add-UnreadableIdentity 'shared_identity' '旧共享后台' $processInfo.pid }
                elseif ($processInfo.name -ine 'codex.exe' -or $processInfo.exe -ine $metadata.executablePath -or [DateTimeOffset]::Parse($processInfo.startedAt).UtcDateTime.Ticks -ne [DateTimeOffset]::Parse($metadata.startedAt).UtcDateTime.Ticks -or $processInfo.commandLine -notmatch '\bapp-server\b' -or $processInfo.commandLine -notmatch ('--listen\s+"?' + [regex]::Escape($wsUrl) + '(?:"|\s|$)')) { Add-PreflightCheck 'shared_identity' 'blocked' '共享后台的创建时间、程序或监听参数与原启动记录不匹配。' }
                else {
                    Add-PreflightCheck 'shared_identity' 'pass' '旧共享后台完整身份及端口归属已核验。' @{ pid = $processInfo.pid; startedAt = $processInfo.startedAt; executablePath = $processInfo.exe }
                    $idleScript = Join-Path $ProductRoot 'scripts\desktop-idle.mjs'
                    if ((Test-Path -LiteralPath $idleScript) -and (Test-Path -LiteralPath $NodePath)) {
                        $idleJson = & $NodePath $idleScript $wsUrl
                        $probeExitCode = $LASTEXITCODE
                        $idle = $idleJson | ConvertFrom-Json
                        if ($idle.ok -and $probeExitCode -in @(0, 2)) {
                            $activeCount = [Math]::Max($activeCount, [int]$idle.activeCount)
                            if ($idle.activeCount -gt 0) { Add-PreflightCheck 'shared_idle' 'waiting' '共享后台还有任务运行；只读预检可继续，切换前需要结束任务。' @{ activeCount = [int]$idle.activeCount } }
                            else { Add-PreflightCheck 'shared_idle' 'pass' '共享后台连续两次只读检查均为空闲。' }
                        } else {
                            $reason = if ($idle.error.message) { [string]$idle.error.message } else { '状态检查没有返回有效结果。' }
                            if ($reason.Length -gt 700) { $reason = $reason.Substring(0, 700) }
                            Add-PreflightCheck 'shared_idle' 'blocked' ('无法确认共享后台任务状态（退出码 ' + $probeExitCode + '）：' + $reason + ' 未执行任何停止操作。') @{ exitCode = $probeExitCode; errorCode = [string]$idle.error.code; stage = [string]$idle.error.stage }
                        }
                    }
                }
            } else { Add-PreflightCheck 'shared_identity' 'pass' '旧共享后台未运行，无需停止。' }
        } catch { Add-PreflightCheck 'shared_identity' 'blocked' ('共享后台预检失败：' + $_.Exception.Message) }
    }

    try {
        $metadataFile = Join-Path $DataDir 'desktop-tools-relay.pid.json'
        if (Test-Path -LiteralPath $metadataFile) {
            $metadata = [IO.File]::ReadAllText($metadataFile) | ConvertFrom-Json
            $processInfo = Read-PreflightIdentity ([int]$metadata.processId)
            if (-not $processInfo) { Add-PreflightCheck 'relay_identity' 'pass' '旧桌面工具转接进程未运行。' }
            elseif (-not $processInfo.exe -or -not $processInfo.commandLine -or -not $processInfo.startedAt) { Add-UnreadableIdentity 'relay_identity' '旧桌面工具转接进程' $processInfo.pid }
            elseif ($processInfo.name -ine 'node.exe' -or $processInfo.exe -ine $metadata.executablePath -or [DateTimeOffset]::Parse($processInfo.startedAt).UtcDateTime.Ticks -ne [DateTimeOffset]::Parse($metadata.startedAt).UtcDateTime.Ticks -or -not (Test-PreflightEntry $processInfo.commandLine (Join-Path $OldRoot 'dist\desktop-tools-relay.js')) -or -not $metadata.pipe -or $processInfo.commandLine -notmatch ('--pipe\s+"?' + [regex]::Escape([string]$metadata.pipe) + '(?:"|\s|$)') -or ($runtime.desktopToolsPipe -and $metadata.pipe -ne $runtime.desktopToolsPipe)) { Add-PreflightCheck 'relay_identity' 'blocked' '桌面工具转接进程的完整身份或管道参数不匹配。' }
            else { Add-PreflightCheck 'relay_identity' 'pass' '旧桌面工具转接进程已提前核验，切换前不会遗漏此检查。' @{ pid = $processInfo.pid; startedAt = $processInfo.startedAt; executablePath = $processInfo.exe } }
        } else { Add-PreflightCheck 'relay_identity' 'pass' '没有旧桌面工具转接启动记录。' }
    } catch { Add-PreflightCheck 'relay_identity' 'blocked' ('桌面工具转接预检失败：' + $_.Exception.Message) }

    foreach ($spec in @(@{ name = 'Feishu Codex'; entry = 'scripts\start.ps1' }, @{ name = 'Feishu Codex Shared Runtime'; entry = 'scripts\codex-service.ps1' })) {
        try {
            $task = Get-ScheduledTask -TaskName $spec.name -ErrorAction Stop
            $expected = Join-Path $OldRoot $spec.entry
            if (@($task.Actions).Count -ne 1 -or -not (Test-PreflightEntry $task.Actions[0].Arguments $expected)) { Add-PreflightCheck ('task:' + $spec.name) 'blocked' '同名旧计划任务指向其他程序，不会修改它。' @{ name = $spec.name } }
            else {
                [void](Export-ScheduledTask -TaskName $spec.name -ErrorAction Stop)
                Add-PreflightCheck ('task:' + $spec.name) 'pass' '旧计划任务定义可读，启动文件归属已确认。' @{ name = $spec.name; runLevel = [string]$task.Principal.RunLevel; enabled = [bool]$task.Settings.Enabled }
            }
        } catch {
            if ($_.FullyQualifiedErrorId -match 'CmdletizationQuery_NotFound') { Add-PreflightCheck ('task:' + $spec.name) 'pass' '没有该旧计划任务，无需禁用。' }
            else { Add-PreflightCheck ('task:' + $spec.name) $(if ($elevated) { 'blocked' } else { 'requires_elevation' }) ('无法读取旧计划任务，可能需要一次管理员授权：' + $_.Exception.Message) }
        }
    }
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort 18792 -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count) { Add-PreflightCheck 'host_port' 'blocked' '新后台端口 18792 已被占用，请先在工作台安全退出已有后台。' }
        else { Add-PreflightCheck 'host_port' 'pass' '新后台端口 18792 空闲。' }
    } catch { Add-PreflightCheck 'host_port' 'blocked' ('无法检查新后台端口：' + $_.Exception.Message) }
    return Get-PreflightSummary
}
