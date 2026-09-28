param(
    [Parameter(Mandatory=$true)][string]$ProductRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$DataDir,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

$ProductRoot = [IO.Path]::GetFullPath($ProductRoot)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DataDir = [IO.Path]::GetFullPath($DataDir)
foreach ($value in @($ProductRoot, $NodePath, $DataDir)) {
    if ($value.Contains('"') -or $value -match '[\r\n]') { throw '安装路径包含无效字符。' }
}

$required = @(
    (Join-Path $ProductRoot 'build\server\server.js'),
    (Join-Path $ProductRoot 'build\ui\index.html'),
    (Join-Path $ProductRoot 'desktop\host.mjs'),
    (Join-Path $ProductRoot 'scripts\desktop-host.vbs'),
    (Join-Path $ProductRoot 'scripts\desktop-start.ps1'),
    (Join-Path $ProductRoot 'scripts\desktop-register.ps1'),
    (Join-Path $ProductRoot 'scripts\desktop-task-security.ps1'),
    $NodePath
)
if (@($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count) {
    throw '安装文件不完整，请重新安装 Feishu Codex。'
}

if (Test-Path -LiteralPath (Join-Path $DataDir 'desktop\deployment.json')) {
    throw '此数据目录已有安装记录，请使用“重试连接”或现有接管入口。'
}
foreach ($name in @('config.json', 'state.json', 'runtime.json', 'desktop-baseline')) {
    if (Test-Path -LiteralPath (Join-Path $DataDir $name)) {
        throw '检测到已有飞书配置。全新设置不会覆盖现有数据，请先确认本机安装状态。'
    }
}

foreach ($name in @('Feishu Codex', 'Feishu Codex Shared Runtime')) {
    $legacyTask = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($legacyTask -and ($legacyTask.State -eq 'Running' -or $legacyTask.Settings.Enabled)) {
        throw '检测到已有飞书启动任务。全新设置不会覆盖它，请先确认本机安装状态。'
    }
}

$occupied = @(Get-NetTCPConnection -LocalPort 8790,18791,18792 -State Listen -ErrorAction SilentlyContinue)
if ($occupied.Count) {
    throw ('本机服务端口 ' + (($occupied | Select-Object -ExpandProperty LocalPort -Unique) -join '、') + ' 已占用。请先安全退出正在运行的服务，再重试。')
}

if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User') -or
    [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Machine')) {
    throw '检测到已设置的 Codex 共享地址。请先确认原有配置；全新设置不会改动它。'
}

$taskName = 'Feishu Codex Desktop Host'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$expectedEntry = Join-Path $ProductRoot 'scripts\desktop-host.vbs'
$expectedArguments = '//B //NoLogo "' + $expectedEntry + '" "' + $ProductRoot + '" "' + $NodePath + '" "' + $DataDir + '"'
$expectedExecutable = Join-Path $env:SystemRoot 'System32\wscript.exe'
if ($task) {
    $owner = [string]$task.Principal.UserId
    if ($owner -ne $currentUser.User.Value) {
        try { $owner = ([Security.Principal.NTAccount]::new($owner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { throw '后台启动项属于其他账号，未修改。' }
    }
    if (@($task.Actions).Count -ne 1 -or
        $task.Actions[0].Execute -ine $expectedExecutable -or
        $task.Actions[0].Arguments -ine $expectedArguments -or
        $owner -ne $currentUser.User.Value -or
        @($task.Triggers | Where-Object { $null -ne $_ }).Count -ne 0) {
        throw '同名后台任务已有其他配置，未覆盖它。请查看本机任务计划程序。'
    }
}

if ($CheckOnly) { Write-Output '全新设置检查通过。'; return }
if (-not $task) {
    & (Join-Path $PSScriptRoot 'desktop-register.ps1') -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir -NoReplace
} else {
    . (Join-Path $PSScriptRoot 'desktop-task-security.ps1')
    Grant-DesktopTaskUserAccess -TaskName $taskName -UserSid $currentUser.User.Value
}
Write-Output '本机后台已准备好。'
