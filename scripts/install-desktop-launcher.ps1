param([string]$DataDir, [string]$ShortcutDirectory, [switch]$SkipStartupTask, [switch]$SetUserEnvironment)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$runtime = Read-CodexRuntimeConfig $dataRoot
if ($runtime.mode -ne 'shared') { throw 'Configure shared mode before installing its desktop entry point.' }
$desktopPath = Resolve-CodexDesktopPath $runtime.desktopPath
$powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcherPath = Join-Path $PSScriptRoot 'start-desktop.ps1'
$servicePath = Join-Path $PSScriptRoot 'codex-service.ps1'
$installRoot = Join-Path $dataRoot 'desktop-launcher'
$metadataPath = Join-Path $installRoot 'install.json'
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
$metadata = if (Test-Path -LiteralPath $metadataPath) { Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ shortcuts = @(); task = $null } }
if ($SetUserEnvironment) {
  $variableName = 'CODEX_APP_SERVER_WS_URL'
  $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  try {
    $exists = $environmentKey -and $environmentKey.GetValueNames() -contains $variableName
    $value = if ($exists) { $environmentKey.GetValue($variableName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
    $kind = if ($exists) { $environmentKey.GetValueKind($variableName).ToString() } else { 'String' }
  } finally { if ($environmentKey) { $environmentKey.Dispose() } }
  if (-not $metadata.userEnvironment) {
    $metadata | Add-Member -NotePropertyName userEnvironment -NotePropertyValue ([pscustomobject]@{ name = $variableName; existed = [bool]$exists; value = $value; kind = $kind; installedValue = $runtime.wsUrl }) -Force
  } elseif ($value -ne $metadata.userEnvironment.installedValue) {
    throw 'The user WebSocket setting was modified after installation and was left unchanged.'
  }
  Write-CodexRuntimeJson $metadataPath $metadata
  [Environment]::SetEnvironmentVariable($variableName, $runtime.wsUrl, [EnvironmentVariableTarget]::User)
  $metadata.userEnvironment.installedValue = $runtime.wsUrl
  Write-CodexRuntimeJson $metadataPath $metadata
}
$directories = if ($ShortcutDirectory) { @([System.IO.Path]::GetFullPath($ShortcutDirectory)) } else { @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs')) }
$shortcutName = 'Codex 共享会话.lnk'
$shortcutArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`" -DataDir `"$dataRoot`" -Interactive"
$shell = New-Object -ComObject WScript.Shell
try {
  foreach ($directory in $directories) {
    if (-not $directory) { throw 'Unable to determine the user shortcut directory.' }
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $shortcutPath = Join-Path $directory $shortcutName
    $record = @($metadata.shortcuts | Where-Object { $_.path -ieq $shortcutPath }) | Select-Object -First 1
    if (-not $record) {
      $backupPath = $null
      if (Test-Path -LiteralPath $shortcutPath) {
        $backupPath = Join-Path $installRoot ('shortcut-' + [guid]::NewGuid().ToString('N') + '.lnk')
        Copy-Item -LiteralPath $shortcutPath -Destination $backupPath
      }
      $record = [pscustomobject]@{ path = $shortcutPath; backupPath = $backupPath; installedHash = '' }
      $metadata.shortcuts = @($metadata.shortcuts) + $record
    } elseif ((Test-Path -LiteralPath $shortcutPath) -and $record.installedHash -and (Get-FileHash -LiteralPath $shortcutPath -Algorithm SHA256).Hash -ne $record.installedHash) {
      throw "The shortcut was modified after installation and will not be overwritten: $shortcutPath"
    }
    Write-CodexRuntimeJson $metadataPath $metadata
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = $shortcutArguments
    $shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    $shortcut.Description = 'Open Codex Desktop using the same local runtime as Feishu Codex.'
    $shortcut.IconLocation = "$desktopPath,0"
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    $record.installedHash = (Get-FileHash -LiteralPath $shortcutPath -Algorithm SHA256).Hash
    Write-CodexRuntimeJson $metadataPath $metadata
  }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
if (-not $SkipStartupTask) {
  $taskName = 'Feishu Codex Shared Runtime'
  $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$servicePath`" -Action start -DataDir `"$dataRoot`""
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $metadata.task) {
    $backupPath = $null
    if ($existing) {
      $backupPath = Join-Path $installRoot 'previous-startup-task.xml'
      [System.IO.File]::WriteAllText($backupPath, (Export-ScheduledTask -InputObject $existing), [System.Text.UTF8Encoding]::new($false))
    }
    $metadata.task = [pscustomobject]@{ name = $taskName; backupPath = $backupPath; execute = $powershellPath; arguments = $arguments }
  } elseif ($existing -and (@($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ine $metadata.task.execute -or $existing.Actions[0].Arguments -ne $metadata.task.arguments)) {
    throw 'The shared runtime startup task was modified after installation; it was left unchanged.'
  }
  Write-CodexRuntimeJson $metadataPath $metadata
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the shared local Codex runtime and desktop-tools relay after sign-in. Does not receive Feishu messages.' -Force | Out-Null
  $metadata.task.execute = $powershellPath
  $metadata.task.arguments = $arguments
  Write-CodexRuntimeJson $metadataPath $metadata
}
Write-Output 'Installed Codex shared-session shortcuts. No process was started, and the original Codex shortcuts were not modified.'
if (-not $SkipStartupTask) { Write-Output 'Shared Codex runtime will start after Windows sign-in. The Feishu receiver remains managed by its existing startup task.' }
if ($SetUserEnvironment) {
  Write-Output 'Saved the shared endpoint in this Windows user environment; the previous value is backed up. Machine-wide settings and HERMES settings were not changed.'
  Write-Output 'Explorer may retain its current environment until the next Windows sign-in. Use the new shortcut for this session; after signing in again, the normal Codex entry point will inherit the shared endpoint.'
  $forceCli = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_FORCE_CLI', [EnvironmentVariableTarget]::User)
  if (-not $forceCli) { $forceCli = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_FORCE_CLI', [EnvironmentVariableTarget]::Machine) }
  if ($forceCli -and $forceCli -notin @('0', 'false', 'no')) { Write-Warning 'CODEX_APP_SERVER_FORCE_CLI is set by the user or machine and may override WebSocket mode. It was left unchanged.' }
} else { Write-Output 'No user or machine environment variables were changed; use the new shortcut to enter shared mode.' }
