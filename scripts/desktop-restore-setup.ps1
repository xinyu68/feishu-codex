param(
    [Parameter(Mandatory=$true)][string]$ProductRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$DataDir,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'desktop-process-tree.ps1')
$ProductRoot = [IO.Path]::GetFullPath($ProductRoot).TrimEnd('\')
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
foreach ($value in @($ProductRoot, $NodePath, $DataDir)) {
    if ($value.Contains('"') -or $value -match '[\r\n]') { throw '安装路径包含无效字符。' }
}
foreach ($file in @('build\server\server.js', 'build\ui\index.html', 'desktop\host.mjs', 'scripts\desktop-host.vbs', 'scripts\desktop-register.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProductRoot $file) -PathType Leaf)) { throw '安装文件不完整，请重新安装 Feishu Codex。' }
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '本机运行组件缺失，请重新安装。' }
$deploymentFile = Join-Path $DataDir 'desktop\deployment.json'
$deployment = if (Test-Path -LiteralPath $deploymentFile) { [IO.File]::ReadAllText($deploymentFile) | ConvertFrom-Json } else { $null }
if ($deployment -and ($deployment.state -ne 'active' -or -not $deployment.productRoot)) { throw '上次安装尚未完成，请查看本机日志后重试。' }
$oldRoot = if ($deployment) { [IO.Path]::GetFullPath($deployment.productRoot).TrimEnd('\') } else { $null }
$expectedExecutable = Join-Path $env:SystemRoot 'System32\wscript.exe'
$expectedArguments = '//B //NoLogo "' + (Join-Path $ProductRoot 'scripts\desktop-host.vbs') + '" "' + $ProductRoot + '" "' + $NodePath + '" "' + $DataDir + '"'
$task = Get-ScheduledTask -TaskName 'Feishu Codex Desktop Host' -TaskPath '\' -ErrorAction SilentlyContinue
$taskCurrent = $false
if ($task) {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $owner = [string]$task.Principal.UserId
    if ($owner -ne $current.User.Value) {
        try { $owner = ([Security.Principal.NTAccount]::new($owner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { throw '后台启动项属于其他账号，未修改。' }
    }
    if ($owner -ne $current.User.Value -or @($task.Actions).Count -ne 1 -or @($task.Triggers | Where-Object { $null -ne $_ }).Count) { throw '后台启动项不属于当前安装，未修改。' }
    $action = $task.Actions[0]
    $taskCurrent = $action.Execute -ieq $expectedExecutable -and $action.Arguments -ieq $expectedArguments -and $action.WorkingDirectory -ieq $ProductRoot
    if (-not $taskCurrent) {
        $oldPattern = if ($oldRoot) { '^//B //NoLogo "' + [regex]::Escape((Join-Path $oldRoot 'scripts\desktop-host.vbs')) + '" "' + [regex]::Escape($oldRoot) + '" "[^"\r\n]+" "' + [regex]::Escape($DataDir) + '"$' } else { '^$' }
        if ($action.Execute -ine $expectedExecutable -or $action.WorkingDirectory -ine $oldRoot -or $action.Arguments -notmatch $oldPattern) { throw '同名后台启动项指向其他应用，未覆盖。' }
        if ($task.State -eq 'Running') { throw '旧安装仍在运行，请先退出旧安装的全部服务，再点击恢复连接。' }
    }
}
# Reopening the same installation can reuse its existing running service.
if ($taskCurrent -and $task.State -eq 'Running' -and $oldRoot -ieq $ProductRoot) { Write-Output '当前服务已在运行。'; return }
foreach ($name in @('host', 'runtime', 'bridge', 'relay', 'desktop')) {
    $file = Join-Path $DataDir ('desktop\' + $name + '-identity.json')
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $identity = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($identity -and $identity.pid -gt 0 -and $identity.exe -and $identity.startedAt) {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$identity.pid)" -ErrorAction Stop
        if (Test-ProcessIdentity $identity $candidate) { throw '原来的服务或 Codex 仍在运行，请先退出原安装的全部服务，再点击恢复连接。' }
    }
}
if (@(Get-NetTCPConnection -LocalPort 8790,18791,18792 -State Listen -ErrorAction SilentlyContinue).Count) { throw '本机服务端口正在使用，请先退出原安装的全部服务，再点击恢复连接。' }
if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User') -or [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Machine')) { throw '检测到旧的 Codex 连接设置，请查看日志确认原安装状态。' }
if ($CheckOnly) { Write-Output '恢复检查通过。'; return }
& (Join-Path $PSScriptRoot 'desktop-register.ps1') -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir
Write-Output '已恢复本机启动项，原有配置保持不变。'
