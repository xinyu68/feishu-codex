import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeBundles } from '../desktop/runtime-bundle.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-runtime-bundle-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('feishu-runtime-bundle-')); await fs.rm(directory, { recursive: true, force: true }); });
  const dataDir = path.join(directory, 'data'), source = path.join(directory, 'official');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'codex.exe'), 'MZ cli version one');
  await fs.writeFile(path.join(source, 'codex-code-mode-host.exe'), 'MZ tools version one');
  await fs.writeFile(path.join(source, 'codex-command-runner.exe'), 'MZ runner');
  return { directory, dataDir, source, cli: path.join(source, 'codex.exe'), bundles: new RuntimeBundles(dataDir) };
}

test('a pinned complete runtime survives official cache cleanup and is reused by a new host', async t => {
  const f = await fixture(t), first = await f.bundles.prepare(f.cli);
  const again = await new RuntimeBundles(f.dataDir).prepare(f.cli);
  assert.equal(again.exe, first.exe);
  await fs.unlink(f.cli); await fs.unlink(path.join(f.source, 'codex-code-mode-host.exe'));
  assert.match(await fs.readFile(first.exe, 'utf8'), /version one/);
  assert.match(await fs.readFile(path.join(first.directory, 'codex-code-mode-host.exe'), 'utf8'), /version one/);
});

test('incomplete and non-executable tool sets are never published or selected', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'codex-code-mode-host.exe'), '');
  await assert.rejects(f.bundles.prepare(f.cli), /尚未准备完整/);
  await fs.writeFile(path.join(f.source, 'codex-code-mode-host.exe'), 'html download failure');
  await assert.rejects(f.bundles.prepare(f.cli), /尚未准备完整/);
  assert.equal((await fs.readdir(f.bundles.base).catch(() => [])).length, 0);
});

test('a source changed while being copied is rejected and staging files are removed', async t => {
  const f = await fixture(t);
  const bundles = new RuntimeBundles(f.dataDir, { copyFile: async (input, output) => {
    await fs.copyFile(input, output);
    if (path.basename(input) === 'codex.exe') await fs.writeFile(input, 'MZ cli replaced during copy with different length');
  } });
  await assert.rejects(bundles.prepare(f.cli), /正在变化/);
  assert.deepEqual(await fs.readdir(bundles.base), []);
});

test('cache corruption creates a new immutable directory and concurrent preparation coalesces', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.bundles.prepare(f.cli), f.bundles.prepare(f.cli)]);
  assert.equal(a.exe, b.exe);
  await fs.writeFile(path.join(a.directory, 'codex-code-mode-host.exe'), 'MZ corrupt cache bytes');
  const replacement = await f.bundles.prepare(f.cli);
  assert.notEqual(replacement.exe, a.exe);
  assert.match(await fs.readFile(path.join(replacement.directory, 'codex-code-mode-host.exe'), 'utf8'), /version one/);
  assert.match(await fs.readFile(path.join(a.directory, 'codex-code-mode-host.exe'), 'utf8'), /corrupt/);
});

test('cache pruning keeps active versions and never removes an unowned neighboring folder', async t => {
  const f = await fixture(t), versions = [];
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(f.cli, `MZ cli version ${i} ${'x'.repeat(i)}`);
    versions.push(await f.bundles.prepare(f.cli)); await new Promise(resolve => setTimeout(resolve, 15));
  }
  const neighbor = path.join(f.bundles.base, 'user-files'); await fs.mkdir(neighbor); await fs.writeFile(path.join(neighbor, 'keep.txt'), 'keep');
  await f.bundles.prune([versions[0].exe]);
  assert.equal((await fs.stat(versions[0].exe)).isFile(), true);
  await f.bundles.prune([versions[2].exe]);
  await assert.rejects(fs.stat(versions[0].exe), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(neighbor, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(f.bundles.removeDirectory(f.directory), /Unsafe/);
});
