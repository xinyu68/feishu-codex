import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, powershell, readJson } from '../desktop/windows.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-atomic-json-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('feishu-atomic-json-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const file = path.join(directory, 'status.json');
  await atomicJson(file, { generation: 0 });
  return { directory, file };
}

async function lockDestination(directory, file) {
  const script = path.join(directory, 'hold-reader.ps1');
  await fs.writeFile(script, '\ufeff' + `param([string]$Target)
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally { $handle.Dispose() }
`);
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', file], {
    windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Reader did not acquire the test lock: ${stderr}`)); }, 8_000);
    child.stdout.on('data', data => {
      if (data.toString().includes('locked')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`Reader exited before lock: ${code} ${stderr}`)); });
  });
  let released = false;
  return async () => {
    if (!released) { released = true; child.stdin.end('\n'); }
    const [code] = await closed;
    assert.equal(code, 0, stderr);
  };
}

async function assertNoTemporaryFiles(directory) {
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
}

const windowsOnly = { skip: process.platform !== 'win32', timeout: 15_000 };

test('atomic JSON retries a real Windows reader lock and publishes after release', windowsOnly, async t => {
  const { directory, file } = await fixture(t);
  const release = await lockDestination(directory, file);
  const timer = setTimeout(() => { void release(); }, 250);
  try {
    await atomicJson(file, { generation: 1 });
    assert.deepEqual(await readJson(file), { generation: 1 });
    await assertNoTemporaryFiles(directory);
  } finally { clearTimeout(timer); await release(); }
});

test('atomic JSON rejects a sustained Windows lock without truncating the old file', windowsOnly, async t => {
  const { directory, file } = await fixture(t);
  const before = await fs.readFile(file, 'utf8');
  const release = await lockDestination(directory, file);
  try {
    const started = performance.now();
    await assert.rejects(atomicJson(file, { generation: 1 }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.ok(performance.now() - started >= 1_400, 'rename should retry for the bounded lock interval');
    assert.ok(performance.now() - started < 5_000, 'rename should not wait indefinitely');
    assert.equal(await fs.readFile(file, 'utf8'), before);
    await assertNoTemporaryFiles(directory);
  } finally { await release(); }
});

test('atomic JSON serializes concurrent submissions and captures each value at call time', windowsOnly, async t => {
  const { directory, file } = await fixture(t);
  const release = await lockDestination(directory, file);
  const latest = { generation: 3 };
  const writes = [atomicJson(file, { generation: 1 }), atomicJson(file, { generation: 2 }), atomicJson(file, latest)];
  latest.generation = 99;
  const timer = setTimeout(() => { void release(); }, 250);
  try {
    await Promise.all(writes);
    assert.deepEqual(await readJson(file), { generation: 3 });
    await assertNoTemporaryFiles(directory);
  } finally { clearTimeout(timer); await release(); }
});

test('atomic JSON can publish again after a prior locked publication failed', windowsOnly, async t => {
  const { directory, file } = await fixture(t);
  const release = await lockDestination(directory, file);
  try {
    await assert.rejects(atomicJson(file, { generation: 1 }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  } finally { await release(); }
  await atomicJson(file, { generation: 2 });
  assert.deepEqual(await readJson(file), { generation: 2 });
  await assertNoTemporaryFiles(directory);
});
