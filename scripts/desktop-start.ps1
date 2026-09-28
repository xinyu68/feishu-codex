param([Parameter(Mandatory=$true)][string]$ProductRoot, [Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$DataDir)
$ErrorActionPreference = 'Stop'
$deploymentFile = Join-Path $DataDir 'desktop\deployment.json'
if (-not (Test-Path -LiteralPath $deploymentFile)) { throw '尚未完成首次设置。' }
$deployment = [IO.File]::ReadAllText($deploymentFile) | ConvertFrom-Json
if ($deployment.state -ne 'active' -or $deployment.productRoot -ine $ProductRoot) { throw '当前安装目录与已设置目录不一致。' }
$task = Get-ScheduledTask -TaskName 'Feishu Codex Desktop Host' -ErrorAction SilentlyContinue
if (-not $task) { & (Join-Path $PSScriptRoot 'desktop-register.ps1') -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir; $task = Get-ScheduledTask -TaskName 'Feishu Codex Desktop Host' }
if (@($task.Triggers | Where-Object { $null -ne $_ }).Count -gt 0) { throw '后台任务含有意外的自动触发器，请检查本机后台任务。' }
$expected = Join-Path $ProductRoot 'scripts\desktop-host.vbs'
$expectedExecutable = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $expectedExecutable -or $task.Actions[0].Arguments -notlike ('*"' + $expected + '"*')) { throw '已有后台任务指向其他安装目录，请先完成版本切换。' }
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName 'Feishu Codex Desktop Host' }
Write-Output '已请求启动桌面后台。'
