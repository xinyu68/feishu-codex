param([Parameter(Mandatory=$true)][string]$ProductRoot, [Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$DataDir, [switch]$NoReplace)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop-task-security.ps1')
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
foreach ($value in @($ProductRoot, $NodePath, $DataDir)) { if ($value.Contains('"') -or $value -match '[\r\n]') { throw '路径包含无效字符。' } }
$entry = Join-Path $ProductRoot 'scripts\desktop-host.vbs'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '桌面版安装文件不完整。' }
$executable = Join-Path $env:SystemRoot 'System32\wscript.exe'
$arguments = '//B //NoLogo "' + $entry + '" "' + $ProductRoot + '" "' + $NodePath + '" "' + $DataDir + '"'
$action = New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $ProductRoot
$principal = New-ScheduledTaskPrincipal -UserId $currentUser.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# Deliberately no trigger: opening Feishu Codex is the only normal start action.
if ($NoReplace) {
    Register-ScheduledTask -TaskName 'Feishu Codex Desktop Host' -Action $action -Principal $principal -Settings $settings -Description '由 Feishu Codex 桌面应用按需启动；没有开机或登录触发器。' | Out-Null
} else {
    Register-ScheduledTask -TaskName 'Feishu Codex Desktop Host' -Action $action -Principal $principal -Settings $settings -Description '由 Feishu Codex 桌面应用按需启动；没有开机或登录触发器。' -Force | Out-Null
}
Grant-DesktopTaskUserAccess -TaskName 'Feishu Codex Desktop Host' -UserSid $currentUser.User.Value
Write-Output '已配置按需后台，不会开机自启。'
