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

test('group supplementation APIs persist per bot without reconnecting or changing thread bindings', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  assert.equal(bot.includeGroupContext, true);
  assert.ok((await h.state()).bots.every((item: any) => item.includeGroupContext === true));
  const chatId = conversationKey(bot.id, 'oc_existing');
  h.app.store.conversation(chatId, 'ou_user').threadId = 'existing-thread';
  const initialStarts = [...h.starts];
  for (const id of ['default', bot.id]) {
    const response = await h.request(`/api/bots/${id}`, { includeGroupContext: false }, 'PATCH');
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).bot.includeGroupContext, false);
    assert.equal(new Store(h.app.store.dir).bot(id)!.includeGroupContext, false);
    if (id === 'default') assert.equal(h.app.store.bot(bot.id)!.includeGroupContext, true);
  }
  assert.equal(h.app.store.config.includeGroupContext, false);
  assert.equal(h.app.store.state.conversations[chatId]!.threadId, 'existing-thread');
  assert.deepEqual(h.starts, initialStarts);
  assert.deepEqual(h.closes, []);
  assert.deepEqual(h.sends, []);
  const enabled = await h.request('/api/config', { includeGroupContext: true }, 'PUT');
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json() as any).config.includeGroupContext, true);
  assert.equal(new Store(h.app.store.dir).bot('default')!.includeGroupContext, true);
  assert.equal(new Store(h.app.store.dir).bot(bot.id)!.includeGroupContext, false);
  const created = await h.request('/api/bots', { name: 'Reviewer', appId: otherApp, appSecret: 'test-secret', includeGroupContext: false });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as any).bot.includeGroupContext, false);
});

test('group supplementation only accepts boolean API values for default and additional bots', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  for (const includeGroupContext of ['false', 'true', 0, 1, null, [], {}]) {
    for (const [endpoint, method] of [
      ['/api/bots/default', 'PATCH'], [`/api/bots/${bot.id}`, 'PATCH'], ['/api/config', 'PUT'],
    ]) {
      const response = await h.request(endpoint!, { includeGroupContext }, method!);
      assert.equal(response.status, 400, `${endpoint}: ${JSON.stringify(includeGroupContext)}`);
      assert.match((await response.json() as any).error, /补充群聊背景/);
    }
  }
  assert.ok(h.app.store.publicBots().every(item => item.includeGroupContext === true));
  assert.equal((await h.request(`/api/bots/${bot.id}`, { name: 'Renamed' }, 'PATCH')).status, 200);
  assert.equal(h.app.store.bot(bot.id)!.includeGroupContext, true);
  assert.deepEqual(h.starts, [developerApp]);
  assert.deepEqual(h.closes, []);
});

test('private role APIs default empty and persist independently of group roles and other bots', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  const starts = [...h.starts];
  assert.ok((await h.state()).bots.every((item: any) => item.privateRoleInstructions === ''));
  for (const [id, role] of [['default', '个人写作助手'], [bot.id, '个人代码助手']]) {
    const groupRole = h.app.store.bot(id)!.roleInstructions;
    const response = await h.request(`/api/bots/${id}`, { privateRoleInstructions: `  ${role}  ` }, 'PATCH');
    assert.equal(response.status, 200);
    const saved = (await response.json() as any).bot;
    assert.equal(saved.privateRoleInstructions, role);
    assert.equal(saved.roleInstructions, groupRole);
    assert.equal(new Store(h.app.store.dir).bot(id)!.privateRoleInstructions, role);
  }
  assert.equal(h.app.store.bot('default')!.privateRoleInstructions, '个人写作助手');
  assert.equal((await h.request('/api/config', { roleInstructions: '群聊产品经理' }, 'PUT')).status, 200);
  assert.equal(h.app.store.bot('default')!.privateRoleInstructions, '个人写作助手');
  assert.equal((await h.request('/api/config', { privateRoleInstructions: '  ' }, 'PUT')).status, 200);
  assert.equal(h.app.store.bot('default')!.privateRoleInstructions, '');
  assert.equal(h.app.store.bot('default')!.roleInstructions, '群聊产品经理');
  assert.equal(h.app.store.bot(bot.id)!.privateRoleInstructions, '个人代码助手');
  const created = await h.request('/api/bots', {
    name: '测试', appId: otherApp, appSecret: 'fixture-secret', roleInstructions: '群聊测试', privateRoleInstructions: '私聊教练',
  });
  assert.equal(created.status, 201);
  const newBot = (await created.json() as any).bot;
  assert.equal(newBot.privateRoleInstructions, '私聊教练');
  assert.equal(newBot.roleInstructions, '群聊测试');
  assert.deepEqual(h.starts, [...starts, otherApp]);
  assert.deepEqual(h.closes, []);
  assert.deepEqual(h.sends, []);
});

test('private role APIs reject invalid values without changing saved roles', async t => {
  const h = await fixture(t);
  const bot = await h.create();
  for (const privateRoleInstructions of [null, 0, false, [], {}, 'x'.repeat(12_001)]) {
    for (const [endpoint, method] of [['/api/bots/default', 'PATCH'], [`/api/bots/${bot.id}`, 'PATCH'], ['/api/config', 'PUT']]) {
      const response = await h.request(endpoint!, { privateRoleInstructions }, method!);
      assert.equal(response.status, 400);
      assert.match((await response.json() as any).error, /私聊角色说明/);
    }
  }
  assert.ok((await h.state()).bots.every((item: any) => item.privateRoleInstructions === ''));
  assert.equal(h.app.store.bot(bot.id)!.roleInstructions, '你是开发');
  assert.equal((await h.request(`/api/bots/${bot.id}`, { privateRoleInstructions: 'x'.repeat(12_000) }, 'PATCH')).status, 200);
});

test('notification target API lists only configured authorized private chats and persists a complete app-scoped selection', async t => {
  const h = await fixture(t); const bot = await h.create();
  await h.request('/api/actors', { actorId: 'ou_owner', allow: true });
  await h.request('/api/actors', { botId: bot.id, actorId: 'ou_reviewer', allow: true });
  const defaultChat = h.app.store.conversation('oc_default', 'ou_owner', undefined, 'p2p');
  const botChat = h.app.store.conversation(conversationKey(bot.id, 'oc_review'), 'ou_reviewer', undefined, 'p2p');
  defaultChat.threadId = 'current-default'; botChat.threadId = 'current-review';
  h.app.store.conversation('oc_not_allowed', 'ou_other', undefined, 'p2p');
  h.app.store.conversation('local-preview', 'ou_owner');
  await h.request('/api/groups', { botId: bot.id, chatId: 'oc_group', allow: true });
  h.app.store.conversation(conversationKey(bot.id, 'oc_group'), 'ou_reviewer', undefined, 'group');
  h.app.store.saveBot('unconfigured', { name: 'Unconfigured', allowedActors: ['ou_missing'] });
  h.app.store.conversation(conversationKey('unconfigured', 'oc_missing'), 'ou_missing', undefined, 'p2p');
  const state = await h.state();
  const candidates = state.notificationTargets;
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.find((item: any) => item.botId === bot.id), {
    chatId: botChat.chatId, actorId: 'ou_reviewer', botAppId: developerApp, botId: bot.id, botName: bot.name,
  });
  const target = { chatId: botChat.chatId, actorId: botChat.actorId, botAppId: developerApp };
  const starts = [...h.starts];
  const selected = await h.request('/api/config', { desktopNotificationTarget: target }, 'PUT');
  assert.equal(selected.status, 200, await selected.clone().text());
  assert.deepEqual((await h.state()).config.desktopNotificationTarget, target);
  assert.deepEqual(new Store(h.app.store.dir).config.desktopNotificationTarget, target);
  assert.deepEqual(h.starts, starts, 'changing recipient does not reconnect bots');
  assert.equal(defaultChat.threadId, 'current-default'); assert.equal(botChat.threadId, 'current-review');
  const cleared = await h.request('/api/config', { desktopNotificationTarget: null }, 'PUT');
  assert.equal(cleared.status, 200);
  assert.equal((await h.state()).config.desktopNotificationTarget, null);
  assert.equal(new Store(h.app.store.dir).config.desktopNotificationTarget, null);
});

test('invalid or revoked notification selections reject the whole patch without guessing or mutating configuration', async t => {
  const h = await fixture(t); const bot = await h.create();
  await h.request('/api/actors', { botId: bot.id, actorId: 'ou_reviewer', allow: true });
  const chatId = conversationKey(bot.id, 'oc_review');
  h.app.store.conversation(chatId, 'ou_reviewer', undefined, 'p2p');
  const target = { chatId, actorId: 'ou_reviewer', botAppId: developerApp };
  assert.equal((await h.request('/api/config', { desktopNotificationTarget: target }, 'PUT')).status, 200);
  const initialProgress = h.app.store.config.progress;
  for (const invalid of [false, '', [], {}, { chatId }, { ...target, actorId: 'ou_other' },
    { ...target, chatId: 'oc_unknown' }, { ...target, botAppId: defaultApp }, { ...target, botId: bot.id }]) {
    const response = await h.request('/api/config', { desktopNotificationTarget: invalid, progress: !initialProgress }, 'PUT');
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.match((await response.json() as any).error, /通知|接收/);
    assert.deepEqual(h.app.store.config.desktopNotificationTarget, target);
    assert.equal(h.app.store.config.progress, initialProgress);
  }
  await h.request('/api/actors', { botId: bot.id, actorId: 'ou_reviewer', allow: false });
  assert.deepEqual((await h.state()).notificationTargets, []);
  const revoked = await h.request('/api/config', { desktopNotificationTarget: target }, 'PUT');
  assert.equal(revoked.status, 400);
  assert.deepEqual((await h.state()).config.desktopNotificationTarget, target, 'retain stale selection so the UI can explain why it is invalid');
  assert.equal((await h.request('/api/config', { desktopNotificationTarget: null }, 'PUT')).status, 200);
});
