import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { conversationKey } from '../src/routing.js';
import { TransportRouter } from '../src/transport-router.js';
import type { CodexRuntime, FeishuTransport, MessageCard, RuntimeEvent } from '../src/types.js';

const appA = 'cli_1234567890abcdef';
const appB = 'cli_abcdef0123456789';
const chatB = conversationKey('reviewer', 'oc_b');
const targetA = { chatId: 'oc_a', actorId: 'ou_a', botAppId: appA };
const targetB = { chatId: chatB, actorId: 'ou_b', botAppId: appB };
const requestNotification = { type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification', arguments: { summary: 'Explicit completion notice' } };

async function settle() {
  for (let count = 0; count < 8; count++) await new Promise(resolve => setImmediate(resolve));
}

function fixture(t: test.TestContext, hermesBots = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-target-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('notification-target-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new Store(dir);
  store.saveConfig({ appId: appA, appSecret: 'fixture-a', allowedActors: ['ou_a'], defaultWorkspace: dir,
    autoNotifyDesktop: true, desktopNotificationMode: 'long', desktopNotificationMinMinutes: 1, desktopNotificationTarget: null });
  store.saveBot('reviewer', { name: 'Reviewer', appId: appB, appSecret: 'fixture-b', allowedActors: ['ou_b'] });
  Object.assign(store.conversation('oc_a', 'ou_a', dir, 'p2p'), { threadId: 'existing-a' });
  Object.assign(store.conversation(chatB, 'ou_b', dir, 'p2p'), { threadId: 'existing-b' });
  for (let index = 1; index <= hermesBots; index++) {
    store.saveBot('hermes-' + index, { engine: 'hermes', appId: 'cli_hermes_' + index, appSecret: 'fixture', enabled: true, name: 'Hermes ' + index, allowedActors: ['ou_h' + index] });
    store.conversation(conversationKey('hermes-' + index, 'oc_h' + index), 'ou_h' + index, dir, 'p2p').threadId = 'hermes:existing-' + index;
  }
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const cards: Array<{ botId: string; chatId: string; card: MessageCard }> = [];
  const files: string[] = [];
  const runtime: CodexRuntime = {
    supportsSteering: true,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    async run() { throw new Error('Notifications must not start a task'); },
    async stop() { throw new Error('Notifications must not stop a task'); },
    async release() {}, async close() {}, async models() { return []; }, async history() { return []; },
    async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: 'Desktop-only task', isUserThread: true }; },
    async turnStatus() { return 'completed'; },
  };
  const make = (botId: string): FeishuTransport => ({
    async start() {}, async close() {}, async startTyping() { return async () => {}; }, async updateCard() {},
    async sendText() { throw new Error('Completion notices must be cards'); },
    async sendCard(chatId, card) { cards.push({ botId, chatId, card }); return `message-${cards.length}`; },
    async sendImage(chatId) { files.push(`${botId}:${chatId}`); return 'image'; },
    async sendFile(chatId) { files.push(`${botId}:${chatId}`); return 'file'; },
  });
  const transport = new TransportRouter();
  transport.set('default', make('default')); transport.set('reviewer', make('reviewer'));
  for (let index = 1; index <= hermesBots; index++) transport.set('hermes-' + index, make('hermes-' + index));
  const discovery = { projects: async () => [], threads: async () => [] };
  const bridge = new Bridge(store, runtime, discovery); bridge.transport = transport;
  const emit = (method: string, turnId: string, extra: Record<string, unknown> = {}, threadId = 'desktop-only') => listener?.({
    method, threadId, turnId, params: { turn: { id: turnId, status: method === 'turn/completed' ? 'completed' : 'inProgress', ...extra } },
  });
  const complete = (turnId = 'turn', extra: Record<string, unknown> = {}, threadId = 'desktop-only') => emit('turn/completed', turnId, {
    durationMs: 60_001, items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Verified desktop result' }], ...extra,
  }, threadId);
  return { dir, store, runtime, bridge, discovery, transport, cards, files, emit, complete };
}

test('an unbound desktop task over one minute uses the selected bot once without switching either conversation', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  const before = structuredClone(fx.store.state.conversations);
  fx.emit('turn/started', 'turn'); await settle();
  fx.complete(); fx.complete(); await settle();
  assert.equal(fx.cards.length, 1);
  assert.equal(fx.cards[0]!.botId, 'reviewer');
  assert.equal(fx.cards[0]!.chatId, 'oc_b');
  assert.match(fx.cards[0]!.card.text, /Verified desktop result/);
  const record = Object.values(fx.store.state.notifications)[0]!;
  assert.equal(record.status, 'sent');
  assert.equal(record.chatId, chatB);
  assert.deepEqual(fx.cards[0]!.card.buttons, [{ label: '切换到此会话', command: `/notification ${record.id}`, primary: true }]);
  assert.deepEqual(fx.store.state.conversations, before);
  assert.deepEqual(new Store(fx.dir).config.desktopNotificationTarget, targetB);
  const restored = new Bridge(new Store(fx.dir), fx.runtime, fx.discovery); restored.transport = fx.transport;
  await restored.deliverPendingNotifications();
  assert.equal(fx.cards.length, 1, 'restart must not replay an already delivered notice');
});

test('MCP completion requests use the selected default while automatic notification is disabled', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB, autoNotifyDesktop: false });
  fx.complete('explicit', { durationMs: 1, items: [requestNotification] }); await settle();
  assert.equal(fx.cards.length, 1);
  assert.equal(fx.cards[0]!.botId, 'reviewer');
  assert.match(fx.cards[0]!.card.text, /Explicit completion notice/);
  assert.equal(Object.values(fx.store.state.notifications)[0]!.automatic, false);
});

test('current and historical thread bindings take precedence over a different default', async t => {
  for (const binding of ['current', 'historical']) {
    const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
    const conversation = fx.store.state.conversations.oc_a!;
    conversation.threadId = 'desktop-only';
    if (binding === 'historical') { fx.store.rememberThread(conversation); conversation.threadId = 'another-task'; }
    fx.complete(); await settle();
    assert.equal(fx.cards.length, 1, binding);
    assert.equal(fx.cards[0]!.botId, 'default', binding);
    assert.equal(fx.cards[0]!.chatId, 'oc_a', binding);
    assert.equal(conversation.threadId, binding === 'current' ? 'desktop-only' : 'another-task');
  }
});

test('multiple private chats without a selection produce an actionable ambiguity warning and no notification', async t => {
  const fx = fixture(t);
  fx.complete(); await settle();
  assert.deepEqual(fx.cards, []);
  assert.equal(Object.keys(fx.store.state.notifications).length, 0);
  assert.ok(fx.store.state.logs.some(entry => entry.level === 'warn' && /多个/.test(entry.text) && /选择|默认/.test(entry.text)),
    'the log must distinguish multiple available recipients from having no authorized private chat');
});

test('revoked and App-ID-stale explicit defaults never fall back to the remaining authorized private chat', async t => {
  for (const change of ['revoke', 'app-id', 'missing-chat']) {
    const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
    if (change === 'revoke') fx.store.authorize('ou_b', false, 'reviewer');
    else if (change === 'app-id') fx.store.saveBot('reviewer', { appId: 'cli_1111111111111111' });
    else { delete fx.store.state.conversations[chatB]; fx.store.save(); }
    fx.complete(); await settle();
    assert.deepEqual(fx.cards, [], change);
    assert.equal(Object.keys(fx.store.state.notifications).length, 0, change);
    assert.ok(fx.store.state.logs.some(entry => entry.level === 'warn' && /失效|重新选择|无效/.test(entry.text)), change);
  }
});

test('changing the default only affects subsequent turns and explicit clearing does not select the remaining bot', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  fx.emit('turn/started', 'pinned'); await settle();
  assert.equal(Object.values(fx.store.state.notifications)[0]!.chatId, chatB);
  fx.store.saveConfig({ desktopNotificationTarget: targetA });
  fx.complete('pinned'); fx.complete('new-default'); await settle();
  assert.deepEqual(fx.cards.map(item => item.botId), ['reviewer', 'default']);
  fx.store.authorize('ou_a', false);
  fx.store.saveConfig({ desktopNotificationTarget: null });
  fx.complete('cleared'); await settle();
  assert.equal(fx.cards.length, 2);
  assert.equal(Object.values(fx.store.state.notifications).some(item => item.turnId === 'cleared'), false);
  assert.equal(new Store(fx.dir).config.desktopNotificationTarget, null);
});

test('deleting the default notification robot cancels pending notices and never retargets unbound desktop completions', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  fx.emit('turn/started', 'before-delete'); await settle();
  assert.equal(Object.values(fx.store.state.notifications).length, 1);
  // The task itself is an unbound desktop task; removing its idle notification bot must not stop Codex.
  await fx.bridge.removeBot('reviewer', async () => { fx.transport.delete('reviewer'); });
  assert.equal(fx.store.config.desktopNotificationTarget, null);
  assert.equal(fx.store.notificationTargets().length, 1);
  fx.complete('before-delete'); fx.complete('after-delete'); await settle();
  assert.deepEqual(fx.cards, []);
  assert.equal(Object.values(fx.store.state.notifications)[0]!.status, 'cancelled');
  assert.equal(Object.values(fx.store.state.notifications).length, 1);
});

test('deleting a notification recipient during task metadata lookup cannot recreate a pending notice', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  fx.runtime.threadInfo = async threadId => { entered(); await held; return { threadId, cwd: fx.dir, title: 'Slow metadata', isUserThread: true }; };
  fx.emit('turn/started', 'slow'); await started;
  try { await fx.bridge.removeBot('reviewer', async () => { fx.transport.delete('reviewer'); }); }
  finally { release(); }
  await settle(); fx.complete('slow'); await settle();
  assert.deepEqual(fx.cards, []); assert.deepEqual(fx.store.state.notifications, {});
});

test('revoking access, replacing the selected app or changing chat type after registration never redirects a notice', async t => {
  for (const change of ['revoke', 'app-id', 'chat-type']) {
    const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
    fx.emit('turn/started', 'pinned'); await settle();
    assert.equal(Object.values(fx.store.state.notifications)[0]!.chatId, chatB);
    if (change === 'revoke') fx.store.authorize('ou_b', false, 'reviewer');
    else if (change === 'app-id') fx.store.saveBot('reviewer', { appId: 'cli_1111111111111111' });
    else {
      fx.store.state.conversations[chatB]!.chatType = 'group';
      fx.store.saveBot('reviewer', { allowedGroups: ['oc_b'] });
      assert.equal(fx.store.isAuthorized(chatB, 'ou_b'), true, 'chat-type protection is distinct from revoked authorization');
    }
    fx.store.saveConfig({ desktopNotificationTarget: targetA });
    fx.complete('pinned'); await settle();
    await fx.bridge.deliverPendingNotifications();
    assert.deepEqual(fx.cards, [], change);
  }
});

test('a completion default does not choose a recipient for an otherwise ambiguous artifact request', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB, autoNotifyDesktop: false });
  const artifact = path.join(fx.dir, 'report.txt'); fs.writeFileSync(artifact, 'private report');
  fx.emit('turn/snapshot', 'artifact', { items: [{ id: 'artifact-call', type: 'mcpToolCall', server: 'feishu_completion',
    tool: 'send_artifact_to_feishu', status: 'completed', arguments: { paths: [artifact] } }] });
  await settle();
  assert.deepEqual(fx.files, []);
  assert.deepEqual(fx.cards, []);
  assert.equal(Object.keys(fx.store.state.artifacts).length, 0);
});

test('an unauthorized current or historical binding does not redirect its result to a valid default', async t => {
  for (const binding of ['current', 'historical']) {
    const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
    const conversation = fx.store.state.conversations.oc_a!;
    conversation.threadId = 'desktop-only';
    if (binding === 'historical') { fx.store.rememberThread(conversation); conversation.threadId = 'another-task'; }
    fx.store.authorize('ou_a', false);
    fx.complete(); await settle();
    assert.deepEqual(fx.cards, [], binding);
    assert.equal(Object.keys(fx.store.state.notifications).length, 0, binding);
  }
});

test('multiple existing bindings stay ambiguous even when one is the chosen default', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  fx.store.state.conversations.oc_a!.threadId = 'desktop-only';
  fx.store.state.conversations[chatB]!.threadId = 'desktop-only';
  fx.complete(); await settle();
  assert.deepEqual(fx.cards, []);
  assert.ok(fx.store.state.logs.some(entry => entry.level === 'warn' && /多个/.test(entry.text) && /绑定/.test(entry.text)));
});

test('an App-ID change during metadata lookup cannot move a notice to a newly configured app', async t => {
  const fx = fixture(t); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  fx.runtime.threadInfo = async threadId => { started(); await blocked; return { threadId, cwd: fx.dir, title: 'Desktop-only task', isUserThread: true }; };
  fx.complete(); await entered;
  fx.store.saveBot('reviewer', { appId: 'cli_1111111111111111' });
  fx.store.saveConfig({ desktopNotificationTarget: targetA });
  release(); await settle();
  assert.deepEqual(fx.cards, []);
  assert.ok(Object.values(fx.store.state.notifications).every(record => record.status !== 'sent'));
});

test('unbound Hermes completions prefer the unique Hermes bot and keep Codex notifications on Codex', async t => {
  const fx = fixture(t, 1); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  const before = structuredClone(fx.store.state.conversations);
  fx.complete('h', {}, 'hermes:desktop'); fx.complete('c'); await settle();
  assert.deepEqual(fx.cards.map(card => card.botId), ['hermes-1', 'reviewer']);
  assert.deepEqual(fx.store.state.conversations, before);
  const notice = Object.values(fx.store.state.notifications).find(item => item.threadId === 'hermes:desktop')!;
  assert.deepEqual(fx.cards[0]!.card.buttons, [{ label: '切换到此会话', command: '/notification ' + notice.id, primary: true }]);
});

test('a Hermes task binding wins among multiple Hermes bots, while unbound work uses its pinned Hermes default', async t => {
  for (const binding of ['current', 'historical', 'none']) {
    const fx = fixture(t, 2); fx.store.saveConfig({ desktopNotificationTarget: targetB });
    const conversation = fx.store.state.conversations[conversationKey('hermes-2', 'oc_h2')]!;
    if (binding !== 'none') {
      conversation.threadId = 'hermes:desktop';
      if (binding === 'historical') { fx.store.rememberThread(conversation); conversation.threadId = 'hermes:another'; }
    }
    fx.complete('h', {}, 'hermes:desktop'); await settle();
    assert.equal(fx.cards.length, 1, binding);
    assert.equal(fx.cards[0]!.botId, binding === 'none' ? 'hermes-1' : 'hermes-2', binding);
    assert.equal(fx.cards[0]!.card.buttons?.[0]?.label, '切换到此会话');
  }
});

test('a revoked Hermes task binding never falls back to another authorized bot', async t => {
  const fx = fixture(t, 2); fx.store.saveConfig({ desktopNotificationTarget: targetB });
  fx.store.state.conversations[conversationKey('hermes-2', 'oc_h2')]!.threadId = 'hermes:desktop';
  fx.store.authorize('ou_h2', false, 'hermes-2');
  fx.complete('h', {}, 'hermes:desktop'); await settle();
  assert.deepEqual(fx.cards, []);
});
test('Hermes completion defaults are independent, explicit and never cross over to Codex', async t => {
  const fx = fixture(t, 2);
  const hermesTarget = { chatId: conversationKey('hermes-2', 'oc_h2'), actorId: 'ou_h2', botAppId: 'cli_h2' };
  const actual = fx.store.notificationTargets(fx.store.config, 'hermes').find(item => item.botId === 'hermes-2')!;
  fx.store.saveConfig({ desktopNotificationTarget: targetB, hermesNotificationTarget: { ...hermesTarget, botAppId: actual.botAppId } });
  fx.complete('h1', {}, 'hermes:desktop'); await settle();
  assert.equal(fx.cards[0]!.botId, 'hermes-2');
  fx.store.saveConfig({ hermesNotificationTarget: null });
  fx.complete('h2', {}, 'hermes:desktop'); await settle();
  assert.equal(fx.cards.length, 1);
  fx.complete('c1'); await settle();
  assert.equal(fx.cards[1]!.botId, 'reviewer');
});
