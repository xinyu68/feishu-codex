import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import type { CodexRuntime, MessageCard, RuntimeEvent } from '../src/types.js';

async function settle(_bridge: Bridge) {
  // Fixture RPCs resolve locally; flush their event queues without requiring
  // the desktop task itself to be idle after a turn/started event.
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-notifications-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ allowedActors: ['ou_owner'], defaultWorkspace: dir });
  Object.assign(store.conversation('oc_owner', 'ou_owner'), { threadId: 'desktop', title: '原有绑定' });
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const cards: { chatId: string; card: MessageCard }[] = [];
  const runtime: CodexRuntime = {
    supportsSteering: true,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    async run() { throw new Error('The notification must not start a model task'); },
    async stop() { throw new Error('The notification must not stop a task'); },
    async release() {}, async close() {}, async models() { return []; }, async history() { return []; },
    async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '桌面开发功能', isUserThread: true }; },
    async turnStatus() { return 'completed'; },
  };
  const transport = {
    async start() {}, async close() {}, async startTyping() { return async () => {}; },
    async sendText() { throw new Error('Use the notification card'); },
    async sendImage() { return ''; }, async sendFile() { return ''; }, async updateCard() {},
    async sendCard(chatId: string, card: MessageCard) { cards.push({ chatId, card }); return `message-${cards.length}`; },
  };
  const discovery = { projects: async () => [], threads: async () => [] };
  const bridge = new Bridge(store, runtime, discovery);
  bridge.transport = transport;
  const emit = (method: string, status: string, extra: Record<string, unknown> = {}, turnId = 'turn') => listener?.({
    method, threadId: 'desktop', turnId, params: { turn: { id: turnId, status, ...extra } },
  });
  const completed = () => emit('turn/completed', 'completed', { items: [{ type: 'agentMessage', phase: 'final_answer', text: '功能已完成，检查通过。' }] });
  return { dir, store, runtime, bridge, cards, transport, discovery, emit, completed };
}

test('automatic desktop notifications are off by default and old configurations stay off', async t => {
  const fx = fixture(t);
  assert.equal(fx.store.config.autoNotifyDesktop, false);
  fx.completed(); await settle(fx.bridge);
  assert.deepEqual(fx.cards, []);
  const saved = JSON.parse(fs.readFileSync(path.join(fx.dir, 'config.json'), 'utf8'));
  delete saved.autoNotifyDesktop;
  delete saved.desktopNotificationMode;
  delete saved.desktopNotificationMinMinutes;
  fs.writeFileSync(path.join(fx.dir, 'config.json'), JSON.stringify(saved));
  assert.equal(new Store(fx.dir).config.autoNotifyDesktop, false);
  assert.equal(new Store(fx.dir).config.desktopNotificationMode, 'all');
  assert.equal(new Store(fx.dir).config.desktopNotificationMinMinutes, 1);
  fx.store.saveConfig({ autoNotifyDesktop: true });
  assert.equal(new Store(fx.dir).config.autoNotifyDesktop, true);
});

test('long-only filters completed, failed and stopped tasks using the configurable strict boundary', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true, desktopNotificationMode: 'long', desktopNotificationMinMinutes: 2 });
  for (const status of ['completed', 'failed', 'interrupted']) {
    for (const durationMs of [0, 119_999, 120_000, 120_001]) {
      fx.emit('turn/completed', status, { durationMs }, `${status}-${durationMs}`);
      await settle(fx.bridge);
    }
  }
  assert.equal(fx.cards.length, 3);
  assert.deepEqual(fx.cards.map(item => item.card.title), ['桌面任务已完成', '桌面任务未完成', '桌面任务已停止']);
  assert.equal(Object.values(fx.store.state.notifications).filter(item => item.status === 'skipped').length, 9);
  const restored = new Store(fx.dir);
  assert.equal(restored.config.desktopNotificationMinMinutes, 2);
  assert.equal(restored.config.desktopNotificationMode, 'long');
});

test('explicit MCP bypasses duration filtering, including a late tool event for a skipped turn', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true, desktopNotificationMode: 'long', desktopNotificationMinMinutes: 5 });
  fx.emit('turn/completed', 'completed', { durationMs: 5000 }); await settle(fx.bridge);
  assert.equal(fx.cards.length, 0);
  const call = { type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification', arguments: { summary: '明确要求通知' } };
  fx.emit('turn/snapshot', 'completed', { durationMs: 5000, items: [call] }); await settle(fx.bridge);
  fx.emit('turn/snapshot', 'completed', { durationMs: 5000, items: [call] }); await settle(fx.bridge);
  assert.equal(fx.cards.length, 1);
  assert.match(fx.cards[0]!.card.text, /明确要求通知/);
  assert.equal(Object.values(fx.store.state.notifications)[0]?.automatic, false);
});

test('delivery delay and restart do not make a short task qualify as a long one', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true, desktopNotificationMode: 'long' });
  const start = Math.floor(Date.now() / 1000) - 600;
  fx.bridge.transport = undefined;
  fx.emit('turn/started', 'inProgress', { startedAt: start }); await settle(fx.bridge);
  fx.emit('turn/completed', 'completed', { startedAt: start, completedAt: start + 15 }); await settle(fx.bridge);
  const restored = new Bridge(new Store(fx.dir), fx.runtime, fx.discovery); restored.transport = fx.transport;
  await restored.deliverPendingNotifications();
  assert.equal(fx.cards.length, 0);
  assert.equal(Object.values(restored.store.state.notifications)[0]?.skipReason, 'short');
});

test('missed completion timing is recovered from the exact runtime turn after restart', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true, desktopNotificationMode: 'long' });
  const start = Math.floor(Date.now() / 1000) - 600;
  fx.emit('turn/started', 'inProgress', { startedAt: start }); await settle(fx.bridge);
  fx.runtime.turnTiming = async (threadId, turnId) => {
    assert.equal(threadId, 'desktop'); assert.equal(turnId, 'turn');
    return { startedAtMs: start * 1000, completedAtMs: (start + 90) * 1000, durationMs: 90_001 };
  };
  const restored = new Bridge(new Store(fx.dir), fx.runtime, fx.discovery); restored.transport = fx.transport;
  await restored.deliverPendingNotifications(); await restored.deliverPendingNotifications();
  assert.equal(fx.cards.length, 1);
  assert.equal(Object.values(restored.store.state.notifications)[0]?.timing?.durationMs, 90_001);
});

test('native duration wins over timestamps and unknown timing is not guessed from registration age', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true, desktopNotificationMode: 'long' });
  const start = Math.floor(Date.now() / 1000) - 600;
  fx.emit('turn/completed', 'completed', { startedAt: start, completedAt: start + 600, durationMs: 50_000 }, 'short');
  fx.emit('turn/completed', 'completed', {}, 'unknown');
  await settle(fx.bridge);
  assert.equal(fx.cards.length, 0);
  const records = Object.values(fx.store.state.notifications);
  assert.equal(records.find(item => item.turnId === 'short')?.skipReason, 'short');
  assert.equal(records.find(item => item.turnId === 'unknown')?.skipReason, 'timing-unavailable');
  fx.store.saveConfig({ desktopNotificationMode: 'all' });
  fx.emit('turn/completed', 'completed', { durationMs: 50_000 }, 'short'); await settle(fx.bridge);
  assert.equal(fx.cards.length, 0, 'changing policy never backfills filtered turns');
  fx.emit('turn/completed', 'completed', {}, 'new-all-mode'); await settle(fx.bridge);
  assert.equal(fx.cards.length, 1, 'all-mode does not require a duration');
});

test('live timing fallback captures arrival time before queued async work', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true, desktopNotificationMode: 'long' });
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  fx.runtime.threadInfo = async threadId => { await pending; return { threadId, cwd: fx.dir, title: 'fallback', isUserThread: true }; };
  fx.emit('turn/started', 'inProgress');
  t.mock.timers.tick(30_000);
  fx.emit('turn/completed', 'completed');
  t.mock.timers.tick(600_000);
  release(); await settle(fx.bridge);
  assert.equal(fx.cards.length, 0);
  const timing = Object.values(fx.store.state.notifications)[0]?.timing;
  assert.equal(timing?.startedAtMs, 1_800_000_000_000);
  assert.equal(timing?.completedAtMs, 1_800_000_030_000);
});

test('desktop turn completes without an MCP call and duplicate events send one card without changing binding', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  fx.emit('turn/started', 'inProgress'); await settle(fx.bridge);
  Object.assign(fx.store.state.conversations.oc_owner!, { threadId: 'another-task' });
  fx.store.conversation('oc_newer', 'ou_owner').updatedAt = '2099-01-01';
  fx.completed(); fx.completed(); await settle(fx.bridge);
  assert.equal(fx.cards.length, 1);
  assert.equal(fx.cards[0]?.chatId, 'oc_owner', 'receiver is fixed when the desktop turn is observed');
  assert.equal(fx.store.state.conversations.oc_owner?.threadId, 'another-task');
  assert.match(fx.cards[0]!.card.text, /桌面开发功能/);
  assert.match(fx.cards[0]!.card.text, /功能已完成，检查通过/);
  assert.match(fx.cards[0]!.card.buttons![0]!.command, /^\/notification /);
  assert.equal(Object.values(fx.store.state.notifications)[0]?.status, 'sent');
});

test('enabling notifications does not replay old snapshots, but captures a fresh short desktop turn', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  fx.emit('turn/snapshot', 'completed', { completedAt: Math.floor(Date.now() / 1000) - 60 }, 'old');
  await settle(fx.bridge); assert.equal(fx.cards.length, 0);
  fx.emit('turn/snapshot', 'completed', { completedAt: Math.ceil(Date.now() / 1000) }, 'fresh');
  await settle(fx.bridge); assert.equal(fx.cards.length, 1);
});

test('Feishu and local preview turns are excluded even if the binding now points elsewhere', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  for (const source of ['feishu', 'management'] as const) {
    fx.store.operation(source, { chatId: 'oc_owner', actorId: 'ou_owner', cwd: fx.dir, threadId: 'desktop', turnId: source, revision: 0, source, status: 'submitted' });
    fx.store.state.conversations.oc_owner!.threadId = 'other-task';
    fx.emit('turn/completed', 'completed', {}, source);
  }
  await settle(fx.bridge); assert.equal(fx.cards.length, 0);
});

test('a bridge submission recorded during metadata lookup still suppresses the automatic notification', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  fx.runtime.threadInfo = async threadId => { await blocked; return { threadId, cwd: fx.dir, title: 'task', isUserThread: true }; };
  fx.completed(); await new Promise(resolve => setImmediate(resolve));
  fx.store.operation('phone', { chatId: 'oc_owner', actorId: 'ou_owner', cwd: fx.dir, threadId: 'desktop', turnId: 'turn', revision: 0, source: 'feishu', status: 'submitted' });
  resume(); await settle(fx.bridge);
  assert.equal(fx.cards.length, 0);
});

test('explicit MCP and automatic notification share one record and explicit requests survive turning the switch off', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  fx.emit('turn/started', 'inProgress'); await settle(fx.bridge);
  fx.emit('turn/snapshot', 'inProgress', { items: [{ type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification', arguments: { summary: '用户明确要求的通知' } }] });
  await settle(fx.bridge); fx.store.saveConfig({ autoNotifyDesktop: false });
  fx.completed(); await settle(fx.bridge);
  assert.equal(fx.cards.length, 1); assert.match(fx.cards[0]!.card.text, /用户明确要求的通知/);
  assert.equal(Object.keys(fx.store.state.notifications).length, 1);
});

test('disabling before completion cancels automatic delivery and a later Feishu continuation suppresses it too', async t => {
  for (const reason of ['off', 'phone']) {
    const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
    fx.emit('turn/started', 'inProgress'); await settle(fx.bridge);
    if (reason === 'off') fx.store.saveConfig({ autoNotifyDesktop: false });
    else fx.store.operation('phone', { chatId: 'oc_owner', actorId: 'ou_owner', cwd: fx.dir, threadId: 'desktop', turnId: 'turn', revision: 0, source: 'feishu', status: 'submitted', mode: 'steer' });
    fx.completed(); await settle(fx.bridge);
    assert.equal(fx.cards.length, 0);
    assert.equal(Object.values(fx.store.state.notifications)[0]?.status, 'cancelled');
  }
});

test('failed and interrupted tasks retain their actual outcome and only this turn contributes to the result', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  fx.runtime.history = async () => [{ role: 'assistant', text: '无关任务的结果', turnId: 'unrelated', phase: 'final_answer' }, { role: 'assistant', text: '本轮已停止', turnId: 'interrupted', phase: 'final_answer' }];
  fx.emit('turn/completed', 'failed', {}, 'failed'); fx.emit('turn/completed', 'interrupted', {}, 'interrupted');
  await settle(fx.bridge);
  assert.deepEqual(fx.cards.map(item => item.card.title), ['桌面任务未完成', '桌面任务已停止']);
  assert.match(fx.cards[1]!.card.text, /本轮已停止/); assert.doesNotMatch(fx.cards[1]!.card.text, /无关任务/);
});

test('ephemeral or subagent threads and standalone runtimes do not trigger automatic notifications', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  fx.runtime.threadInfo = async threadId => ({ threadId, cwd: fx.dir, title: '内部任务', isUserThread: false });
  fx.completed(); await settle(fx.bridge); assert.equal(fx.cards.length, 0);
  Object.defineProperty(fx.runtime, 'supportsSteering', { value: false });
  fx.runtime.threadInfo = async threadId => ({ threadId, cwd: fx.dir, title: '独立任务', isUserThread: true });
  fx.completed(); await settle(fx.bridge); assert.equal(fx.cards.length, 0);
});

test('registered automatic notifications recover after restart and stay deduplicated', async t => {
  const fx = fixture(t); fx.store.saveConfig({ autoNotifyDesktop: true });
  fx.emit('turn/started', 'inProgress'); await settle(fx.bridge);
  const restored = new Bridge(new Store(fx.dir), fx.runtime, fx.discovery); restored.transport = fx.transport;
  await restored.deliverPendingNotifications(); await restored.deliverPendingNotifications();
  assert.equal(fx.cards.length, 1);
  assert.equal(Object.values(restored.store.state.notifications)[0]?.status, 'sent');
});
