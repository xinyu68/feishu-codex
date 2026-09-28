param([string]$DataDir, [switch]$OriginalMode, [string]$DesktopPath, [switch]$Interactive)
$ErrorActionPreference = 'Stop'
try {
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$config = Read-CodexRuntimeConfig $dataRoot
$desktop = Resolve-CodexDesktopPath $(if ($DesktopPath) { $DesktopPath } else { $config.desktopPath })
$running = @(Get-CodexDesktopProcesses)
if ($running.Count -or (Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -ieq $desktop })) {
  throw 'Codex Desktop is already running. Fully quit it first, then run this launcher again. An existing single-instance app cannot inherit the new server setting.'
}
$previous = $env:CODEX_APP_SERVER_WS_URL
try {
  if (-not $OriginalMode -and $config.mode -eq 'shared') {
    if ($env:CODEX_APP_SERVER_FORCE_CLI -and $env:CODEX_APP_SERVER_FORCE_CLI -notin @('0', 'false', 'no')) { throw 'CODEX_APP_SERVER_FORCE_CLI is set in this environment and may override shared mode. It was not changed; resolve that explicit setting before using the shared launcher.' }
    $service = Start-SharedCodex $dataRoot $config
    $env:CODEX_APP_SERVER_WS_URL = $service.wsUrl
  } else { Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue }
  $process = Start-Process -FilePath $desktop -WorkingDirectory (Split-Path $desktop -Parent) -PassThru
  Write-Output "Codex Desktop launch requested (PID $($process.Id))."
} finally {
  if ($null -eq $previous) { Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue }
  else { $env:CODEX_APP_SERVER_WS_URL = $previous }
}
} catch {
  if ($Interactive) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex shared sessions', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
  throw
}
