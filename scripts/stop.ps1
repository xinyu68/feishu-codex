param([int]$Port = 8790, [string]$DataDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$entryPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\server.js'
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { Write-Output 'Feishu Codex is already stopped.'; return }
Assert-FeishuCodexProcess $listener.OwningProcess (Get-FeishuCodexDataRoot $DataDir) $entryPath
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
if ($health.name -ne 'feishu-codex') { throw 'Refusing to stop a different service.' }
$state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -ContentType 'application/json' -Headers @{'X-Bridge-Token'=$state.csrfToken} -Body '{}' -TimeoutSec 10 | Out-Null
for ($attempt=0; $attempt -lt 60; $attempt++) {
  if (-not (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue)) { Write-Output 'Feishu Codex stopped. Shared Codex, if running, was left untouched.'; return }
  Start-Sleep -Milliseconds 500
}
throw 'Graceful shutdown has not completed after 30 seconds; the process was not forcefully terminated.'
