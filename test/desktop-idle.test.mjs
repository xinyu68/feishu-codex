import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-idle-probe-'));
  await fs.mkdir(path.join(directory, 'scripts')); await fs.mkdir(path.join(directory, 'desktop'));
  await fs.copyFile(path.join(root, 'scripts', 'desktop-idle.mjs'), path.join(directory, 'scripts', 'desktop-idle.mjs'));
  return directory;
}
function run(directory, url = 'ws://127.0.0.1:18791') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(directory, 'scripts', 'desktop-idle.mjs'), url], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('exit', code => {
      try { resolve({ code, stderr, result: JSON.parse(stdout) }); } catch (error) { reject(error); }
    });
  });
}

test('idle probe reports missing packaged ws dependency as JSON instead of an uncaught import error', async () => {
  const directory = await fixture();
  for (const file of ['host.mjs', 'windows.mjs', 'lifecycle.mjs']) await fs.copyFile(path.join(root, 'desktop', file), path.join(directory, 'desktop', file));
  const { code, stderr, result } = await run(directory);
  assert.equal(code, 1); assert.equal(stderr, ''); assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ERR_MODULE_NOT_FOUND'); assert.equal(result.error.stage, 'load');
  assert.match(result.error.message, /ws/); assert.match(result.error.message, /安装文件/);
  assert.equal(Object.hasOwn(result.error, 'stack'), false);
});

test('idle probe preserves protocol failure reason without a stack or RPC payload', async () => {
  const directory = await fixture();
  await fs.writeFile(path.join(directory, 'desktop', 'host.mjs'), 'export async function runtimeProbe() { throw new Error("共享后台拒绝状态查询。"); }');
  const { code, result } = await run(directory);
  assert.equal(code, 1); assert.equal(result.error.stage, 'probe'); assert.equal(result.error.message, '共享后台拒绝状态查询。');
});

test('idle probe keeps active exit code and rejects invalid task counts', async () => {
  const directory = await fixture();
  await fs.writeFile(path.join(directory, 'desktop', 'host.mjs'), 'export async function runtimeProbe() { return {active: 2}; }');
  const active = await run(directory); assert.equal(active.code, 2); assert.deepEqual(active.result, { ok: true, activeCount: 2 });
  await fs.writeFile(path.join(directory, 'desktop', 'host.mjs'), 'export async function runtimeProbe() { return {}; }');
  const invalid = await run(directory); assert.equal(invalid.code, 1); assert.equal(invalid.result.ok, false);
});
