import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureHermesMcp, HermesMcpError, type HermesMcpOptions } from '../src/hermes-mcp.js';

type Json = Record<string, any>;
const errorCode = (code: HermesMcpError['code']) => (error: unknown) => error instanceof HermesMcpError && error.code === code;
const merge = (target: Json, incoming: Json) => {
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key] ??= {}, value);
    else target[key] = value;
  }
};

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hermes-mcp-'));
  const scriptPath = path.join(directory, 'notify-mcp.js');
  await fs.writeFile(scriptPath, '// fixture: never executed\n');
  const config: Json = { model: 'existing-model', mcp_servers: { personal: { command: 'personal-mcp', env: { SECRET: 'unrelated-secret' } } } };
  const calls: { method: string; path: string; body?: Json }[] = [];
  let beforeRequest: ((method: string, route: string) => void) | undefined;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-hermes-session-token'], 'fixture-token');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const route = new URL(req.url!, 'http://127.0.0.1').pathname;
      calls.push({ method: req.method!, path: req.url!, ...(body ? { body } : {}) });
      beforeRequest?.(req.method!, route);
      let result: Json;
      if (req.method === 'GET' && route === '/api/mcp/servers') {
        result = { servers: Object.entries(config.mcp_servers).map(([name, entry]) => {
          const item = entry as Json;
          return { name, command: item.command, args: item.args ?? [], transport: item.url ? 'http' : 'stdio', url: item.url ?? null,
            auth: item.auth ?? null, enabled: item.enabled !== false, tools: item.tools ?? null,
            env: Object.fromEntries(Object.keys(item.env ?? {}).map(key => [key, '***'])) };
        }) };
      } else if (req.method === 'POST' && route === '/api/mcp/servers') {
        if (config.mcp_servers[body.name]) { res.writeHead(409).end(JSON.stringify({ detail: 'existing-entry-secret' })); return; }
        const { name, ...entry } = body;
        config.mcp_servers[name] = entry;
        result = { name, command: entry.command, args: entry.args, env: { FEISHU_CODEX_MANAGED_MCP: '***' } };
      } else if (req.method === 'GET' && route === '/api/config') result = config;
      else if (req.method === 'PUT' && route === '/api/config') { merge(config, body.config); result = { ok: true }; }
      else { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch { res.writeHead(500).end(JSON.stringify({ detail: 'fixture failure' })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('feishu-hermes-mcp-')) throw new Error('Invalid fixture cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const endpoint = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'fixture-token' };
  const install = (options: Partial<HermesMcpOptions> = {}) => ensureHermesMcp({ endpoint, command: process.execPath, scriptPath, ...options });
  return { directory, scriptPath, endpoint, config, calls, install, before: (hook: typeof beforeRequest) => { beforeRequest = hook; } };
}

test('creates through POST, uses Hermes mode, and leaves other settings intact', async t => {
  const fx = await fixture(t);
  const personal = structuredClone(fx.config.mcp_servers.personal);
  assert.deepEqual(await fx.install(), { changed: true, status: 'installed' });
  assert.deepEqual(fx.calls.map(call => [call.method, call.path]), [['GET', '/api/mcp/servers'], ['POST', '/api/mcp/servers']]);
  const entry = fx.config.mcp_servers.feishu_completion;
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args, [fx.scriptPath]);
  assert.equal(entry.env.FEISHU_CODEX_MANAGED_MCP, 'hermes-v1');
  assert.equal(entry.env.FEISHU_CODEX_MCP_MODE, 'hermes');
  assert.match(entry.env.FEISHU_CODEX_MANAGED_MCP_SHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fx.config.mcp_servers.personal, personal);
  assert.equal(fx.config.model, 'existing-model');
});

test('an unchanged entry does not write or reload despite masked list markers', async t => {
  const fx = await fixture(t);
  await fx.install();
  fx.calls.length = 0;
  assert.deepEqual(await fx.install(), { changed: false, status: 'unchanged' });
  assert.deepEqual(fx.calls.map(call => [call.method, call.path]), [['GET', '/api/mcp/servers'], ['GET', '/api/config']]);
});

test('updates only the owned item using config deep merge', async t => {
  const fx = await fixture(t);
  await fx.install();
  const personal = structuredClone(fx.config.mcp_servers.personal);
  const next = path.join(fx.directory, 'new-notify-mcp.js');
  await fs.writeFile(next, '// next package');
  fx.calls.length = 0;
  assert.deepEqual(await fx.install({ scriptPath: next }), { changed: true, status: 'updated' });
  const writes = fx.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.path, '/api/config');
  assert.deepEqual(Object.keys(writes[0]!.body!), ['config']);
  assert.deepEqual(Object.keys(writes[0]!.body!.config), ['mcp_servers']);
  assert.deepEqual(Object.keys(writes[0]!.body!.config.mcp_servers), ['feishu_completion']);
  assert.deepEqual(fx.config.mcp_servers.feishu_completion.args, [next]);
  assert.deepEqual(fx.config.mcp_servers.personal, personal);
  assert.equal(fx.config.model, 'existing-model');
  assert.deepEqual(await fx.install({ scriptPath: next }), { changed: false, status: 'unchanged' });
});

test('preserves a same-name user entry and never exposes its secrets in errors', async t => {
  const fx = await fixture(t);
  fx.config.mcp_servers.feishu_completion = { command: 'user-command', env: { API_KEY: 'user-secret' } };
  const original = structuredClone(fx.config);
  await assert.rejects(fx.install(), error => errorCode('conflict')(error) && !String(error).includes('user-secret'));
  assert.deepEqual(fx.config, original);
  assert.ok(fx.calls.every(call => call.method === 'GET'));
});

test('preserves every local change to a previously managed entry', async t => {
  const fx = await fixture(t);
  await fx.install();
  const original = structuredClone(fx.config.mcp_servers.feishu_completion);
  for (const edit of [
    (item: Json) => { item.command = 'user-command'; },
    (item: Json) => { item.args.push('--custom'); },
    (item: Json) => { item.env.FEISHU_CODEX_MCP_MODE = 'codex'; },
    (item: Json) => { item.env.SECRET = 'custom-secret'; },
    (item: Json) => { item.enabled = false; },
    (item: Json) => { item.tools = ['one']; },
    (item: Json) => { delete item.env.FEISHU_CODEX_MANAGED_MCP_SHA256; },
  ]) {
    fx.config.mcp_servers.feishu_completion = structuredClone(original);
    edit(fx.config.mcp_servers.feishu_completion);
    const changed = structuredClone(fx.config);
    fx.calls.length = 0;
    await assert.rejects(fx.install(), errorCode('modified'));
    assert.deepEqual(fx.config, changed);
    assert.ok(fx.calls.every(call => call.method === 'GET'));
  }
});

test('POST conflicts and edits before an update never overwrite a user entry', async t => {
  const fx = await fixture(t);
  fx.before((method, route) => { if (method === 'POST') fx.config.mcp_servers.feishu_completion = { command: 'concurrent-user-command' }; });
  await assert.rejects(fx.install(), errorCode('conflict'));
  assert.equal(fx.config.mcp_servers.feishu_completion.command, 'concurrent-user-command');
  fx.before(undefined);
  delete fx.config.mcp_servers.feishu_completion;
  await fx.install();
  const next = path.join(fx.directory, 'next.js');
  await fs.writeFile(next, '');
  let reads = 0;
  fx.calls.length = 0;
  fx.before((method, route) => { if (route === '/api/config' && method === 'GET' && ++reads === 2) fx.config.mcp_servers.feishu_completion.enabled = false; });
  await assert.rejects(fx.install({ scriptPath: next }), errorCode('modified'));
  assert.ok(fx.calls.every(call => call.method === 'GET'));
});

test('serializes concurrent installs and forwards a selected profile consistently', async t => {
  const fx = await fixture(t);
  const results = await Promise.all([fx.install({ profile: 'bridge role' }), fx.install({ profile: 'bridge role' })]);
  assert.deepEqual(results, [{ changed: true, status: 'installed' }, { changed: false, status: 'unchanged' }]);
  assert.equal(fx.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(fx.calls.every(call => call.path.endsWith('?profile=bridge%20role')));
});

test('rejects invalid executable/script paths before HTTP calls', async t => {
  const fx = await fixture(t);
  for (const options of [{ command: 'node' }, { command: path.join(fx.directory, 'electron.exe') },
    { command: path.join(fx.directory, 'node.exe') }, { scriptPath: 'notify-mcp.js' },
    { scriptPath: path.join(fx.directory, 'missing.js') }, { scriptPath: fx.directory }]) {
    await assert.rejects(fx.install(options), errorCode('invalid-runtime'));
  }
  assert.deepEqual(fx.calls, []);
});

test('supports injected fetch and strips transport/error-response secrets', async t => {
  const fx = await fixture(t);
  for (const fetcher of [
    async () => { throw new Error('fixture-token user-secret'); },
    async () => new Response('fixture-token user-secret', { status: 500 }),
    async () => new Response('fixture-token user-secret', { status: 200 }),
    async () => Response.json({ servers: 'invalid' }),
  ]) {
    await assert.rejects(fx.install({ fetch: fetcher as typeof fetch }), error => {
      assert.ok(error instanceof HermesMcpError);
      assert.doesNotMatch(String(error), /fixture-token|user-secret/);
      return true;
    });
  }
  assert.deepEqual(fx.calls, []);
});

test('uses the configured Node runtime and falls back to the Bridge Node for an empty override', async t => {
  const fx = await fixture(t);
  const previous = process.env.CODEX_MCP_NODE_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_MCP_NODE_PATH;
    else process.env.CODEX_MCP_NODE_PATH = previous;
  });
  process.env.CODEX_MCP_NODE_PATH = process.execPath;
  assert.equal((await fx.install({ command: undefined })).status, 'installed');
  assert.equal(fx.config.mcp_servers.feishu_completion.command, process.execPath);
  process.env.CODEX_MCP_NODE_PATH = '';
  assert.equal((await fx.install({ command: undefined })).status, 'unchanged');
  process.env.CODEX_MCP_NODE_PATH = path.join(fx.directory, 'missing', 'node.exe');
  await assert.rejects(fx.install({ command: undefined }), errorCode('invalid-runtime'));
  assert.equal((await fx.install({ command: process.execPath })).status, 'unchanged');
});
