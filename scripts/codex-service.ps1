param([ValidateSet('start', 'status')][string]$Action = 'status', [string]$DataDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$config = Read-CodexRuntimeConfig $dataRoot
if ($Action -eq 'start') {
  $service = Start-SharedCodex $dataRoot $config
  Write-Output "Shared Codex ready (PID $($service.processId)): $($service.wsUrl)"
  return
}
if ($config.mode -ne 'shared') { Write-Output 'Shared Codex is disabled in runtime.json.'; return }
$executable = Resolve-SharedCodexPath $config.codexPath
$owned = Get-OwnedSharedCodexProcess $dataRoot $config.wsUrl $executable
if (-not $owned) { Write-Output 'No shared Codex process owned by this data directory is running.'; return }
$healthy = Test-CodexWebSocket $config.wsUrl
Write-Output "Shared Codex PID $($owned.ProcessId); protocol ready: $healthy; endpoint: $($config.wsUrl)"
