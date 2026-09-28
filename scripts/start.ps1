param([int]$Port = 8790, [string]$DataDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$projectRoot = Split-Path $PSScriptRoot -Parent
$dataRoot = Get-FeishuCodexDataRoot $DataDir
$entryPath = Join-Path $projectRoot 'dist\server.js'
if (-not (Test-Path -LiteralPath $entryPath)) { throw 'Run npm install and npm run build first.' }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Assert-FeishuCodexProcess $listener.OwningProcess $dataRoot $entryPath
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
  if ($health.name -ne 'feishu-codex') { throw "Port $Port belongs to another service." }
  Write-Output "Feishu Codex already running at http://127.0.0.1:$Port"
  return
}
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$runtime = Read-CodexRuntimeConfig $dataRoot
$shared = if ($runtime.mode -eq 'shared') { Start-SharedCodex $dataRoot $runtime } else { $null }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$previousDataDir = $env:FEISHU_CODEX_DATA_DIR
$previousPort = $env:FEISHU_CODEX_PORT
$previousWs = $env:FEISHU_CODEX_WS_URL
try {
  $env:FEISHU_CODEX_DATA_DIR = $dataRoot
  $env:FEISHU_CODEX_PORT = [string]$Port
  if ($shared) { $env:FEISHU_CODEX_WS_URL = $shared.wsUrl } else { Remove-Item Env:FEISHU_CODEX_WS_URL -ErrorAction SilentlyContinue }
  $process = Start-Process -FilePath $node -ArgumentList (ConvertTo-CodexNativeArgument $entryPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'service.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'service.stderr.log') -PassThru
} finally {
  if ($null -eq $previousDataDir) { Remove-Item Env:FEISHU_CODEX_DATA_DIR -ErrorAction SilentlyContinue } else { $env:FEISHU_CODEX_DATA_DIR = $previousDataDir }
  if ($null -eq $previousPort) { Remove-Item Env:FEISHU_CODEX_PORT -ErrorAction SilentlyContinue } else { $env:FEISHU_CODEX_PORT = $previousPort }
  if ($null -eq $previousWs) { Remove-Item Env:FEISHU_CODEX_WS_URL -ErrorAction SilentlyContinue } else { $env:FEISHU_CODEX_WS_URL = $previousWs }
}
$process.Id | Set-Content -LiteralPath (Join-Path $dataRoot 'launcher.pid')
for ($attempt=0; $attempt -lt 30; $attempt++) {
  $process.Refresh()
  if ($process.HasExited) { throw "Startup failed. See $dataRoot\service.stderr.log" }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
    if ($health.name -eq 'feishu-codex') { Write-Output "Feishu Codex started (PID $($process.Id)): http://127.0.0.1:$Port"; return }
  } catch { }
  Start-Sleep -Milliseconds 500
}
throw "Startup did not report ready. See $dataRoot\service.stderr.log"
