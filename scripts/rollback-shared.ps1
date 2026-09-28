param([string]$DataDir, [int]$Port = 8790, [switch]$RestartBridge, [switch]$KeepLaunchers)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$dataRoot = Get-FeishuCodexDataRoot $DataDir
& (Join-Path $PSScriptRoot 'configure-runtime.ps1') -Mode per-turn -DataDir $dataRoot
if (-not $KeepLaunchers) { & (Join-Path $PSScriptRoot 'uninstall-desktop-launcher.ps1') -DataDir $dataRoot }
if ($RestartBridge) {
  & (Join-Path $PSScriptRoot 'stop.ps1') -Port $Port -DataDir $dataRoot
  & (Join-Path $PSScriptRoot 'start.ps1') -Port $Port -DataDir $dataRoot
}
Write-Output 'Per-turn bridge mode restored. Shared Codex was retained so an attached desktop is not interrupted.'
Write-Output 'To restore the desktop too, fully quit Codex Desktop, then run scripts/start-desktop.ps1 -OriginalMode.'
