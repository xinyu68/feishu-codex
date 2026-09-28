import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRuntimeConfig } from '../src/runtime-config.js';

test('shared runtime survives manual startup and invalid config never falls back to a writer process', t => {
  const inheritedUrl = process.env.FEISHU_CODEX_WS_URL;
  delete process.env.FEISHU_CODEX_WS_URL;
  t.after(() => { if (inheritedUrl === undefined) delete process.env.FEISHU_CODEX_WS_URL; else process.env.FEISHU_CODEX_WS_URL = inheritedUrl; });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'runtime.json');
  assert.equal(readRuntimeConfig(directory).mode, 'per-turn');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ mode: 'shared', wsUrl: 'ws://127.0.0.1:18791' }));
  assert.deepEqual(readRuntimeConfig(directory), { mode: 'shared', websocketUrl: 'ws://127.0.0.1:18791/' });
  fs.writeFileSync(file, '{incomplete');
  assert.throws(() => readRuntimeConfig(directory), /不会自动退回/);
  fs.writeFileSync(file, JSON.stringify({ mode: 'shared' }));
  assert.throws(() => readRuntimeConfig(directory), /缺少连接地址/);
  fs.writeFileSync(file, JSON.stringify({ mode: 'per-turn' }));
  assert.equal(readRuntimeConfig(directory).mode, 'per-turn');
  assert.equal(readRuntimeConfig(directory, 'ws://127.0.0.1:18791').mode, 'shared');
  for (const url of ['', 'ws://example.com:18791', 'ws://0.0.0.0:18791', 'http://127.0.0.1:18791', 'ws://user:secret@127.0.0.1:18791', 'ws://127.0.0.1:18791/path', 'ws://127.0.0.1']) {
    assert.throws(() => readRuntimeConfig(directory, url));
  }
});
