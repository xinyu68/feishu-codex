import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { HermesClient } from '../src/hermes.js';
import type { CodexRuntime } from '../src/types.js';

async function setup(t: test.TestContext, available = true, options: { autoDiscover?: boolean; hermesConfig?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-runtime-http-'));
  const seed = new Store(dir);
  seed.saveConfig({ enabled: false, defaultWorkspace: dir, appId: 'cli_1234567890abcdef' });
  seed.saveBot('product', { name: '产品经理', appId: 'cli_abcdef1234567890', enabled: false });
  if (options.hermesConfig !== undefined) fs.writeFileSync(path.join(dir, 'hermes-runtime.json'), options.hermesConfig);
  const runtime: CodexRuntime = { async run() { throw new Error('unexpected run'); }, async stop() {}, async release() {}, async close() {},
    async models() { return []; }, async history() { return []; }, async status() { return { available: true }; } };
  const hermes: CodexRuntime = { ...runtime, async status() { return { available }; } };
  const verifications: string[] = [];
  const starts: string[] = [];
  const failApps = new Set<string>();
  const app = await startServer({ port: 0, dataDir: dir, codex: runtime, hermes: options.autoDiscover ? undefined : hermes,
    discovery: { async projects() { return []; }, async threads() { return []; } }, feishu: {
      async verifyCredentials(appId) { verifications.push(appId); },
      createTransport(value) {
        return { async start() { starts.push(value.appId); value.onStatus(failApps.has(value.appId) ? 'error' : 'connected'); },
          async close() { value.onStatus('stopped'); }, async sendText() { return 'om_test'; }, async sendCard() { return 'om_test'; },
          async updateCard() {}, async sendImage() { return 'om_test'; }, async sendFile() { return 'om_test'; }, async startTyping() { return async () => {}; } };
      },
    } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const state = await fetch(`${base}/api/state`).then(response => response.json()) as { csrfToken: string };
  const request = (url: string, value: unknown, method: string) => fetch(`${base}${url}`, { method, headers: {
    'Content-Type': 'application/json', 'X-Bridge-Token': state.csrfToken,
  }, body: JSON.stringify(value) });
  const patch = (value: unknown, botId = 'product') => request(`/api/bots/${botId}`, value, 'PATCH');
  const create = (value: unknown) => request('/api/bots', value, 'POST');
  return { app, base, patch, create, runtime, hermes, starts, verifications, failApps };
}

test('bot engine API validates and exposes Hermes health without changing developer', async t => {
  const h = await setup(t);
  assert.equal((await h.patch({ engine: 'unsupported' })).status, 400);
  const response = await h.patch({ engine: 'hermes', model: 'must-not-inherit', effort: 'high' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.bot.engine, 'hermes');
  assert.equal(body.bot.engineStatus.available, true);
  assert.equal(body.bot.model, '');
  assert.equal(body.bot.effort, '');
  assert.equal(h.app.store.bot('default')!.engine, 'codex');
  const bots = await fetch(`${h.base}/api/bots`).then(response => response.json()) as any;
  assert.equal(bots.bots.find((bot: any) => bot.id === 'product').engineStatus.available, true);
});

test('unavailable Hermes leaves the selected engine and old conversation binding unchanged', async t => {
  const h = await setup(t, false);
  const conversation = h.app.store.conversation('bot:product:oc_test', 'ou_alice');
  conversation.threadId = 'original-codex-thread';
  h.app.store.save();
  const response = await h.patch({ engine: 'hermes' });
  assert.equal(response.status, 503);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.equal(conversation.threadId, 'original-codex-thread');
});

for (const engine of ['codex', 'hermes'] as const) {
  test(`creating a ${engine} bot retains its selected engine and establishes one transport`, async t => {
    const h = await setup(t);
    const response = await h.create({ name: '新机器人', engine, appId: 'cli_1122334455667788', appSecret: 'test-secret', model: 'custom-model', effort: 'high' });
    assert.equal(response.status, 201, await response.clone().text());
    const { bot } = await response.json() as any;
    assert.equal(bot.engine, engine);
    assert.equal(bot.connection.status, 'connected');
    assert.equal(bot.model, engine === 'hermes' ? '' : 'custom-model');
    assert.equal(bot.effort, engine === 'hermes' ? '' : 'high');
    if (engine === 'hermes') assert.equal(bot.engineStatus.available, true);
    assert.equal('appSecret' in bot, false);
    assert.deepEqual(h.starts, ['cli_1122334455667788']);
    assert.deepEqual(h.verifications, h.starts);
    assert.equal(h.app.store.bot(bot.id)!.engine, engine);
    assert.equal(h.app.store.bot('default')!.engine, 'codex');
  });
}

test('unavailable Hermes rejects creation before verifying credentials or opening Feishu', async t => {
  const h = await setup(t, false);
  const before = h.app.store.bots();
  const response = await h.create({ name: '不可用', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 503);
  assert.deepEqual(h.app.store.bots(), before);
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
  const codex = await h.create({ name: '开发', engine: 'codex', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(codex.status, 201, 'Hermes availability must not block Codex creation');
});

test('a failed Hermes Feishu connection rolls back the new bot', async t => {
  const h = await setup(t);
  h.failApps.add('cli_1122334455667788');
  const before = h.app.store.bots();
  const response = await h.create({ name: '连接失败', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 503);
  assert.deepEqual(h.app.store.bots(), before);
  assert.deepEqual(new Store(h.app.store.dir).bots(), before);
});

test('switching Hermes back to Codex preserves native bindings and restores Codex model settings', async t => {
  const h = await setup(t);
  assert.equal((await h.patch({ engine: 'hermes' })).status, 200);
  const conversation = h.app.store.conversation('bot:product:oc_test', 'ou_alice');
  conversation.threadId = 'hermes:saved-session';
  h.app.store.message(conversation.chatId, 'assistant', 'Preserve this native history');
  const response = await h.patch({ engine: 'codex', model: 'chosen-codex-model', effort: 'high' });
  assert.equal(response.status, 200);
  const { bot } = await response.json() as any;
  assert.equal(bot.engine, 'codex');
  assert.equal(bot.model, 'chosen-codex-model');
  assert.equal(bot.effort, 'high');
  assert.equal(conversation.threadId, undefined);
  assert.equal(h.app.store.state.threadBindings['hermes:saved-session']?.chatId, conversation.chatId);
  const snapshots = fs.readdirSync(path.join(h.app.store.dir, 'engine-migrations')).map(file => JSON.parse(fs.readFileSync(path.join(h.app.store.dir, 'engine-migrations', file), 'utf8')));
  assert.ok(snapshots.some(snapshot => snapshot.from === 'hermes' && snapshot.history[conversation.chatId][0].text === 'Preserve this native history'));
});

test('Hermes status errors preserve bot details, bindings and the explicit notification recipient', async t => {
  const h = await setup(t);
  const target = { chatId: 'bot:product:oc_test', actorId: 'ou_alice', botAppId: h.app.store.bot('product')!.appId };
  h.app.store.saveConfig({ desktopNotificationTarget: target });
  const conversation = h.app.store.conversation(target.chatId, target.actorId);
  conversation.threadId = 'original-codex-thread';
  h.app.store.save();
  h.hermes.status = async () => { throw new Error('Hermes discovery failed'); };
  const response = await h.patch({ engine: 'hermes', name: 'should-not-save' });
  assert.equal(response.status, 503);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.equal(h.app.store.bot('product')!.name, '产品经理');
  assert.equal(conversation.threadId, 'original-codex-thread');
  assert.deepEqual(h.app.store.config.desktopNotificationTarget, target);
});

test('successful switch clears only that bot explicit default notification target and persists null', async t => {
  const h = await setup(t);
  const target = { chatId: 'bot:product:oc_test', actorId: 'ou_alice', botAppId: h.app.store.bot('product')!.appId };
  h.app.store.saveConfig({ desktopNotificationTarget: target });
  assert.equal((await h.patch({ engine: 'hermes' })).status, 200);
  assert.equal(h.app.store.config.desktopNotificationTarget, null);
  assert.equal(new Store(h.app.store.dir).config.desktopNotificationTarget, null);
  assert.equal((await h.patch({ engine: 'codex' })).status, 200);
  assert.equal(h.app.store.config.desktopNotificationTarget, null, 'switching back does not select another recipient');
  const otherTarget = { chatId: 'oc_developer', actorId: 'ou_developer', botAppId: h.app.store.bot('default')!.appId };
  h.app.store.saveConfig({ desktopNotificationTarget: otherTarget });
  assert.equal((await h.patch({ engine: 'hermes' })).status, 200);
  assert.deepEqual(h.app.store.config.desktopNotificationTarget, otherTarget);
});

test('fresh installs lazily discover Hermes without requiring a runtime configuration file', async t => {
  let checks = 0;
  t.mock.method(HermesClient.prototype, 'status', async () => { checks++; return { available: true }; });
  const h = await setup(t, true, { autoDiscover: true });
  assert.equal(checks, 0, 'Codex-only startup must not discover Hermes');
  assert.equal(fs.existsSync(path.join(h.app.store.dir, 'hermes-runtime.json')), false);
  const response = await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(checks, 1);
  assert.equal((await response.json() as any).bot.engine, 'hermes');
});

test('explicit invalid Hermes configuration fails closed for both creation and switching', async t => {
  let checks = 0;
  t.mock.method(HermesClient.prototype, 'status', async () => { checks++; return { available: true }; });
  const h = await setup(t, true, { autoDiscover: true, hermesConfig: '{"type":"desktop","baseUrl":"https://example.com"}' });
  assert.equal((await h.patch({ engine: 'hermes' })).status, 503);
  const response = await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 503);
  assert.equal(h.app.store.bots().length, 2);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.equal(checks, 0, 'an invalid explicit endpoint cannot fall back to discovery');
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
});

test('the engine PATCH refuses active work and leaves its live binding intact', async t => {
  const h = await setup(t);
  h.app.store.saveBot('product', { allowedActors: ['ou_alice'] });
  const conversation = h.app.store.conversation('bot:product:oc_test', 'ou_alice');
  conversation.threadId = 'active-codex-thread';
  h.app.store.save();
  let complete!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { complete = resolve; });
  h.runtime.run = async input => { started(); await done; return { threadId: input.threadId!, text: 'done' }; };
  const turn = h.app.bridge.receive({ id: 'http-active-test', chatId: conversation.chatId, actorId: 'ou_alice', localOnly: true, text: 'keep working' });
  try {
    await ready;
    const response = await h.patch({ engine: 'hermes' });
    assert.equal(response.status, 409);
    assert.equal(h.app.store.bot('product')!.engine, 'codex');
    assert.equal(conversation.threadId, 'active-codex-thread');
    assert.equal(fs.existsSync(path.join(h.app.store.dir, 'engine-migrations')), false);
  } finally { complete(); await turn; }
});

test('an unauthenticated Hermes runtime cannot create or replace a bot', async t => {
  const h = await setup(t);
  h.hermes.status = async () => ({ available: true, authenticated: false });
  assert.equal((await h.patch({ engine: 'hermes' })).status, 503);
  assert.equal((await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' })).status, 503);
  assert.equal(h.app.store.bots().length, 2);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
});
