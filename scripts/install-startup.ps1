param([string]$DataDir, [int]$Port = 8790)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$scriptPath = Join-Path $PSScriptRoot 'start.ps1'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Port $Port -DataDir `"$dataRoot`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Feishu Codex' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the local Feishu Codex conversation bridge after user sign-in.' -Force | Out-Null
Write-Output 'Feishu Codex will start after Windows sign-in.'
