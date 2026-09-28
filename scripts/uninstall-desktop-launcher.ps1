param([string]$DataDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$metadataPath = Join-Path $dataRoot 'desktop-launcher\install.json'
if (-not (Test-Path -LiteralPath $metadataPath)) { Write-Output 'No shared desktop entry point is installed for this data directory.'; return }
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($metadata.userEnvironment) {
  $backup = $metadata.userEnvironment
  $current = [Environment]::GetEnvironmentVariable($backup.name, [EnvironmentVariableTarget]::User)
  if ($current -ne $backup.installedValue) {
    Write-Warning 'The user WebSocket setting was modified after installation and was retained.'
  } else {
    if ($backup.existed) {
      [Environment]::SetEnvironmentVariable($backup.name, [string]$backup.value, [EnvironmentVariableTarget]::User)
      $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
      try { $environmentKey.SetValue($backup.name, [string]$backup.value, [Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind], $backup.kind))) } finally { $environmentKey.Dispose() }
    } else { [Environment]::SetEnvironmentVariable($backup.name, $null, [EnvironmentVariableTarget]::User) }
    $metadata.userEnvironment = $null
  }
}
$remaining = @()
foreach ($shortcut in $metadata.shortcuts) {
  if ((Test-Path -LiteralPath $shortcut.path) -and (!$shortcut.installedHash -or (Get-FileHash -LiteralPath $shortcut.path -Algorithm SHA256).Hash -ne $shortcut.installedHash)) {
    Write-Warning "Shortcut was modified; it was retained: $($shortcut.path)"
    $remaining += $shortcut
    continue
  }
  if ($shortcut.backupPath -and (Test-Path -LiteralPath $shortcut.backupPath)) { Copy-Item -LiteralPath $shortcut.backupPath -Destination $shortcut.path -Force }
  elseif (Test-Path -LiteralPath $shortcut.path) { Remove-Item -LiteralPath $shortcut.path -Force }
}
$metadata.shortcuts = $remaining
if ($metadata.task) {
  $existing = Get-ScheduledTask -TaskName $metadata.task.name -ErrorAction SilentlyContinue
  if ($existing -and (@($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ine $metadata.task.execute -or $existing.Actions[0].Arguments -ne $metadata.task.arguments)) {
    Write-Warning 'The startup task was modified and was retained.'
  } else {
    if ($metadata.task.backupPath -and (Test-Path -LiteralPath $metadata.task.backupPath)) {
      Register-ScheduledTask -TaskName $metadata.task.name -Xml ([System.IO.File]::ReadAllText($metadata.task.backupPath)) -Force | Out-Null
    } elseif ($existing) { Unregister-ScheduledTask -TaskName $metadata.task.name -Confirm:$false }
    $metadata.task = $null
  }
}
if ($metadata.shortcuts.Count -or $metadata.task -or $metadata.userEnvironment) { Write-CodexRuntimeJson $metadataPath $metadata }
else { Move-Item -LiteralPath $metadataPath -Destination (Join-Path (Split-Path $metadataPath -Parent) ('uninstalled-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.json')) }
Write-Output 'Shared desktop entry points and any installer-managed user WebSocket setting were restored or removed. Running processes, machine environment and HERMES settings were left unchanged.'
