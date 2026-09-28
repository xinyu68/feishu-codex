param(
  [ValidateSet('per-turn', 'shared')][string]$Mode,
  [string]$DataDir,
  [string]$WsUrl = 'ws://127.0.0.1:18791',
  [string]$CodexPath,
  [string]$DesktopPath,
  [string]$DesktopToolsPipe,
  [string]$McpNodePath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
if (-not $Mode) { throw 'Choose -Mode shared or -Mode per-turn.' }
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$null = Get-CodexWebSocketUri $WsUrl
$config = @{ mode = $Mode; wsUrl = $WsUrl; codexPath = ''; desktopPath = '' }
if ($Mode -eq 'shared') {
  $config.codexPath = Resolve-SharedCodexPath $CodexPath
  $config.desktopPath = Resolve-CodexDesktopPath $DesktopPath
  if ($DesktopToolsPipe) { $config.desktopToolsPipe = $DesktopToolsPipe }
  if ($McpNodePath) {
    $config.mcpNodePath = Resolve-CodexMcpNodePath $McpNodePath
  }
}
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$runtimePath = Join-Path $dataRoot 'runtime.json'
if (Test-Path -LiteralPath $runtimePath) { Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $dataRoot 'runtime.previous.json') -Force }
Write-CodexRuntimeJson $runtimePath $config
Write-Output "Runtime mode saved: $Mode. Running services were not changed."
if ($Mode -eq 'shared') { Write-Output 'Restart the bridge, then fully quit Codex Desktop and use scripts/start-desktop.ps1 to attach it to the shared server.' }
