import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MigrationRunner } from '../desktop/migration.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('migration launcher reports PowerShell parse errors and preserves the failure through polling', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-migration-runner-'));
  const productRoot = path.join(directory, 'product with spaces');
  const dataDir = path.join(directory, 'data');
  await fs.mkdir(path.join(productRoot, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(productRoot, 'scripts', 'desktop-migration-launch.ps1'), '\ufeff$broken = (\n');
  const runner = new MigrationRunner({ productRoot, dataDir });
  try {
    const result = await runner.start(process.execPath);
    assert.equal(result.ok, true);
    const runId = runner.state.runId;
    await runner.start(process.execPath);
    assert.equal(runner.state.runId, runId, 'a repeated click cannot spawn a second migration');
    const deadline = Date.now() + 12_000;
    while (runner.child && Date.now() < deadline) await wait(100);
    assert.equal(runner.child, null);
    const state = await runner.refresh();
    assert.equal(state.status, 'failed');
    assert.match(state.message, /接管程序已退出/);
    assert.ok(state.exitCode !== 0);
    assert.match(await fs.readFile(runner.logFile, 'utf8'), /ParserError|Unexpected|Missing|缺少/);
    assert.equal((await runner.refresh()).status, 'failed');
    await assert.rejects(fs.access(path.join(dataDir, 'deployment.json')));
  } finally {
    if (runner.child) runner.child.kill();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('feishu-migration-runner-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
