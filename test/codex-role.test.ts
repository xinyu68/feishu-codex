import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/codex.js';

test('standalone start and resume apply explicit roles without overriding unconfigured native instructions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-codex-role-'));
  const client = new CodexClient({
    command: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)), 'early', directory] },
    codexHome: directory, requestTimeoutMs: 15_000, idleTimeoutMs: 30_000,
  });
  try {
    const first = await client.run({ cwd: directory, prompt: 'first', roleInstructions: '角色：产品经理', model: 'model-one' });
    const next = await client.run({ cwd: directory, threadId: first.threadId, prompt: 'next', roleInstructions: '角色：测试，验证验收标准', model: 'model-two' });
    const native = await client.run({ cwd: directory, threadId: 'native-existing', prompt: 'native continuation' });
    assert.equal(first.threadId, next.threadId);
    assert.equal(native.threadId, 'native-existing');
    const traces = (await readdir(directory)).filter(name => name.startsWith('trace-'));
    const rows = (await Promise.all(traces.map(file => readFile(path.join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
    const created = rows.find(row => row.method === 'thread/start');
    assert.match(created.params.developerInstructions, /角色：产品经理/);
    assert.equal(created.params.model, 'model-one');
    const updated = rows.find(row => row.method === 'thread/resume' && row.params.threadId === first.threadId);
    assert.match(updated.params.developerInstructions, /角色：测试，验证验收标准/);
    assert.doesNotMatch(updated.params.developerInstructions, /产品经理/);
    assert.equal(updated.params.model, 'model-two');
    assert.equal(Object.hasOwn(rows.find(row => row.method === 'thread/resume' && row.params.threadId === 'native-existing').params, 'developerInstructions'), false);
  } finally {
    await client.close();
    assert.equal((await readdir(directory)).filter(name => name.startsWith('owned-')).length, 0);
    await rm(directory, { recursive: true, force: true });
  }
});
