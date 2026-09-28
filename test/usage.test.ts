import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { formatUsage } from '../src/usage.js';
import type { CodexRuntime, CodexUsage, MessageCard, UsageLimit } from '../src/types.js';

const limit = (patch: Partial<UsageLimit> = {}): UsageLimit => ({
  id: 'codex', name: null, planType: 'pro',
  primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: Date.parse('2026-09-25T06:30:00Z') / 1000 },
  secondary: null, credits: null, ...patch,
});
const usage = (patch: Partial<CodexUsage> = {}): CodexUsage => ({
  accountType: 'chatgpt', planType: 'pro', limits: [limit()], resetCredits: 3,
  ordinaryUsageAllowed: true, fetchedAt: '2026-09-25T05:20:00Z', ...patch,
});

test('weekly primary is labelled by duration and timestamps use Beijing time', () => {
  const text = formatUsage(usage());
  assert.match(text, /ChatGPT Pro/);
  assert.match(text, /周额度：剩余 \*\*15%\*\*/);
  assert.match(text, /2026\/09\/25 14:30/);
  assert.match(text, /2026\/09\/25 13:20/);
  assert.match(text, /可用额度重置：3 次/);
  assert.doesNotMatch(text, /5 小时/);
});

test('multiple buckets retain each window and clamp remaining percentage', () => {
  const text = formatUsage(usage({ limits: [
    limit({ primary: { usedPercent: 28.35, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 150, windowDurationMins: 10080, resetsAt: null } }),
    limit({ id: 'review', name: 'Code review', primary: { usedPercent: -1, windowDurationMins: 1440, resetsAt: null } }),
    limit({ id: 'other', primary: { usedPercent: 2, windowDurationMins: 15, resetsAt: null } }),
  ] }));
  assert.match(text, /5 小时额度：剩余 \*\*71.7%\*\*/);
  assert.match(text, /周额度：剩余 \*\*0%\*\*/);
  assert.match(text, /\*\*Code review\*\*/);
  assert.match(text, /1 天额度：剩余 \*\*100%\*\*/);
  assert.match(text, /15 分钟额度：剩余 \*\*98%\*\*/);
});

test('missing and nonfinite numbers never imply zero or full availability', () => {
  const text = formatUsage(usage({ limits: [limit({
    primary: { usedPercent: null, windowDurationMins: null, resetsAt: null },
    secondary: { usedPercent: NaN, windowDurationMins: Infinity, resetsAt: Infinity },
  })], resetCredits: null, ordinaryUsageAllowed: null }));
  assert.match(text, /主额度：剩余 未知/);
  assert.match(text, /次额度：剩余 未知/);
  assert.match(text, /重置时间：暂未返回/);
  assert.doesNotMatch(text, /0%|100%|可用额度重置|额外 Credits|套餐内用量暂不可用/);
  assert.match(formatUsage(usage({ limits: [] })), /暂未返回额度数据/);
  assert.match(formatUsage(usage({ limits: [limit({ primary: null })] })), /暂未返回额度窗口/);
});

test('credits and server availability are reported only as returned', () => {
  const text = formatUsage(usage({ limits: [
    limit({ credits: { hasCredits: false, unlimited: false, balance: '0' } }),
    limit({ id: 'unlimited', credits: { hasCredits: true, unlimited: true, balance: null } }),
    limit({ id: 'unknown-balance', credits: { hasCredits: true, unlimited: false, balance: null } }),
  ], ordinaryUsageAllowed: false }));
  assert.match(text, /额外 Credits：0/);
  assert.match(text, /额外 Credits：不限额/);
  assert.match(text, /可用，余额暂未返回/);
  assert.match(text, /当前套餐内用量暂不可用/);
});

test('unsupported account modes explain why ChatGPT quota is unavailable', () => {
  assert.match(formatUsage(usage({ accountType: 'notLoggedIn' })), /尚未登录/);
  assert.match(formatUsage(usage({ accountType: 'apiKey' })), /API Key/);
  assert.match(formatUsage(usage({ accountType: 'amazonBedrock' })), /Amazon Bedrock/);
});

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ allowedActors: ['alice'], defaultWorkspace: dir });
  const conversation = store.conversation('chat', 'alice', dir);
  conversation.threadId = 'bound-thread';
  const cards: Array<{ messageId?: string; card: MessageCard }> = [];
  let queries = 0;
  let runs = 0;
  let writes = 0;
  const runtime: CodexRuntime = {
    async usage() { queries++; return usage(); },
    async run() { runs++; throw new Error('Command must not start a turn'); },
    async stop() {}, async release() {}, async close() {}, async models() { return []; },
    async history() { return []; }, async status() { return { available: true }; },
  };
  const bridge = new Bridge(store, runtime, {
    async projects() { return []; }, async threads() { return []; },
    assertCanWrite() { writes++; throw new Error('Desktop state does not permit writes'); },
  });
  bridge.transport = {
    async start() {}, async close() {}, async sendText() { return 'text'; },
    async sendCard(_chatId, card) { cards.push({ card }); return 'usage-card'; },
    async sendImage() { return 'image'; }, async sendFile() { return 'file'; },
    async updateCard(messageId, card) { cards.push({ messageId, card }); },
    async startTyping() { return async () => {}; },
  };
  const send = (text: string, extra = {}) => bridge.receive({ id: randomUUID(), chatId: 'chat', actorId: 'alice', text, ...extra });
  return { bridge, runtime, store, cards, send, counts: () => ({ queries, runs, writes }) };
}

test('usage bypasses turn execution and write guard while preserving binding', async t => {
  const { send, counts, cards, store } = fixture(t);
  const binding = structuredClone(store.state.conversations.chat);
  await send('/usage');
  assert.deepEqual(counts(), { queries: 1, runs: 0, writes: 0 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.card.title, 'Codex 套餐余量');
  assert.equal(store.state.conversations.chat!.threadId, binding!.threadId);
  assert.equal(store.state.conversations.chat!.cwd, binding!.cwd);
  assert.equal(store.state.conversations.chat!.revision, binding!.revision);
});

test('quota refresh updates its card and unauthorized users cannot query', async t => {
  const { send, counts, cards } = fixture(t);
  await send('/usage');
  assert.equal(cards.at(-1)!.card.buttons![0]!.command, '/usage');
  await send('/usage', { actionMessageId: 'usage-card' });
  assert.equal(cards.at(-1)!.messageId, 'usage-card');
  await send('/usage', { actorId: 'stranger' });
  assert.equal(counts().queries, 2);
});

test('arguments never perform resets and help exposes quota command', async t => {
  const { send, counts, cards } = fixture(t);
  await send('/usage reset');
  assert.equal(counts().queries, 0);
  assert.match(cards.at(-1)!.card.text, /直接发送 \/usage/);
  await send('/help');
  assert.match(cards.at(-1)!.card.text, /\/usage 查看套餐余量/);
  assert.doesNotMatch(cards.at(-1)!.card.text, /\/quota|\/balance|\/bal\b/);
});

test('query failure produces an error instead of stale or fabricated quota', async t => {
  const { send, runtime, cards } = fixture(t);
  runtime.usage = async () => { throw new Error('后台连接超时'); };
  await send('/usage');
  assert.match(cards.at(-1)!.card.text, /后台连接超时/);
  assert.doesNotMatch(cards.at(-1)!.card.text, /剩余|100%|0%/);
  delete runtime.usage;
  await send('/usage');
  assert.match(cards.at(-1)!.card.text, /暂不支持/);
});

test('query is available while a model turn is running without steering or interrupting it', async t => {
  const { runtime, bridge, store, cards } = fixture(t);
  const activeBridge = new Bridge(store, runtime, { async projects() { return []; }, async threads() { return []; } });
  activeBridge.transport = bridge.transport;
  let finish!: () => void;
  let stops = 0;
  runtime.stop = async () => { stops++; };
  runtime.run = async input => {
    input.onThread?.('bound-thread');
    await new Promise<void>(resolve => { finish = resolve; });
    return { threadId: 'bound-thread', text: 'done' };
  };
  const turn = activeBridge.receive({ id: randomUUID(), chatId: 'chat', actorId: 'alice', text: 'long task' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(activeBridge.hasActiveWork(), true);
  try {
    await activeBridge.receive({ id: randomUUID(), chatId: 'chat', actorId: 'alice', text: '/usage' });
    assert.equal(activeBridge.hasActiveWork(), true);
    assert.equal(stops, 0);
    assert.ok(cards.some(entry => entry.card.title === 'Codex 套餐余量'));
  } finally { finish(); await turn; }
});
