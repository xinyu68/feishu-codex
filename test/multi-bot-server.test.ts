import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { startServer } from '../src/server.js';
import { TransportRouter } from '../src/transport-router.js';
import { conversationKey, messageKey } from '../src/routing.js';
import type { CodexRunInput, CodexRuntime, FeishuOptions, FeishuTransport, ThreadSummary } from '../src/types.js';

const defaultApp = 'cli_1234567890abcdef';
const developerApp = 'cli_abcdef0123456789';
const otherApp = 'cli_abcdef0123456780';

async function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-multi-bot-'));
  const seed = new Store(dir);
  seed.saveConfig({ appId: defaultApp, appSecret: 'default-secret', enabled: false, defaultWorkspace: dir });
  const runs: CodexRunInput[] = [];
  const clients = new Map<string, FeishuOptions>();
  const starts: string[] = [];
  const closes: string[] = [];
  const sends: Array<{ appId: string; chatId: string; text: string }> = [];
  const failApps = new Set<string>();
  const verifications: string[] = [];
  const sessions: ThreadSummary[] = [];
  const codex: CodexRuntime = {
    async run(input) { runs.push(input); const threadId = input.threadId || `thread-${runs.length}`; input.onThread?.(threadId); return { threadId, text: '已完成' }; },
    async stop() {}, async release() {}, async close() {}, async models() { return []; }, async history() { return []; },
    async status() { return { available: true, authenticated: true }; },
  };
  const app = await startServer({ port: 0, dataDir: dir, codex, discovery: { async projects() { return []; }, async threads() { return sessions; } }, feishu: {
    async verifyCredentials(appId, secret) { verifications.push(appId); if (secret === 'invalid') throw new Error('Invalid'); },
    createTransport(options) {
      clients.set(options.appId, options);
      let sequence = 0;
      return {
        async start() { starts.push(options.appId); options.onStatus(failApps.has(options.appId) ? 'error' : 'connected'); },
        async close() { closes.push(options.appId); options.onStatus('stopped'); },
        async sendText(chatId, text) { sends.push({ appId: options.appId, chatId, text }); return `om_${++sequence}`; },
        async sendCard(chatId, card) { sends.push({ appId: options.appId, chatId, text: card.text }); return `om_${++sequence}`; },
        async sendImage() { return `om_${++sequence}`; }, async sendFile() { return `om_${++sequence}`; },
        async updateCard() {}, async startTyping() { return async () => {}; },
      };
    },
  } });
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('feishu-multi-bot-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;
  const csrfToken = (await state()).csrfToken;
  const request = (endpoint: string, body: unknown, method = 'POST') => fetch(`${base}${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': csrfToken }, body: JSON.stringify(body) });
  const create = async (name = '开发', appId = developerApp) => {
    const response = await request('/api/bots', { name, appId, appSecret: `${name}-secret`, roleInstructions: `你是${name}` });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json() as any).bot;
  };
  return { app, clients, starts, closes, sends, runs, failApps, verifications, sessions, state, request, create };
}

test('each bot connects once and public state masks every secret including nested configuration', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/api/connection', { enabled: true })).status, 200);
  const bot = await h.create();
  assert.equal(bot.connection.status, 'connected');
  assert.equal(bot.hasSecret, true);
  assert.equal('appSecret' in bot, false);
  h.app.store.log('warn', 'default-secret 开发-secret');
  const state = await h.state();
  assert.equal(state.bots.length, 2);
  assert.equal(state.connection.status, 'connected');
  assert.equal(JSON.stringify(state).includes('default-secret'), false);
  assert.equal(JSON.stringify(state).includes('开发-secret'), false);
  h.clients.get(developerApp)!.onStatus('connected', '开发-secret default-secret');
  assert.equal(JSON.stringify(await h.state()).includes('开发-secret'), false);
  assert.equal((await h.request(`/api/bots/${bot.id}/connection`, { enabled: true })).status, 200);
  assert.deepEqual(h.starts, [defaultApp, developerApp]);
  await h.app.close();
  assert.deepEqual(h.closes.sort(), [defaultApp, developerApp].sort());
});

test('duplicate App IDs cannot create a second consumer through old or new APIs', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  assert.equal((await h.state()).connection.status, 'stopped');
  assert.equal((await h.state()).connectionSummary.status, 'connected');
  assert.equal((await h.state()).connectionSummary.connected, 1);
  for (const [route, body, method] of [
    ['/api/bots', { name: '重复', appId: developerApp, appSecret: 'duplicate-secret' }, 'POST'],
    ['/api/config', { appId: developerApp, appSecret: 'duplicate-secret' }, 'PUT'],
    ['/api/credentials', { appId: developerApp, appSecret: 'duplicate-secret' }, 'POST'],
    [`/api/bots/${bot.id}`, { appId: defaultApp, appSecret: 'duplicate-secret' }, 'PATCH'],
  ] as const) assert.equal((await h.request(route, body, method)).status, 409, route);
  assert.deepEqual(h.starts, [developerApp]);
  assert.deepEqual(h.verifications, [developerApp]);
});

test('failed creation rolls back configuration; replacing credentials restores only that bot', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  const boundChat = conversationKey(bot.id, 'oc_existing');
  h.app.store.conversation(boundChat, 'ou_user').threadId = 'existing-thread';
  h.failApps.add(otherApp);
  assert.equal((await h.request('/api/bots', { name: '失败', appId: otherApp, appSecret: 'new-secret' })).status, 503);
  assert.equal((await h.state()).bots.length, 2);
  assert.equal((await h.request(`/api/bots/${bot.id}/credentials`, { appId: otherApp, appSecret: 'new-secret' })).status, 503);
  const restored = (await h.state()).bots.find((item: any) => item.id === bot.id);
  assert.equal(restored.appId, developerApp);
  assert.equal(restored.connection.status, 'connected');
  assert.equal(h.app.store.bot(bot.id)?.appSecret, '开发-secret');
  assert.equal(h.app.store.state.conversations[boundChat]?.threadId, 'existing-thread');
});

test('blank secrets are kept only within the same app and authorizations are app scoped', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  await h.request('/api/actors', { botId: bot.id, actorId: 'ou_user', allow: true });
  await h.request('/api/groups', { botId: bot.id, chatId: 'oc_group', allow: true });
  const boundChat = conversationKey(bot.id, 'oc_group');
  h.app.store.conversation(boundChat, 'ou_user', undefined, 'group').threadId = 'old-app-thread';
  assert.equal((await h.request(`/api/bots/${bot.id}`, { name: '开发二', appSecret: ' ' }, 'PATCH')).status, 200);
  assert.equal(h.app.store.bot(bot.id)?.appSecret, '开发-secret');
  assert.deepEqual(h.app.store.config.allowedActors, []);
  assert.deepEqual(h.app.store.bot(bot.id)?.allowedActors, ['ou_user']);
  assert.deepEqual(h.app.store.bot(bot.id)?.allowedGroups, ['oc_group']);
  assert.equal((await h.request(`/api/bots/${bot.id}/credentials`, { appId: otherApp, appSecret: '' })).status, 400);
  assert.equal((await h.request(`/api/bots/${bot.id}/credentials`, { appId: otherApp, appSecret: 'replacement-secret' })).status, 200);
  assert.deepEqual(h.app.store.bot(bot.id)?.allowedActors, []);
  assert.deepEqual(h.app.store.bot(bot.id)?.allowedGroups, []);
  assert.equal(h.app.store.state.conversations[boundChat], undefined);
});

test('group observations and downloads require both bot-specific actor and group authorization', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  const client = h.clients.get(developerApp)!;
  assert.equal(client.allowAttachments?.('ou_user', 'oc_group', 'group'), false);
  await h.request('/api/actors', { botId: bot.id, actorId: 'ou_user', allow: true });
  assert.equal(client.allowAttachments?.('ou_user', 'oc_group', 'group'), false);
  assert.equal(client.allowAttachments?.('ou_user', 'oc_dm', 'p2p'), true);
  await h.request('/api/groups', { botId: bot.id, chatId: 'oc_group', allow: true });
  assert.equal(client.allowAttachments?.('ou_user', 'oc_group', 'group'), true);
  assert.equal(client.allowAttachments?.('ou_other', 'oc_group', 'group'), false);
  assert.equal(client.allowGroup?.('oc_other'), false);
  let observations = 0;
  const observe = h.app.store.observeGroup.bind(h.app.store);
  h.app.store.observeGroup = (message) => { observations++; return observe(message); };
  for (const [chatId, actorId] of [['oc_other', 'ou_user'], ['oc_group', 'ou_other'], ['oc_group', 'ou_user']]) {
    await client.onGroupMessage?.({ id: `om_${chatId}_${actorId}`, chatId: chatId!, actorId: actorId!, text: '普通群聊消息', chatType: 'group' });
  }
  assert.equal(observations, 1);
  assert.equal(h.runs.length, 0);
  assert.equal(h.sends.length, 0);
});

test('incoming IDs and responses stay separated even when two apps receive the same group event', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  await h.request('/api/connection', { enabled: true });
  for (const botId of ['default', bot.id]) {
    await h.request('/api/actors', { botId, actorId: 'ou_user', allow: true });
    await h.request('/api/groups', { botId, chatId: 'oc_group', allow: true });
  }
  for (const appId of [defaultApp, developerApp]) {
    await h.clients.get(appId)!.onMessage({ id: 'om_shared', chatId: 'oc_group', actorId: 'ou_user', text: '介绍你的职责', chatType: 'group' });
  }
  assert.equal(h.runs.length, 2);
  assert.ok(h.app.store.state.conversations.oc_group);
  assert.ok(h.app.store.state.conversations[conversationKey(bot.id, 'oc_group')]);
  assert.notEqual(h.app.store.state.conversations.oc_group?.threadId, h.app.store.state.conversations[conversationKey(bot.id, 'oc_group')]?.threadId);
  assert.ok(h.sends.some(item => item.appId === defaultApp && item.chatId === 'oc_group'));
  assert.ok(h.sends.some(item => item.appId === developerApp && item.chatId === 'oc_group'));
  assert.equal(h.sends.some(item => item.chatId.startsWith('bot:')), false);
});

test('deleting a bot disconnects only its own listener and stale callbacks cannot execute work', async t => {
  const h = await fixture(t);
  await h.request('/api/connection', { enabled: true });
  const bot = await h.create();
  const removedClient = h.clients.get(developerApp)!;
  assert.equal((await h.request(`/api/bots/${bot.id}`, {}, 'DELETE')).status, 200);
  assert.deepEqual(h.closes, [developerApp]);
  assert.equal((await h.state()).connection.status, 'connected');
  assert.equal((await h.request('/api/bots/default', {}, 'DELETE')).status, 400);
  await removedClient.onMessage({ id: 'om_stale', chatId: 'oc_group', actorId: 'ou_user', text: '不能执行' });
  assert.equal(h.runs.length, 0);
  assert.equal(h.sends.length, 0);
});

test('group session discovery only offers threads belonging to that bot and group', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  await h.request('/api/groups', { botId: bot.id, chatId: 'oc_group', allow: true });
  const route = conversationKey(bot.id, 'oc_group');
  for (const [id, chatId] of [['own-thread', route], ['other-bot-thread', 'oc_group'], ['other-group-thread', conversationKey(bot.id, 'oc_other')]]) {
    const conversation = h.app.store.conversation(chatId!, 'ou_user', undefined, 'group');
    conversation.threadId = id!; h.app.store.rememberThread(conversation);
  }
  for (const id of ['own-thread', 'other-bot-thread', 'other-group-thread', 'desktop-thread']) h.sessions.push({ id, cwd: h.app.store.dir, title: id, preview: '', updatedAt: '' });
  const read = async (chatId?: string) => {
    const query = new URLSearchParams({ cwd: h.app.store.dir, ...(chatId ? { chatId } : {}) });
    const response = await fetch(`http://127.0.0.1:${h.app.port}/api/sessions?${query}`);
    return (await response.json() as any).sessions.map((item: ThreadSummary) => item.id);
  };
  assert.deepEqual(await read(route), ['own-thread']);
  assert.deepEqual(await read('oc_private'), h.sessions.map(item => item.id));
  assert.deepEqual(await read(), h.sessions.map(item => item.id));
});

test('revoking the original sender stops their group task even after another member speaks', async t => {
  const h = await fixture(t);
  await h.request('/api/connection', { enabled: true });
  for (const actorId of ['ou_original', 'ou_later']) await h.request('/api/actors', { actorId, allow: true });
  await h.request('/api/groups', { chatId: 'oc_group', allow: true });
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const stopped: string[] = [];
  Object.assign(h.app.bridge.codex, {
    supportsSteering: true,
    async run(input: CodexRunInput) { input.onThread?.('thread-original'); started(); await finished; return { threadId: 'thread-original', text: '完成' }; },
    async stop(threadId: string) { stopped.push(threadId); },
  });
  const first = h.clients.get(defaultApp)!.onMessage({ id: 'om_original', chatId: 'oc_group', actorId: 'ou_original', chatType: 'group', text: '执行任务' });
  await running;
  await h.clients.get(defaultApp)!.onMessage({ id: 'om_later', chatId: 'oc_group', actorId: 'ou_later', chatType: 'group', text: '/status' });
  assert.equal(h.app.store.conversation('oc_group').actorId, 'ou_later');
  try {
    assert.equal((await h.request('/api/actors', { actorId: 'ou_original', allow: false })).status, 200);
    assert.ok(stopped.includes('thread-original'));
  } finally { release(); await first; }
});

test('transport router routes message updates, files and typing to their original bot', async () => {
  const router = new TransportRouter();
  const calls: string[] = [];
  const make = (bot: string): FeishuTransport => ({
    async start() {}, async close() { calls.push(`${bot}:close`); },
    async sendText(id) { calls.push(`${bot}:text:${id}`); return 'om_reply'; },
    async sendCard(id) { calls.push(`${bot}:card:${id}`); return 'om_reply'; },
    async sendImage(id) { calls.push(`${bot}:image:${id}`); return 'om_image'; },
    async sendFile(id) { calls.push(`${bot}:file:${id}`); return 'om_file'; },
    async updateCard(id) { calls.push(`${bot}:update:${id}`); },
    async startTyping(id) { calls.push(`${bot}:typing:${id}`); return async () => { calls.push(`${bot}:clear:${id}`); }; },
  });
  router.set('default', make('default')); router.set('developer', make('developer'));
  assert.equal(await router.sendText('oc_group', 'hello'), 'om_reply');
  assert.equal(await router.sendCard(conversationKey('developer', 'oc_group'), { title: '完成', text: '完成' }), messageKey('developer', 'om_reply'));
  await router.sendImage(conversationKey('developer', 'oc_group'), 'image.png');
  await router.sendFile(conversationKey('developer', 'oc_group'), 'file.txt');
  await router.updateCard(messageKey('developer', 'om_reply'), { title: '完成', text: '完成' });
  await (await router.startTyping(messageKey('developer', 'om_request')))();
  assert.deepEqual(calls, ['default:text:oc_group', 'developer:card:oc_group', 'developer:image:oc_group', 'developer:file:oc_group', 'developer:update:om_reply', 'developer:typing:om_request', 'developer:clear:om_request']);
  await assert.rejects(router.sendText(conversationKey('missing', 'oc_group'), 'hello'), /连接尚未就绪/);
  router.setReady('developer', false);
  assert.equal(router.isAvailable(conversationKey('developer', 'oc_group')), false);
  assert.equal(router.isAvailable('oc_group'), true);
  await assert.rejects(router.sendText(conversationKey('developer', 'oc_group'), 'hello'), /连接尚未就绪/);
  router.setReady('developer', true);
  assert.equal(router.isAvailable(conversationKey('developer', 'oc_group')), true);
  await router.close();
});
