import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { powershell } from '../desktop/windows.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture({ helpers = false, preflight = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-migration-test-'));
  const scripts = path.join(directory, 'scripts'), dataDir = path.join(directory, 'data');
  await fs.mkdir(scripts);
  await fs.copyFile(path.join(root, 'scripts', 'desktop-migrate.ps1'), path.join(scripts, 'desktop-migrate.ps1'));
  if (helpers) {
    await fs.writeFile(path.join(scripts, 'shared-codex.ps1'), '\uFEFFfunction Get-CodexDesktopProcesses { if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "desktop-present")) { [pscustomobject]@{ ProcessId = 1 } } }\n', 'utf8');
    await fs.writeFile(path.join(scripts, 'desktop-migration-common.ps1'), '\uFEFF# No real system helpers in this preflight-only fixture.\n', 'utf8');
    await fs.writeFile(path.join(scripts, 'desktop-preflight.ps1'), '\uFEFFfunction Get-DesktopMigrationPreflight { ' +
      `[pscustomobject]@{ requiresElevation = $${Boolean(preflight.requiresElevation)}; blocked = $${Boolean(preflight.blocked)}; nativeDesktopRunning = $false; activeCount = 0; changed = $false; checks = @(); baselinePath = $null } }\n` +
      'function Write-CodexRuntimeJson($File, $Value) { [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false)) }\n', 'utf8');
    await fs.writeFile(path.join(scripts, 'desktop-present'), 'present');
    for (const file of ['build/server/server.js', 'build/ui/index.html', 'desktop/host.mjs', 'dist/server.js']) {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, file), '// fixture only');
    }
  }
  const statusFile = path.join(dataDir, 'desktop', 'migration-status.json');
  return { directory, dataDir, scripts, statusFile,
    async status() { return JSON.parse(await fs.readFile(statusFile, 'utf8')); },
    spawn(runId, extra = []) {
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'desktop-migrate.ps1'),
        '-ProductRoot', directory, '-OldRoot', directory, '-NodePath', process.execPath, '-DataDir', dataDir, '-StatusFile', statusFile, '-RunId', runId, '-NonInteractive', ...extra],
      { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })); });
      return { child, result };
    },
  };
}

async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await pause(100); } while (Date.now() < deadline);
  assert.fail('Timed out waiting for the isolated migration status');
}

test('migration reports an early missing helper failure without an interactive console', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const fx = await fixture(); const runId = randomUUID(); const run = fx.spawn(runId);
  try {
    const result = await run.result;
    assert.equal(result.code, 1);
    const status = await fx.status();
    assert.equal(status.runId, runId); assert.equal(status.status, 'failed'); assert.equal(status.state, 'failed'); assert.equal(status.phase, 'preflight'); assert.equal(status.changed, false);
    assert.ok(status.pid > 0); assert.ok(Date.parse(status.startedAt)); assert.ok(Date.parse(status.updatedAt));
    assert.match(status.message, /shared-codex\.ps1/);
    assert.match(await fs.readFile(path.join(fx.dataDir, 'desktop', 'migration-details.log'), 'utf8'), /failed\/preflight/);
    assert.equal(await fs.stat(path.join(fx.dataDir, 'config.json')).then(() => true, () => false), false);
  } finally { if (run.child.exitCode === null) run.child.kill(); }
});

test('migration publishes waiting state, rejects concurrent runs, and resumes preflight after desktop exits', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const fx = await fixture({ helpers: true }); const runId = randomUUID();
  const run = fx.spawn(runId, ['-WaitForDesktopExit', '-DesktopWaitSeconds', '10']);
  let second;
  try {
    await until(async () => (await fx.status().catch(() => null))?.state === 'waiting_for_codex');
    const waiting = await fx.status();
    const diagnostics = JSON.parse(await fs.readFile(path.join(fx.dataDir, 'desktop', 'migration-preflight.json'), 'utf8'));
    assert.equal(diagnostics.runId, runId); assert.equal(diagnostics.pid, waiting.pid); assert.equal(diagnostics.changed, false);
    assert.equal(waiting.runId, runId); assert.equal(waiting.changed, false); assert.match(waiting.message, /保留 Feishu Codex/);
    assert.equal(await fs.stat(path.join(fx.dataDir, 'desktop', 'deployment.json')).then(() => true, () => false), false);
    second = fx.spawn(randomUUID(), ['-WaitForDesktopExit', '-DesktopWaitSeconds', '10']);
    const duplicate = await second.result;
    assert.equal(duplicate.code, 1); assert.match(duplicate.stdout + duplicate.stderr, /另一个接管程序/);
    assert.equal((await fx.status()).runId, runId, 'another run must not overwrite the active progress file');
    await fs.unlink(path.join(fx.scripts, 'desktop-present'));
    const result = await run.result;
    assert.equal(result.code, 1);
    const final = await fx.status();
    assert.equal(final.state, 'failed'); assert.equal(final.changed, false); assert.match(final.message, /旧版部署备份/);
    const log = await fs.readFile(path.join(fx.dataDir, 'desktop', 'migration-details.log'), 'utf8');
    assert.match(log, /waiting_for_codex/); assert.match(log, /Codex 桌面已退出/);
  } finally {
    if (run.child.exitCode === null) run.child.kill();
    if (second && second.child.exitCode === null) second.child.kill();
  }
});

test('migration waiting timeout reports failure without changing configuration', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const fx = await fixture({ helpers: true }); const run = fx.spawn(randomUUID(), ['-WaitForDesktopExit', '-DesktopWaitSeconds', '1']);
  try {
    assert.equal((await run.result).code, 1);
    const final = await fx.status(); assert.equal(final.state, 'failed'); assert.equal(final.changed, false); assert.match(final.message, /超时/);
  } finally { if (run.child.exitCode === null) run.child.kill(); }
});

for (const scenario of [{ requiresElevation: true, status: 'requires_elevation' }, { blocked: true, status: 'failed' }]) {
  test(`CheckOnly reports ${scenario.status} with exit zero and leaves actual migration status untouched`, { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
    const fx = await fixture({ helpers: true, preflight: scenario });
    const preflightFile = path.join(fx.dataDir, 'preflight.json');
    const run = fx.spawn(randomUUID(), ['-CheckOnly', '-PreflightFile', preflightFile]);
    assert.equal((await run.result).code, 0);
    const report = JSON.parse(await fs.readFile(preflightFile, 'utf8'));
    assert.equal(report.status, scenario.status); assert.equal(report.changed, false);
    assert.equal(await fs.stat(fx.statusFile).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(fx.dataDir, 'desktop', 'deployment.json')).then(() => true, () => false), false);
  });
}

test('migration rejects an elevation under a different user before preflight or mutation', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const fx = await fixture({ helpers: true });
  const run = fx.spawn(randomUUID(), ['-ExpectedUserSid', 'S-1-5-21-999-999-999-999']);
  assert.equal((await run.result).code, 1);
  const result = await fx.status(); assert.equal(result.status, 'failed'); assert.equal(result.changed, false);
  assert.match(result.message, /Windows/);
});
