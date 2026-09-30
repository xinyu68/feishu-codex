import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShell } from '../desktop/windows.mjs';

test('uninstall checks the recovered port and ignores only a recorded absent listener owner', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-uninstall-listeners-'));
  const script = path.join(directory, 'check.ps1');
  try {
    const source = await fs.readFile(path.join(root, 'scripts/desktop-uninstall.ps1'), 'utf8');
    const helper = source.slice(source.indexOf('function Get-BlockingServiceListeners {'), source.indexOf('function Find-OwnedTask {'));
    assert.ok(helper.includes('Get-CimInstance'));
    await fs.writeFile(script, '\uFEFF$ErrorActionPreference = "Stop"\n' + `
$DataDir = $PSScriptRoot
$script:live = $false
$script:failure = $false
$script:listeners = @()
function Read-State($Name) {
    if ($Name -eq 'runtime-endpoint-recovery') {
        return @{ previousUrl = 'ws://127.0.0.1:18791'; previousIdentity = @{ pid = 4242; exe = 'C:\\fixture\\codex.exe'; startedAt = '2026-10-01T00:00:00Z' } }
    }
    return $null
}
function Get-NetTCPConnection($LocalPort, $State) {
    if (64087 -notin $LocalPort) { throw 'Recovered port was not inspected' }
    return $script:listeners
}
function Get-CimInstance($Class, $Filter) {
    if ($script:failure) { throw 'Inspection unavailable' }
    if ($script:live) { return @{ ProcessId = 4242 } }
    return $null
}
[IO.File]::WriteAllText((Join-Path $DataDir 'runtime.json'), '{"wsUrl":"ws://127.0.0.1:64087","mode":"shared"}')
` + helper + `
$script:listeners = @(@{ LocalPort = 18791; LocalAddress = '127.0.0.1'; OwningProcess = 4242 })
if (@(Get-BlockingServiceListeners).Count -ne 0) { throw 'Confirmed absent old owner blocked cleanup' }
$script:live = $true
if (@(Get-BlockingServiceListeners).Count -ne 1) { throw 'Live or reused owner was ignored' }
$script:live = $false
$script:failure = $true
try { Get-BlockingServiceListeners | Out-Null; throw 'Inspection failure was ignored' } catch { if ($_.Exception.Message -ne 'Inspection unavailable') { throw } }
$script:failure = $false
foreach ($listener in @(
    @{ LocalPort = 64087; LocalAddress = '127.0.0.1'; OwningProcess = 4242 },
    @{ LocalPort = 18791; LocalAddress = '127.0.0.1'; OwningProcess = 9999 },
    @{ LocalPort = 18791; LocalAddress = '0.0.0.0'; OwningProcess = 4242 }
)) {
    $script:listeners = @($listener)
    if (@(Get-BlockingServiceListeners).Count -ne 1) { throw 'Unconfirmed listener was ignored' }
}
Write-Output 'passed'
`);
    assert.match(await runPowerShell(script, [], { timeout: 15_000 }), /passed/);
  } finally {
    await fs.unlink(script).catch(() => {});
    await fs.unlink(path.join(directory, 'runtime.json')).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
});
