import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { conversationKey, namespaceMessage } from '../src/routing.js';
import type { CodexRunInput, CodexRuntime, MessageCard, RuntimeEvent } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-routing-regression-'));
  const store = new Store(dir);
  store.saveConfig({ defaultWorkspace: dir, enabled: true, allowedActors: ['ou_one', 'ou_two'], allowedGroups: ['oc_team', 'oc_second'], progress: false });
  store.saveBot('dev', { name: '开发', enabled: true, allowedActors: ['ou_one', 'ou_two'], allowedGroups: ['oc_team', 'oc_second'], roleInstructions: '开发角色' });
  const sent: Array<{ chatId: string; card?: MessageCard; file?: string }> = [];
  const runs: CodexRunInput[] = [];
  const stops: string[] = [];
  let listener: ((event: RuntimeEvent) => void) | undefined;
  let available = true;
  let runner: CodexRuntime['run'] = async input => {
    const threadId = input.threadId || `thread-${runs.length}`;
    input.onThread?.(threadId);
    input.onSubmitted?.({ threadId, turnId: `turn-${runs.length}`, mode: 'start', status: 'submitted' });
    return { threadId, turnId: `turn-${runs.length}`, text: '正常回复' };
  };
  let sendFile: (chatId: string, file: string) => Promise<string> = async (chatId, file) => { sent.push({ chatId, file }); return randomUUID(); };
  let closeRuntime: () => Promise<void> = async () => {};
  const runtime: CodexRuntime = {
    supportsSteering: true,
    async run(input) { runs.push(input); return runner(input); }, async stop(threadId) { stops.push(threadId); }, async release() {},
    async close() { await closeRuntime(); }, async models() { return []; }, async history() { return []; }, async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '桌面继续的任务', isUserThread: true }; },
    async turnStatus() { return 'completed'; },
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  const bridge = new Bridge(store, runtime, { async projects() { return []; }, async threads(cwd) { return Object.keys(store.state.threadBindings).map(id => ({ id, cwd, title: id, preview: '', updatedAt: '' })); } });
  bridge.transport = {
    async start() {}, async close() {}, isAvailable: () => available,
    async sendText(chatId, text) { sent.push({ chatId, card: { title: '', text } }); return randomUUID(); },
    async sendCard(chatId, card) { sent.push({ chatId, card }); return randomUUID(); },
    sendFile: (chatId, file) => sendFile(chatId, file), async sendImage(chatId, file) { return sendFile(chatId, file); },
    async updateCard() {}, async startTyping() { return async () => {}; },
  };
  const send = (botId: string, text: string, actorId = 'ou_one', chatId = 'oc_team') => bridge.receive(namespaceMessage(botId, { id: randomUUID(), chatId, chatType: 'group', actorId, text }));
  const emit = (event: RuntimeEvent) => listener?.(event);
  const settle = async () => { for (let i = 0; i < 100 && bridge.hasActiveWork(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(bridge.hasActiveWork(), false); };
  t.after(async () => { await bridge.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('group-routing-regression-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, bridge, sent, runs, stops, send, emit, settle, runWith(fn: typeof runner) { runner = fn; }, filesWith(fn: typeof sendFile) { sendFile = fn; }, available(value: boolean) { available = value; }, onClose(fn: typeof closeRuntime) { closeRuntime = fn; } };
}

test('public context is scoped to the group even when both groups share a workspace', async t => {
  const h = fixture(t);
  await h.send('default', '只属于第一组的方案');
  await h.send('dev', '第二组的问题', 'ou_one', 'oc_second');
  assert.doesNotMatch(h.runs[1]!.prompt, /只属于第一组/);
  await h.send('dev', '继续第一组');
  assert.match(h.runs[2]!.prompt, /只属于第一组/);
  assert.doesNotMatch(h.runs[2]!.prompt, /第二组的问题/);
});

test('notification recipient is captured before another member becomes the latest speaker', async t => {
  const h = fixture(t);
  await h.send('default', '原始任务');
  const threadId = h.store.conversation('oc_team').threadId!;
  h.emit({ method: 'item/completed', threadId, turnId: 'desktop-followup', params: { item: {
    type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification', status: 'completed', arguments: { summary: '完成后通知' },
  } } });
  await h.settle();
  const notification = Object.values(h.store.state.notifications)[0]!;
  assert.equal(notification.actorId, 'ou_one');
  await h.send('default', '/status', 'ou_two');
  assert.equal(h.store.conversation('oc_team').actorId, 'ou_two');
  h.store.authorize('ou_one', false);
  h.emit({ method: 'turn/completed', threadId, turnId: 'desktop-followup', params: { turn: { status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '敏感结果' }] } } });
  await h.settle();
  assert.equal(h.sent.some(item => item.card?.title === '桌面任务已完成'), false);
  assert.equal(notification.actorId, 'ou_one');
});

test('registered offline files keep their original bot and group after the current conversation changes', async t => {
  const h = fixture(t);
  await h.send('dev', '准备文件');
  const route = conversationKey('dev', 'oc_team');
  const threadId = h.store.conversation(route).threadId!;
  const file = path.join(h.dir, 'delivery.txt'); fs.writeFileSync(file, '文件内容');
  h.available(false);
  h.emit({ method: 'item/completed', threadId, turnId: 'desktop-artifact', params: { item: {
    id: 'file-call', type: 'mcpToolCall', server: 'feishu_completion', tool: 'send_artifact_to_feishu', status: 'completed', arguments: { paths: [file] },
  } } });
  await h.settle();
  const delivery = Object.values(h.store.state.artifacts)[0]!;
  assert.equal(delivery.status, 'registered');
  await h.bridge.newConversation(route);
  h.store.conversation(conversationKey('dev', 'oc_second'), 'ou_two', h.dir, 'group');
  h.available(true);
  await h.bridge.deliverPendingArtifacts();
  assert.equal(delivery.chatId, route);
  assert.deepEqual(h.sent.filter(item => item.file).map(item => item.chatId), [route]);
});

test('revoking group authorization during an upload prevents subsequent files and the summary card', async t => {
  const h = fixture(t);
  await h.send('dev', '准备文件');
  const route = conversationKey('dev', 'oc_team');
  const threadId = h.store.conversation(route).threadId!;
  const files = ['one.txt', 'two.txt'].map(name => { const file = path.join(h.dir, name); fs.writeFileSync(file, name); return file; });
  const first = deferred();
  const release = deferred();
  h.filesWith(async (chatId, file) => { h.sent.push({ chatId, file }); if (file === files[0]) { first.resolve(); await release.promise; } return randomUUID(); });
  h.emit({ method: 'item/completed', threadId, turnId: 'desktop-artifact-revoke', params: { item: {
    id: 'files-revoke', type: 'mcpToolCall', server: 'feishu_completion', tool: 'send_artifact_to_feishu', status: 'completed', arguments: { paths: files },
  } } });
  await first.promise;
  h.store.authorizeGroup('dev', 'oc_team', false);
  release.resolve();
  await h.settle();
  assert.deepEqual(h.sent.filter(item => item.file).map(item => item.file), [files[0]]);
  assert.equal(h.sent.some(item => item.card?.title.includes('成品')), false);
});

test('a new group thread waits for the previous thread in that same chat to release the project', async t => {
  const h = fixture(t);
  const finished = deferred();
  h.runWith(async input => {
    const number = h.runs.length; const threadId = input.threadId || `thread-${number}`;
    input.onThread?.(threadId);
    if (number === 1) await finished.promise;
    return { threadId, text: '完成' };
  });
  const first = h.send('default', '旧任务'); await tick();
  await h.bridge.newConversation('oc_team');
  const second = h.send('default', '新任务'); await tick();
  try { assert.equal(h.runs.length, 1); }
  finally { finished.resolve(); await Promise.all([first, second]); }
  assert.equal(h.runs.length, 2);
});

test('stopping an actor only cancels requests for the chosen bot', async t => {
  const h = fixture(t); const done = deferred();
  h.runWith(async input => { const threadId = input.threadId || `thread-${h.runs.length}`; input.onThread?.(threadId); await done.promise; return { threadId, text: '完成' }; });
  const first = h.send('default', '产品执行'); await tick();
  const second = h.send('dev', '开发等待'); await tick();
  h.store.authorize('ou_one', false, 'dev');
  await h.bridge.stopActor('ou_one', 'dev');
  await second;
  assert.equal(h.stops.includes('thread-1'), false);
  assert.equal(h.runs.length, 1);
  done.resolve(); await first;
});

test('closing cancels a waiting group request without starting it after the active runtime exits', async t => {
  const h = fixture(t); const done = deferred();
  h.onClose(async () => { done.resolve(); });
  h.runWith(async input => { input.onThread?.('thread-active'); await done.promise; return { threadId: 'thread-active', text: '已关闭' }; });
  const first = h.send('default', '执行'); await tick();
  const second = h.send('dev', '等待'); await tick();
  await h.bridge.close();
  await Promise.all([first, second]);
  assert.equal(h.runs.length, 1);
  assert.equal(h.bridge.hasActiveWork(), false);
});
