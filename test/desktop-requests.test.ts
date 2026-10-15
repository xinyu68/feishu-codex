import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import type { CodexRuntime, DesktopRuntimeRequest, RuntimeAnswer, RuntimeEvent, MessageCard } from '../src/types.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n=0;n<50&&!check();n++) await tick(); assert.ok(check()); }
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-requests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir); store.saveConfig({ appId: 'cli_fixture', appSecret: 'fixture-only', allowedActors: ['ou_owner'] });
  Object.assign(store.conversation('oc_owner', 'ou_owner'), { threadId: 'existing', title: '原会话' });
  let handler: ((event: DesktopRuntimeRequest) => Promise<RuntimeAnswer | undefined>) | undefined;
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const cards: MessageCard[] = [], updates: MessageCard[] = [];
  const runtime: CodexRuntime = {
    supportsSteering: true,
    subscribeDesktopRequests(fn) { handler = fn; return () => { handler = undefined; }; },
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    async run() { throw Error('Do not submit a task'); }, async stop() {}, async release() {}, async close() {}, async models() { return []; }, async history() { return []; },
    async status() { return { available: true }; }, async threadInfo(threadId) { return { threadId, cwd: dir, title: '待审批的桌面会话', isUserThread: true }; }
  };
  const bridge = new Bridge(store, runtime, { projects: async () => [], threads: async () => [] });
  bridge.transport = { async start() {}, async close() {}, async startTyping() { return async () => {}; }, async sendText() { return ''; },
    async sendImage() { return ''; }, async sendFile() { return ''; }, async sendCard(_chat, card) { cards.push(card); return 'card'; }, async updateCard(_id, card) { updates.push(card); } };
  t.after(() => bridge.close());
  const controller = new AbortController();
  const event: DesktopRuntimeRequest = { threadId: 'desktop', turnId: 'turn', signal: controller.signal, cancel: reason => controller.abort(reason),
    request: { id: 'native-request', kind: 'approval', title: 'approve', text: '运行测试命令' } };
  return { store, bridge, cards, updates, controller, request: () => handler!(event), emit: (e: RuntimeEvent) => listener?.(e) };
}
test('desktop approval uses the default recipient, verifies the actor and leaves the chat binding unchanged', async t => {
  const f = fixture(t); const result = f.request(); await until(() => f.cards.length === 1);
  const pending = f.bridge.pendingRequests()[0]!;
  assert.match(f.cards[0]!.text, /待审批的桌面会话/);
  await assert.rejects(f.bridge.answer(pending.id, { decision: 'accept' }, { chatId: 'oc_owner', actorId: 'ou_other' }), /不属于/);
  await f.bridge.answer(pending.id, { decision: 'accept' }, { chatId: 'oc_owner', actorId: 'ou_owner' });
  assert.deepEqual(await result, { decision: 'accept' });
  await f.bridge.answer(pending.id, { decision: 'accept' }, { chatId: 'oc_owner', actorId: 'ou_owner' });
  assert.equal(f.store.conversation('oc_owner').threadId, 'existing'); assert.equal(f.bridge.pendingRequests().length, 0);
  assert.equal(f.updates.at(-1)?.title, '已同意'); assert.equal(f.updates.at(-1)?.buttons, undefined);
});
test('a request answered on the desktop expires its Feishu card', async t => {
  const f = fixture(t); const result = f.request(); await until(() => f.cards.length === 1);
  f.controller.abort('已在其他入口处理或任务已结束'); await result;
  assert.equal(f.bridge.pendingRequests().length, 0); assert.match(f.updates.at(-1)?.title ?? '', /其他入口/);
  assert.equal(f.updates.at(-1)?.buttons, undefined);
});
test('turning forwarding off cancels pending desktop cards without choosing a native decision', async t => {
  const f = fixture(t); const result = f.request(); await until(() => f.cards.length === 1);
  f.store.saveConfig({ notifyDesktopRequests: false }); await result;
  assert.equal(f.controller.signal.aborted, true); assert.equal(f.bridge.pendingRequests().length, 0);
  assert.equal(await f.request(), undefined); assert.equal(f.cards.length, 1);
});
test('passive cached busy state is not bridge-owned work for shutdown', async t => {
  const f = fixture(t);
  f.emit({ method: 'turn/started', threadId: 'existing', turnId: 'old', params: { turn: { id: 'old' } } });
  await until(() => f.bridge.conversations()[0]!.busy);
  for(let n=0;n<5;n++) await tick();
  assert.equal(f.bridge.shutdownState().conversations[0]!.busy, false);
  assert.equal(f.bridge.shutdownState().activeWork, false);
});
