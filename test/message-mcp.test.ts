import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { DefaultMessageSender } from '../src/message-sender.js';
import { sendMessageToFeishu } from '../src/message-client.js';
import { MESSAGE_CONNECTION_PATH, MESSAGE_SEND_PATH } from '../src/message-request.js';
import { conversationKey } from '../src/routing.js';
import type { CodexRuntime, FeishuSendOptions, FeishuTransport, MessageCard } from '../src/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = { chatId: conversationKey('notify', 'oc_private_b'), actorId: 'ou_b', botAppId: 'cli_notificationb' };
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'Expected operation did not finish');
}
async function fixture(t: test.TestContext, hermesBots = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-message-mcp-'));
  const seed = new Store(dir);
  seed.saveConfig({ appId: 'cli_chat_a', appSecret: 'a-secret', enabled: true, botName: '当前机器人', allowedActors: ['ou_a'], autoNotifyDesktop: false });
  seed.saveBot('notify', { appId: target.botAppId, appSecret: 'b-secret', enabled: true, name: '默认通知', allowedActors: ['ou_b'] });
  seed.conversation('oc_private_a', 'ou_a', dir, 'p2p').threadId = 'existing-a';
  seed.conversation(target.chatId, target.actorId, dir, 'p2p').threadId = 'existing-b';
  for (let index = 1; index <= hermesBots; index++) {
    seed.saveBot('hermes-' + index, { engine: 'hermes', appId: 'cli_hermes' + index, appSecret: 'hermes-secret', enabled: true, name: 'Hermes ' + index, allowedActors: ['ou_h' + index] });
    seed.conversation(conversationKey('hermes-' + index, 'oc_h' + index), 'ou_h' + index, dir, 'p2p').threadId = 'hermes:existing-' + index;
  }
  seed.saveConfig({ desktopNotificationTarget: target }); seed.save();
  const cards: Array<{ appId: string; chatId: string; card: MessageCard }> = [];
  let fail = false, hold: Promise<void> | undefined;
  const connected = new Set<string>();
  const runtime: CodexRuntime = {
    async run() { throw new Error('Messages must not start model work'); }, async stop() {}, async release() {}, async close() {},
    async models() { return []; }, async history() { return []; }, async status() { return { available: true }; },
  };
  const app = await startServer({ port: 0, dataDir: dir, codex: runtime, hermes: runtime,
    discovery: { projects: async () => [], threads: async () => [] },
    feishu: { createTransport(options) { return {
      async start() { connected.add(options.appId); options.onStatus('connected'); }, async close() {},
      async sendCard(chatId, card, publication) {
        await hold;
        if (publication?.canSend?.() === false || publication?.signal?.aborted) throw new Error('Destination became invalid');
        cards.push({ appId: options.appId, chatId, card });
        if (fail) throw new Error('Upstream secret b-secret must not escape');
        return `om_test_${cards.length}`;
      }, async sendText() { throw new Error('Expected a card'); }, async updateCard() {},
      async sendImage() { return ''; }, async sendFile() { return ''; }, async startTyping() { return async () => {}; },
    }; } },
  });
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('feishu-message-mcp-')); fs.rmSync(dir, { recursive: true, force: true }); });
  await until(() => connected.size === 2 + hermesBots);
  const base = `http://127.0.0.1:${app.port}`;
  const message = { text: '中文进度：调查已完成第一步。', title: '阶段结果', request_id: 'message-test-0001' };
  return { app, dir, base, cards, message, options: { port: app.port }, fail: () => { fail = true; }, hold: (promise: Promise<void>) => { hold = promise; } };
}

test('immediate MCP messages use the selected private bot even when auto notifications are off, without rebinding', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.app.store.state.conversations);
  const result = await sendMessageToFeishu(f.message, f.options);
  assert.equal(result.status, 'sent'); assert.equal(result.botName, '默认通知'); assert.equal(result.deduplicated, false);
  assert.deepEqual(f.cards, [{ appId: target.botAppId, chatId: 'oc_private_b', card: { title: f.message.title, text: f.message.text } }]);
  assert.deepEqual(f.app.store.state.conversations, before);
  assert.deepEqual(f.app.store.state.notifications, {});
  assert.equal(f.app.store.config.autoNotifyDesktop, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('concurrent duplicates wait for one send, survive process reload, and cannot change body or destination', async t => {
  const f = await fixture(t); let release!: () => void;
  f.hold(new Promise(resolve => { release = resolve; }));
  const first = sendMessageToFeishu(f.message, f.options);
  await until(() => Object.keys(f.app.store.state.messageSends).length === 1);
  const second = sendMessageToFeishu(f.message, f.options);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(f.cards.length, 1);
  assert.equal(results[0]!.messageId, results[1]!.messageId);
  assert.equal(results[1]!.deduplicated, true);
  await assert.rejects(sendMessageToFeishu({ ...f.message, text: 'different' }, f.options), /不同内容/);
  f.app.store.saveConfig({ desktopNotificationTarget: null });
  const reloaded = new DefaultMessageSender(new Store(f.dir), {} as FeishuTransport);
  assert.equal((await reloaded.send(f.message)).deduplicated, true);
  assert.equal(f.cards.length, 1);
});

test('missing, revoked, replaced and disconnected default targets fail without falling back to another bot', async t => {
  for (const kind of ['missing', 'revoked', 'replaced', 'disabled']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'missing') f.app.store.saveConfig({ desktopNotificationTarget: null });
    if (kind === 'revoked') f.app.store.saveBot('notify', { allowedActors: [] });
    if (kind === 'replaced') f.app.store.saveBot('notify', { appId: 'cli_replaced' });
    if (kind === 'disabled') f.app.store.saveBot('notify', { enabled: false });
    await assert.rejects(sendMessageToFeishu(f.message, f.options), /默认通知/);
    assert.equal(f.cards.length, 0); assert.equal(Object.keys(f.app.store.state.messageSends).length, 0);
  });
});

test('an uncertain send is never retried after an error or restart and does not expose upstream secrets', async t => {
  const f = await fixture(t); f.fail();
  await assert.rejects(sendMessageToFeishu(f.message, f.options), error => {
    assert.match(String(error), /未确认/); assert.doesNotMatch(String(error), /b-secret|Upstream/); return true;
  });
  await assert.rejects(sendMessageToFeishu(f.message, f.options), /阻止重复发送/);
  const store = new Store(f.dir);
  Object.values(store.state.messageSends)[0]!.status = 'sending'; store.save();
  const reloaded = new Store(f.dir);
  assert.equal(Object.values(reloaded.state.messageSends)[0]!.status, 'uncertain');
  await assert.rejects(new DefaultMessageSender(reloaded, {} as FeishuTransport).send(f.message), /阻止重复发送/);
  assert.equal(f.cards.length, 1);
});

test('a changed default before network dispatch invalidates the captured recipient, never redirects', async t => {
  const f = await fixture(t); let release!: () => void; f.hold(new Promise(resolve => { release = resolve; }));
  const result = sendMessageToFeishu(f.message, f.options);
  await until(() => Object.keys(f.app.store.state.messageSends).length === 1);
  f.app.store.saveConfig({ desktopNotificationTarget: { chatId: 'oc_private_a', actorId: 'ou_a', botAppId: 'cli_chat_a' } });
  release(); await assert.rejects(result, /未确认/); assert.equal(f.cards.length, 0);
});

test('MCP-only HTTP routes reject browsers, forged auth, arbitrary recipients and the UI token', async t => {
  const f = await fixture(t);
  const connection = await fetch(f.base + MESSAGE_CONNECTION_PATH).then(r => r.json()) as { token: string };
  const state = await fetch(f.base + '/api/state').then(r => r.json()) as { csrfToken: string };
  for (const headers of [{ Origin: f.base }, { 'Sec-Fetch-Site': 'same-origin' }]) {
    assert.equal((await fetch(f.base + MESSAGE_CONNECTION_PATH, { headers })).status, 403);
  }
  for (const token of ['', 'a'.repeat(64), state.csrfToken]) {
    assert.equal((await fetch(f.base + MESSAGE_SEND_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feishu-Mcp-Token': token }, body: JSON.stringify(f.message) })).status, 403);
  }
  const headers = { 'Content-Type': 'application/json', 'X-Feishu-Mcp-Token': connection.token };
  assert.equal((await fetch(f.base + MESSAGE_SEND_PATH, { method: 'POST', headers: { ...headers, Origin: f.base }, body: JSON.stringify(f.message) })).status, 403);
  assert.equal((await fetch(f.base + MESSAGE_SEND_PATH, { method: 'POST', headers, body: JSON.stringify({ ...f.message, chatId: 'oc_foreign' }) })).status, 400);
  assert.equal(f.cards.length, 0);
});

test('timeouts and shutdown promptly cancel pending publication and keep uncertain sends claimed', async t => {
  const f = await fixture(t); let publication: FeishuSendOptions | undefined;
  const sender = new DefaultMessageSender(f.app.store, { isAvailable: () => true, sendCard: async (_chat: string, _card: MessageCard, options?: FeishuSendOptions) => {
    publication = options; return new Promise<string>(() => {});
  } } as FeishuTransport, 50);
  const pending = sender.send(f.message);
  await assert.rejects(pending, /未确认/); assert.equal(publication?.signal?.aborted, true);
  await assert.rejects(sender.send(f.message), /阻止重复发送/);
  const next = sender.send({ ...f.message, request_id: 'message-test-0002' });
  const rejected = assert.rejects(next, /未确认/);
  await sender.close(); await rejected;
  assert.equal(publication?.canSend?.(), false);
});

test('both real MCP subprocesses immediately return acknowledged sends and report duplicate requests', async t => {
  const f = await fixture(t, 1);
  for (const mode of ['codex', 'hermes']) {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/notify-mcp.ts')], {
      env: { ...process.env, FEISHU_CODEX_MCP_MODE: mode, FEISHU_CODEX_PORT: String(f.app.port) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    const replies: any[] = [];
    createInterface({ input: child.stdout }).on('line', line => replies.push(JSON.parse(line)));
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    send({ id: 'list', method: 'tools/list' });
    send({ id: 'send', method: 'tools/call', params: { name: 'send_message_to_feishu', arguments: { ...f.message, request_id: `message-${mode}-0001` } } });
    await until(() => replies.length === 2);
    assert.ok(replies.find(r => r.id === 'list').result.tools.some((tool: any) => tool.name === 'send_message_to_feishu'));
    assert.equal(replies.find(r => r.id === 'send').result.structuredContent.status, 'sent');
    assert.equal(replies.find(r => r.id === 'send').result.isError, false);
    assert.equal(replies.find(r => r.id === 'send').result.structuredContent.botName, mode === 'hermes' ? 'Hermes 1' : '默认通知');
    send({ id: 'again', method: 'tools/call', params: { name: 'send_message_to_feishu', arguments: { ...f.message, request_id: `message-${mode}-0001` } } });
    await until(() => replies.length === 3);
    assert.equal(replies.find(r => r.id === 'again').result.structuredContent.deduplicated, true);
  }
  assert.equal(f.cards.length, 2);
});

test('invalid messages do not make network calls and connection redirects cannot receive a message', async t => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(302, { Location: 'http://localhost/foreign' }).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const options = { port: address.port };
  for (const text of ['', ' '.repeat(2), 'x'.repeat(6001)]) await assert.rejects(sendMessageToFeishu({ text, request_id: 'request-0001' }, options));
  await assert.rejects(sendMessageToFeishu({ text: 'hi', title: 'x'.repeat(81), request_id: 'request-0001' }, options));
  assert.equal(requests, 0);
  await assert.rejects(sendMessageToFeishu({ text: 'hi', request_id: 'request-0001' }, options), /消息未提交/);
  assert.equal(requests, 1);
});

test('Hermes notifications prefer their own bot without changing the global Codex default or bindings', async t => {
  const f = await fixture(t, 1);
  const before = structuredClone(f.app.store.state.conversations);
  const result = await sendMessageToFeishu(f.message, { ...f.options, engine: 'hermes' });
  assert.equal(result.botName, 'Hermes 1');
  assert.equal(f.cards[0]!.appId, 'cli_hermes1');
  assert.equal(f.cards[0]!.chatId, 'oc_h1');
  assert.deepEqual(f.app.store.config.desktopNotificationTarget, target);
  assert.deepEqual(f.app.store.state.conversations, before);
  const duplicate = await sendMessageToFeishu(f.message, f.options);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.botName, 'Hermes 1');
  assert.equal(f.cards.length, 1, 'changing the caller cannot repeat or redirect the same request');
});

test('Hermes uses its own explicit default among multiple bots, and never the Codex default', async t => {
  const f = await fixture(t, 2);
  const chosen = { chatId: conversationKey('hermes-2', 'oc_h2'), actorId: 'ou_h2', botAppId: 'cli_hermes2' };
  f.app.store.saveConfig({ hermesNotificationTarget: chosen });
  const result = await sendMessageToFeishu(f.message, { ...f.options, engine: 'hermes' });
  assert.equal(result.botName, 'Hermes 2');
  assert.equal(f.cards[0]!.appId, chosen.botAppId);
  assert.deepEqual(f.app.store.config.desktopNotificationTarget, target);
});

test('Hermes missing or explicitly cleared defaults never fall back to Codex', async t => {
  for (const count of [0, 1, 2]) {
    const f = await fixture(t, count);
    f.app.store.saveConfig({ hermesNotificationTarget: null });
    await assert.rejects(sendMessageToFeishu(f.message, { ...f.options, engine: 'hermes' }), /Hermes 默认通知/);
    assert.deepEqual(f.cards, []);
  }
  const f = await fixture(t, 1);
  f.app.store.saveConfig({ desktopNotificationTarget: null });
  assert.equal((await sendMessageToFeishu(f.message, { ...f.options, engine: 'hermes' })).botName, 'Hermes 1');
  await assert.rejects(sendMessageToFeishu({ ...f.message, request_id: 'another-0001' }, f.options), /Codex 默认通知/);
});

test('unavailable Hermes defaults fail without changing destination before or after claim', async t => {
  for (const change of ['disabled', 'revoked', 'group']) {
    const f = await fixture(t, 1);
    const id = conversationKey('hermes-1', 'oc_h1');
    if (change === 'disabled') f.app.store.saveBot('hermes-1', { enabled: false });
    if (change === 'revoked') f.app.store.saveBot('hermes-1', { allowedActors: [] });
    if (change === 'group') f.app.store.state.conversations[id]!.chatType = 'group';
    await assert.rejects(sendMessageToFeishu(f.message, { ...f.options, engine: 'hermes' }), /Hermes 默认通知/);
    assert.deepEqual(f.cards, []);
  }
  const f = await fixture(t, 1);
  let release!: () => void; f.hold(new Promise(resolve => { release = resolve; }));
  const sending = sendMessageToFeishu(f.message, { ...f.options, engine: 'hermes' });
  await until(() => Object.keys(f.app.store.state.messageSends).length === 1);
  f.app.store.saveBot('hermes-1', { allowedActors: [] });
  release();
  await assert.rejects(sending, /未确认/);
  assert.deepEqual(f.cards, [], 'a claimed Hermes message must never be rerouted to Codex');
});

test('management API validates each default against its own engine and saves both atomically', async t => {
  const f = await fixture(t, 2);
  const state = await fetch(f.base + '/api/state').then(r => r.json()) as any;
  assert.equal(state.notificationTargets.filter((item: any) => item.engine === 'hermes').length, 2);
  const chosen = { chatId: conversationKey('hermes-2', 'oc_h2'), actorId: 'ou_h2', botAppId: 'cli_hermes2' };
  const save = (body: unknown) => fetch(f.base + '/api/config', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': state.csrfToken }, body: JSON.stringify(body) });
  assert.equal((await save({ hermesNotificationTarget: chosen })).status, 200);
  assert.deepEqual(f.app.store.config.hermesNotificationTarget, chosen);
  for (const patch of [
    { hermesNotificationTarget: target },
    { desktopNotificationTarget: chosen },
    { desktopNotificationTarget: null, hermesNotificationTarget: { ...chosen, actorId: 'ou_unknown' } },
    { hermesNotificationTarget: { ...chosen, extra: true } },
  ]) {
    assert.equal((await save(patch)).status, 400);
    assert.deepEqual(f.app.store.config.desktopNotificationTarget, target);
    assert.deepEqual(f.app.store.config.hermesNotificationTarget, chosen);
  }
  assert.equal((await save({ desktopNotificationTarget: null })).status, 200);
  assert.deepEqual(f.app.store.config.hermesNotificationTarget, chosen);
  assert.equal((await save({ hermesNotificationTarget: null })).status, 200);
  assert.equal(new Store(f.app.store.dir).config.hermesNotificationTarget, null);
});

test('MCP source hints cannot inject an arbitrary recipient or an unsupported engine', async t => {
  const f = await fixture(t, 1);
  const { token } = await fetch(f.base + MESSAGE_CONNECTION_PATH).then(r => r.json()) as { token: string };
  const response = await fetch(f.base + MESSAGE_SEND_PATH, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feishu-Mcp-Token': token, 'X-Feishu-Mcp-Engine': 'other' },
    body: JSON.stringify(f.message) });
  assert.equal(response.status, 400);
  await assert.rejects(sendMessageToFeishu({ ...f.message, engine: 'hermes' }, f.options), /只接受/);
  assert.deepEqual(f.cards, []);
});