import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyDependencyTree } from '../scripts/verify-desktop-package.mjs';

test('packaging rejects missing transitive files even when direct dependencies are present', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-package-test-'));
  const expected = path.join(temp, 'expected'), actual = path.join(temp, 'actual');
  const files = ['ws/package.json', '@vendor/sdk/index.js', '@vendor/sdk/node_modules/helper/index.js'];
  try {
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(expected, file)), { recursive: true });
      await fs.writeFile(path.join(expected, file), `fixture ${file}`);
    }
    await fs.cp(expected, actual, { recursive: true });
    assert.equal(await verifyDependencyTree(expected, actual), 3);
    const nested = path.join(actual, files[2]);
    await fs.unlink(nested);
    await assert.rejects(verifyDependencyTree(expected, actual), /缺少运行依赖/);
    await fs.writeFile(nested, 'truncated');
    await assert.rejects(verifyDependencyTree(expected, actual), /内容不完整/);
  } finally {
    if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('feishu-package-test-')) throw new Error('Invalid cleanup directory');
    await fs.rm(temp, { recursive: true, force: true });
  }
});
