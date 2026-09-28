import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { assertWriteAllowed, readDesktopRuntimeStatus } from '../src/write-gate.js';

test('managed write gate fails closed on missing, malformed and stale host status', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'host-state.json');
  assert.equal(readDesktopRuntimeStatus(file).canWrite, false);
  await assert.rejects(assertWriteAllowed(file), /尚未就绪/);
  fs.writeFileSync(file, '{bad');
  assert.equal(readDesktopRuntimeStatus(file).canWrite, false);
  fs.writeFileSync(file, JSON.stringify({ state: 'ready', canWrite: true, updatedAt: new Date(Date.now() - 20_000).toISOString() }));
  await assert.rejects(assertWriteAllowed(file), /连接已中断/);
  fs.writeFileSync(file, JSON.stringify({ state: 'ready', canWrite: true, updatedAt: 'not a date' }));
  assert.equal(readDesktopRuntimeStatus(file).canWrite, false);
});

test('write gate checks live native mode, validates host identity and never exposes capability token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-gate-'));
  const file = path.join(dir, 'host-state.json');
  const token = 'a'.repeat(64);
  let permit = false;
  let checks = 0;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, '/control');
    assert.equal(request.headers['x-host-token'], token);
    let text = '';
    for await (const chunk of request) text += chunk;
    assert.deepEqual(JSON.parse(text), { action: 'checkWrite' });
    checks++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ canWrite: permit, reason: '独立桌面正在运行' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address() as { port: number };
  const state = { pid: process.pid, state: 'ready', canWrite: true, updatedAt: new Date().toISOString(), token, arbitrarySecret: 'private' };
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'host-control.json'), JSON.stringify({ pid: process.pid, port: address.port, token }));
  assert.equal(JSON.stringify(readDesktopRuntimeStatus(file)).includes(token), false);
  assert.equal(JSON.stringify(readDesktopRuntimeStatus(file)).includes('private'), false);
  await assert.rejects(assertWriteAllowed(file), /独立桌面/);
  permit = true;
  await assertWriteAllowed(file);
  assert.equal(checks, 2);
  fs.writeFileSync(path.join(dir, 'host-control.json'), JSON.stringify({ pid: process.pid + 1, port: address.port, token }));
  await assert.rejects(assertWriteAllowed(file), /身份已变化/);
  assert.equal(checks, 2);
});

test('host redirects and malformed responses never authorize writes or forward the control token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-gate-'));
  const file = path.join(dir, 'host-state.json');
  let mode = 'redirect';
  let redirected = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/unexpected') { redirected = true; response.end('{}'); return; }
    if (mode === 'redirect') { response.writeHead(307, { Location: '/unexpected' }); response.end(); }
    else { response.setHeader('Content-Type', 'application/json'); response.end('null'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, state: 'ready', canWrite: true, updatedAt: new Date().toISOString() }));
  const controlFile = path.join(dir, 'host-control.json');
  fs.writeFileSync(controlFile, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token: 'b'.repeat(64) }));
  await assert.rejects(assertWriteAllowed(file), /无法确认/);
  assert.equal(redirected, false);
  mode = 'null';
  await assert.rejects(assertWriteAllowed(file), /无效状态/);
  fs.writeFileSync(controlFile, 'null');
  await assert.rejects(assertWriteAllowed(file), /身份已变化/);
});
