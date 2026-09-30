import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { RuntimeRouter } from '../src/runtime-router.js';
import { conversationKey, namespaceMessage } from '../src/routing.js';
import type { CodexRunInput, CodexRuntime, InboundMessage, RuntimeConsultInput, MessageCard } from '../src/types.js';

test('delegated task approvals and questions use the target bot and originating actor', async t => {
  const h = setup(t), targetChat = conversationKey('pm', 'oc_team');
  h.consultWith(async input => {
    for (const kind of ['approval', 'question'] as const) {
      const waiting = input.onRequest!({ id: 'native-id', kind, title: '请确认', text: '执行委派任务',
        ...(kind === 'question' ? { questions: [{ id: 'detail', question: '哪个文件？' }] } : {}) });
      const pending = h.bridge.pendingRequests()[0]!;
      assert.equal(pending.chatId, targetChat); assert.equal(pending.actorId, 'target-user');
      assert.match(pending.title, /产品经理/);
      await assert.rejects(h.bridge.answer(pending.id, { decision: 'accept' }, { chatId: targetChat, actorId: 'source-user' }), /不属于/);
      const answer = kind === 'approval' ? { decision: 'accept' as const } : { answers: { detail: { answers: ['README.md'] } } };
      await h.bridge.receive(h.message('pm', { text: kind === 'approval' ? `/approve ${pending.id}` : `/answer ${pending.id} README.md` }));
      assert.deepEqual(await waiting, answer);
      assert.equal(h.bridge.pendingRequests().length, 0);
    }
    return { text: '已完成委派任务' };
  });
  h.runWith(async (_input, prompt) => (await h.ask(prompt)).answer);
  await h.bridge.receive(h.message());
  assert.ok(h.replies.includes('已完成委派任务'));
});

test('cancelling a delegated task closes its approval without accepting it', async t => {
  const h = setup(t), controller = new AbortController();
  h.consultWith(async input => {
    const waiting = input.onRequest!({ id: 'native-id', kind: 'approval', title: '审批', text: '执行任务' });
    assert.equal(h.bridge.pendingRequests().length, 1);
    controller.abort();
    assert.deepEqual(await waiting, { decision: 'decline', answers: {} });
    assert.equal(h.bridge.pendingRequests().length, 0);
    return { text: '取消后不得发布' };
  });
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.bridge.consultInGroup({ context_token: h.token(prompt), target: '产品经理', question: '执行任务' }, controller.signal), /取消/);
    return '已取消';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.replies.includes('取消后不得发布'), false);
});

test('an approval cannot authorize a delegated task after the target context changed', async t => {
  const h = setup(t), targetChat = conversationKey('pm', 'oc_team');
  h.consultWith(async input => {
    const waiting = input.onRequest!({ id: 'native-id', kind: 'approval', title: '审批', text: '执行任务' });
    const pending = h.bridge.pendingRequests()[0]!;
    h.store.conversation(targetChat, 'target-user', h.dir, 'group').revision = 2;
    await assert.rejects(h.bridge.answer(pending.id, { decision: 'accept' }, { chatId: targetChat, actorId: 'target-user' }), /已失效/);
    assert.deepEqual(await waiting, { decision: 'decline', answers: {} });
    return { text: '不得发布' };
  });
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.ask(prompt));
    return '上下文改变';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.bridge.pendingRequests().length, 0);
  assert.equal(h.replies.includes('不得发布'), false);
});

test('Hermes consultation artifacts use the target bot and original group once without binding its ordinary conversation', async t => {
  const h = setup(t), targetChat = conversationKey('pm', 'oc_team');
  const files = [path.join(h.dir, 'image.png'), path.join(h.dir, 'report.txt')];
  for (const file of files) fs.writeFileSync(file, 'explicit artifact');
  const sends: Array<{ chatId: string; file: string; kind: string }> = [];
  h.bridge.transport!.sendImage = async (chatId, file) => { sends.push({ chatId, file, kind: 'image' }); return 'image'; };
  h.bridge.transport!.sendFile = async (chatId, file) => { sends.push({ chatId, file, kind: 'file' }); return 'file'; };
  h.consultWith(async input => {
    const receipt = { threadId: 'hermes:consultation-1', turnId: 'hermes-turn:artifact', itemId: 'artifact-call', paths: files };
    await input.onArtifact!(receipt);
    await input.onArtifact!(receipt);
    assert.equal(sends.length, 2, 'file delivery is awaited and duplicate callbacks cannot reupload');
    assert.equal(Object.values(h.store.state.artifacts)[0]?.status, 'sent');
    return { text: '文件请求已处理' };
  });
  h.runWith(async (_input, prompt) => (await h.ask(prompt)).answer);
  await h.bridge.receive(h.message());
  const canonicalFiles = await Promise.all(files.map(file => fs.promises.realpath(file)));
  assert.deepEqual(sends, canonicalFiles.map((file, index) => ({ chatId: targetChat, file, kind: index === 0 ? 'image' : 'file' })));
  assert.equal(h.store.state.conversations[targetChat], undefined);
  assert.equal(h.store.state.threadBindings['hermes:consultation-1'], undefined, 'artifact routing does not rebind the ordinary chat');
});

test('Hermes consultation cannot send an artifact after the original group or actor is no longer authorized', async t => {
  const h = setup(t);
  const file = path.join(h.dir, 'report.txt'); fs.writeFileSync(file, 'explicit artifact');
  let sends = 0;
  h.bridge.transport!.sendFile = async () => { sends++; return 'file'; };
  h.consultWith(async input => {
    h.store.saveBot('pm', { allowedActors: [] });
    await assert.rejects(input.onArtifact!({ threadId: 'hermes:consultation-1', turnId: 'hermes-turn:revoked', itemId: 'artifact', paths: [file] }));
    return { text: '不得发送' };
  });
  h.runWith(async (_input, prompt) => { await assert.rejects(h.ask(prompt)); return '未发送文件'; });
  await h.bridge.receive(h.message());
  assert.equal(sends, 0);
  assert.equal(Object.keys(h.store.state.artifacts).length, 0);
});

function setup(t: test.TestContext, sourceEngine: 'codex' | 'hermes' = 'codex', targetEngine: 'codex' | 'hermes' = 'hermes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-consult-bridge-'));
  const store = new Store(dir);
  store.saveConfig({ engine: sourceEngine, enabled: true, appId: 'cli_source', allowedActors: ['source-user'], allowedGroups: ['oc_team'],
    defaultWorkspace: dir, botName: '开发人员', progress: false });
  store.saveBot('pm', { enabled: true, appId: 'cli_target', name: '产品经理', engine: targetEngine,
    allowedActors: ['target-user'], allowedGroups: ['oc_team'], roleInstructions: '梳理验收要求', model: 'target-model', effort: 'high' });
  store.rememberBotIdentity('pm', { openId: 'ou_target', name: '产品经理' });
  const replies: string[] = [], runs: CodexRunInput[] = [], consults: Array<RuntimeConsultInput & { actualEngine: string }> = [];
  const cards: Array<{ chatId: string; id: string; card: MessageCard }> = [];
  let sourceRun: (input: CodexRunInput, prompt: string) => Promise<string> = async () => '已完成';
  let targetRun: (input: RuntimeConsultInput) => Promise<{ text: string }> = async () => ({ text: '产品建议：防止重复提交' });
  let runtimeStatus: (engine: string) => ReturnType<CodexRuntime['status']> = async () => ({ available: true });
  const makeRuntime = (engine: string): CodexRuntime => { let consultCount = 0; return ({
    supportsSteering: engine === 'codex',
    async run(input) {
      runs.push(input); const threadId = input.threadId ?? `${engine === 'hermes' ? 'hermes:' : ''}source-${runs.length}`;
      const turnId = `turn-source-${runs.length}`;
      await input.onBeforeSubmit?.(); input.onThread?.(threadId);
      const prompt = await input.preparePrompt?.(threadId, { compactChannelHeader: true }) ?? input.prompt;
      input.onSubmitted?.({ threadId, turnId, mode: 'start', status: 'submitted' });
      return { threadId, turnId, text: await sourceRun(input, prompt) };
    },
    async consult(input) {
      await input.onBeforeSubmit?.(); consults.push({ ...input, actualEngine: engine });
      return { threadId: input.threadId ?? `${engine === 'hermes' ? 'hermes:' : ''}consultation-${++consultCount}`, ...await targetRun(input) };
    },
    async stop() {}, async release() {}, async close() {}, async updateGroupHandoffPolicy() {},
    async models() { return []; }, async history() { throw new Error('No native history should be read for consultation'); },
    async status() { return runtimeStatus(engine); },
  }); };
  const bridge = new Bridge(store, new RuntimeRouter(makeRuntime('codex'), makeRuntime('hermes')), {
    projects: async () => [],
    threads: async cwd => Object.entries(store.state.threadBindings).filter(([id, binding]) =>
      !id.startsWith('hermes:') && binding.cwd === cwd).map(([id, binding]) => ({
      id, cwd, title: binding.title || '会话', preview: binding.preview || '', updatedAt: binding.updatedAt || '',
    })),
  });
  bridge.transport = { isAvailable: () => true, async start() {}, async close() {}, async startTyping() { return async () => {}; },
    async sendCard(chatId, card) { const id = `om_${randomUUID()}`; replies.push(card.text); cards.push({ chatId, id, card }); return id; },
    async sendText(_chat, text) { replies.push(text); return 'om_reply'; },
    async sendImage() { return 'om_image'; }, async sendFile() { return 'om_file'; },
    async updateCard(id, card) { const entry = cards.find(item => item.id === id); assert.ok(entry); entry.card = card; },
  };
  const message = (botId = 'default', overrides: Partial<InboundMessage> = {}) => namespaceMessage(botId, {
    id: `om_${randomUUID()}`, chatId: 'oc_team', actorId: botId === 'default' ? 'source-user' : 'target-user',
    chatType: 'group', actorTenantKey: 'tenant', actorUnionId: 'same-human', text: '请咨询产品后给我结论', ...overrides,
  });
  store.observeGroup(message()); store.observeGroup(message('pm'));
  const token = (prompt: string) => /context_token: (fc1\.\d+\.[a-f0-9]{64})/.exec(prompt)?.[1] ?? '';
  const ask = (prompt: string, overrides = {}) => bridge.consultInGroup({ context_token: token(prompt), target: '产品经理', question: '登录需要哪些校验？', context: '只讨论登录页。', ...overrides });
  t.after(async () => { await bridge.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('group-consult-bridge-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, bridge, dir, replies, cards, runs, consults, message, ask, token,
    statusWith: (status: typeof runtimeStatus) => { runtimeStatus = status; },
    runWith: (run: typeof sourceRun) => { sourceRun = run; }, consultWith: (run: typeof targetRun) => { targetRun = run; } };
}

for (const engines of [['codex', 'hermes'], ['hermes', 'codex'], ['codex', 'codex'], ['hermes', 'hermes']] as const) {
  test(`${engines[0]} consults ${engines[1]} which replies publicly before the source continues its original turn`, async t => {
    const h = setup(t, ...engines); let usedToken = '';
    const targetKey = conversationKey('pm', 'oc_team');
    const before = h.store.state.conversations[targetKey];
    h.runWith(async (_input, prompt) => {
      usedToken = h.token(prompt); assert.ok(usedToken);
      const result = await h.ask(prompt, { context: `参考资料 ${usedToken}` });
      assert.equal(h.cards.length, 2); assert.equal(h.runs.length, 1);
      assert.equal(h.cards[0]!.chatId, 'oc_team');
      assert.ok(h.cards[0]!.card.text.includes('登录需要哪些校验？'));
      assert.deepEqual(h.cards[0]!.card.mention, { openId: 'ou_target' });
      assert.equal(h.cards[1]!.chatId, targetKey); assert.equal(result.groupReply, 'sent');
      return `结合产品意见：${result.answer}`;
    });
    await h.bridge.receive(h.message());
    assert.equal(h.consults.length, 1); assert.equal(h.consults[0]!.actualEngine, engines[1]);
    assert.equal(h.consults[0]!.cwd, h.dir); assert.match(h.consults[0]!.roleInstructions!, /产品经理/);
    assert.ok(!h.consults[0]!.prompt.includes(usedToken));
    assert.equal(h.store.state.conversations[targetKey], before, 'consultation must not create or switch the normal target conversation');
    assert.equal(Object.keys(h.store.state.threadBindings).length, 1);
    assert.equal(h.cards.length, 3);
    assert.deepEqual(h.replies.slice(1), ['产品建议：防止重复提交', '结合产品意见：产品建议：防止重复提交']);
    const recorded = h.store.state.groupMessages.oc_team!.find(item => item.role === 'assistant' && item.botId === 'pm');
    assert.equal(recorded?.sender, '产品经理');
    assert.equal(recorded?.threadId, engines[1] === 'hermes' ? 'hermes:consultation-1' : 'consultation-1');
    await assert.rejects(h.bridge.consultInGroup({ context_token: usedToken, target: '产品经理', question: '旧轮' }), /没有可用/);
  });
}

test('private chat and local preview never receive group consultation capabilities', async t => {
  const h = setup(t);
  h.runWith(async (_input, prompt) => { assert.equal(h.token(prompt), ''); return '普通回复'; });
  await h.bridge.receive(h.message('default', { chatType: 'p2p', chatId: 'oc_private' }));
  h.store.conversation('oc_team', 'source-user', h.dir, 'group');
  await h.bridge.receive(h.message('default', { localOnly: true }));
  assert.equal(h.consults.length, 0);
});

test('two sequential consultations publish two target answers while preserving the single source turn', async t => {
  const h = setup(t, 'codex', 'hermes'); let count = 0;
  h.consultWith(async () => ({ text: ++count === 1 ? '1 + 1 = 2' : '2 × 2 = 4' }));
  h.runWith(async (_input, prompt) => {
    const first = await h.ask(prompt, { question: '1 + 1？' });
    assert.equal(first.answer, '1 + 1 = 2');
    const replay = await h.ask(prompt, { question: '1 + 1？' });
    assert.deepEqual(replay, first); assert.equal(h.cards.length, 2);
    const second = await h.ask(prompt, { question: '把刚才的结果乘 2' });
    assert.equal(second.answer, '2 × 2 = 4'); assert.equal(h.cards.length, 4);
    assert.equal(h.runs.length, 1); return '咨询结束';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.consults.length, 2);
  assert.equal(h.consults[0]!.threadId, undefined);
  assert.equal(h.consults[1]!.threadId, 'hermes:consultation-1');
  assert.equal(h.consults[1]!.persistent, true);
  assert.ok(!h.consults[1]!.prompt.includes('1 + 1 = 2'), 'a resumed native session must not duplicate earlier answers');
  assert.deepEqual(h.cards.map(item => item.chatId), ['oc_team', conversationKey('pm', 'oc_team'), 'oc_team', conversationKey('pm', 'oc_team'), 'oc_team']);
  assert.ok(h.cards[0]!.card.text.includes('1 + 1？'));
  assert.ok(h.cards[2]!.card.text.includes('把刚才的结果乘 2'));
  assert.ok(!h.cards[2]!.card.text.includes('1 + 1 = 2'), 'follow-up history must not be published with the question');
  assert.deepEqual(h.cards.filter((_, index) => index % 2 === 1 || index === 4).map(item => item.card.text), ['1 + 1 = 2', '2 × 2 = 4', '咨询结束']);
});

test('consultation resumes across turns but resets when either group conversation starts anew', async t => {
  const h = setup(t, 'codex', 'hermes');
  h.runWith(async (_input, prompt) => (await h.ask(prompt, { question: `问题 ${h.runs.length}` })).answer);
  await h.bridge.receive(h.message());
  await h.bridge.receive(h.message());
  assert.deepEqual(h.consults.map(item => item.threadId), [undefined, 'hermes:consultation-1']);
  assert.equal(h.runs[1]!.threadId, h.runs[0]!.threadId || 'source-1');
  const restored = new Store(h.dir);
  assert.equal(Object.keys(restored.state.consultationSessions).length, 1, 'consultation identity survives a bridge restart');
  assert.equal(restored.isConsultationThread('hermes:consultation-1'), true, 'restored consultation stays out of ordinary session discovery');
  await h.bridge.newConversation(conversationKey('default', 'oc_team'));
  await h.bridge.receive(h.message());
  assert.equal(h.consults[2]!.threadId, undefined, 'source /new starts a separate consultation');
  await h.bridge.bind(conversationKey('default', 'oc_team'), h.dir, 'source-1');
  await h.bridge.receive(h.message());
  assert.equal(h.consults[3]!.threadId, 'hermes:consultation-1', 'switching back resumes the earlier consultation');
  await h.bridge.newConversation(conversationKey('pm', 'oc_team'));
  await h.bridge.receive(h.message());
  assert.equal(h.consults[4]!.threadId, undefined, 'target /new starts a separate consultation');
});

test('returning to a target group thread restores its consultation despite a newer binding revision', async t => {
  const h = setup(t, 'codex', 'hermes');
  const targetChatId = conversationKey('pm', 'oc_team');
  const target = h.store.conversation(targetChatId, 'target-user', h.dir, 'group');
  target.threadId = 'hermes:target-original';
  h.store.rememberThread(target);
  h.store.save();
  h.runWith(async (_input, prompt) => (await h.ask(prompt)).answer);
  await h.bridge.receive(h.message());
  assert.equal(h.consults[0]!.threadId, undefined);
  target.threadId = 'hermes:target-other';
  target.consultationIdentity = 'hermes:target-other';
  target.revision++;
  h.store.save();
  await h.bridge.receive(h.message());
  assert.equal(h.consults[1]!.threadId, undefined, 'another target conversation has a separate consultation');
  target.threadId = 'hermes:target-original';
  target.consultationIdentity = 'hermes:target-original';
  target.revision++;
  h.store.save();
  await h.bridge.receive(h.message());
  assert.equal(h.consults[2]!.threadId, 'hermes:consultation-1', 'returning to the old target thread restores its consultation');
});

test('a Hermes target compaction keeps the logical consultation history', async t => {
  const h = setup(t, 'codex', 'hermes');
  const target = h.store.conversation(conversationKey('pm', 'oc_team'), 'target-user', h.dir, 'group');
  target.threadId = 'hermes:target-original';
  h.store.rememberThread(target);
  h.store.save();
  h.runWith(async (_input, prompt) => (await h.ask(prompt)).answer);
  await h.bridge.receive(h.message());
  target.threadId = 'hermes:target-compacted';
  h.store.rememberThread(target);
  h.store.save();
  await h.bridge.receive(h.message());
  assert.equal(h.consults[1]!.threadId, 'hermes:consultation-1');
});

test('target first ordinary thread assignment does not reset an existing consultation', async t => {
  const h = setup(t, 'codex', 'hermes');
  const target = h.store.conversation(conversationKey('pm', 'oc_team'), 'target-user', h.dir, 'group');
  h.runWith(async (_input, prompt) => (await h.ask(prompt)).answer);
  await h.bridge.receive(h.message());
  assert.equal(h.consults[0]!.threadId, undefined);
  target.threadId = 'hermes:target-first';
  h.store.save();
  await h.bridge.receive(h.message());
  assert.equal(h.consults[1]!.threadId, 'hermes:consultation-1');
});

test('a Hermes source compaction keeps the logical consultation history', async t => {
  const h = setup(t, 'hermes', 'codex');
  h.runWith(async (_input, prompt) => (await h.ask(prompt)).answer);
  await h.bridge.receive(h.message());
  const source = h.store.state.conversations.oc_team!;
  assert.equal(source.consultationIdentity, 'hermes:source-1', JSON.stringify(source));
  source.threadId = 'hermes:source-compacted';
  h.store.rememberThread(source);
  h.store.save();
  await h.bridge.receive(h.message());
  assert.equal(h.consults[1]!.threadId, 'consultation-1');
});

test('real consultation commentary creates one target progress card that becomes its answer', async t => {
  const h = setup(t);
  h.store.saveConfig({ progress: true });
  h.consultWith(async input => {
    input.onProgress?.('先检查验收要求');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.cards.length, 2); assert.match(h.cards[1]!.card.title, /产品经理.*正在答复/);
    return { text: '两条验收建议' };
  });
  h.runWith(async (_input, prompt) => {
    assert.equal((await h.ask(prompt)).groupReply, 'sent');
    assert.equal(h.cards.length, 2); assert.equal(h.cards[1]!.card.text, '两条验收建议');
    assert.equal(h.cards[1]!.card.buttons, undefined); return '继续实现';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.cards.length, 3);
  assert.equal(h.store.state.groupMessages.oc_team!.filter(item => item.text === '先检查验收要求').length, 0);
});

test('uncertain target group delivery still returns its actual answer and never repeats the call or send', async t => {
  const h = setup(t); let sends = 0;
  const originalSend = h.bridge.transport!.sendCard;
  h.bridge.transport!.sendCard = async (chatId, card) => {
    if (chatId === conversationKey('pm', 'oc_team')) { sends++; throw new Error('connection lost'); }
    return originalSend(chatId, card);
  };
  h.runWith(async (_input, prompt) => {
    const answer = await h.ask(prompt);
    assert.equal(answer.answer, '产品建议：防止重复提交'); assert.equal(answer.groupReply, 'uncertain');
    assert.deepEqual(await h.ask(prompt), answer);
    return '已拿到答复，但群消息送达未确认';
  });
  await h.bridge.receive(h.message());
  assert.equal(sends, 1); assert.equal(h.consults.length, 1);
  assert.equal(h.store.state.groupMessages.oc_team!.some(item => item.botId === 'pm' && item.role === 'assistant'), false);
});

test('runtime failure shows a sanitized target status and does not invent an answer', async t => {
  const h = setup(t);
  h.consultWith(async () => { throw new Error('secret-native-transport-command'); });
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.ask(prompt), /咨询失败|被中断/); return '咨询没有取得答复';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.cards[1]!.chatId, conversationKey('pm', 'oc_team'));
  assert.match(h.cards[1]!.card.title, /咨询未完成/);
  assert.ok(h.cards.every(item => !item.card.text.includes('secret-native')));
});

for (const scenario of ['self', 'unknown', 'ambiguous', 'unauthorized', 'unlinked', 'project', 'disabled', 'busy', 'missing-identity'] as const) {
  test(`consultation rejects ${scenario} target without starting another runtime`, async t => {
    const h = setup(t);
    if (scenario === 'ambiguous') h.store.saveBot('other', { name: '产品经理', enabled: true, appId: 'cli_other', allowedGroups: ['oc_team'] });
    if (scenario === 'unauthorized') h.store.saveBot('pm', { allowedActors: [] });
    if (scenario === 'unlinked') h.store.state.groupActorIdentities = {};
    if (scenario === 'project') h.store.conversation(conversationKey('pm', 'oc_team'), 'target-user', path.join(h.dir, 'other'), 'group');
    if (scenario === 'disabled') h.store.saveBot('pm', { enabled: false });
    if (scenario === 'missing-identity') delete h.store.state.botIdentities.pm;
    if (scenario === 'busy') (h.bridge as any).queues.set(conversationKey('pm', 'oc_team'), { active: true, items: [] });
    if (scenario === 'busy') h.store.conversation(conversationKey('pm', 'oc_team'), 'target-user', h.dir, 'group');
    h.runWith(async (_input, prompt) => {
      await assert.rejects(h.ask(prompt, { target: scenario === 'self' ? '开发人员' : scenario === 'unknown' ? '不存在' : '产品经理' }));
      return '说明无法咨询';
    });
    await h.bridge.receive(h.message());
    assert.equal(h.consults.length, 0);
    assert.equal(h.cards.length, 1, 'a rejected consultation must not publish a question or target reply');
    if (scenario === 'busy') (h.bridge as any).queues.delete(conversationKey('pm', 'oc_team'));
  });
}

test('revoking target group access cancels consultation and preserves the source task', async t => {
  const h = setup(t); let cancelled = false;
  h.consultWith(input => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => { cancelled = true; reject(input.signal.reason); });
    h.store.saveBot('pm', { allowedGroups: [] });
  }));
  h.runWith(async (_input, prompt) => { await assert.rejects(h.ask(prompt), /变化|取消/); return '已说明咨询被取消'; });
  await h.bridge.receive(h.message());
  assert.ok(cancelled); assert.deepEqual(h.replies.slice(1), ['已说明咨询被取消']);
  assert.equal(h.bridge.hasActiveWork(), false);
});

test('changing the current source thread without a revision bump invalidates its ticket', async t => {
  const h = setup(t);
  h.runWith(async (_input, prompt) => {
    const conversation = h.store.state.conversations.oc_team!;
    const original = conversation.threadId;
    conversation.threadId = 'different-native-thread';
    await assert.rejects(h.ask(prompt), /没有可用/);
    conversation.threadId = original;
    return '上下文已核对';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.consults.length, 0);
});

test('stopping the source task aborts its temporary consultation', async t => {
  const h = setup(t); let cancelled = false;
  h.consultWith(input => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => { cancelled = true; reject(input.signal.reason); });
    void h.bridge.stop('oc_team');
  }));
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.ask(prompt), /变化|停止|取消/);
    await assert.rejects(h.ask(prompt), /没有可用/);
    // A native interrupted source rejects its run instead of producing a completed answer.
    throw new Error('本轮任务已停止');
  });
  await h.bridge.receive(h.message());
  assert.ok(cancelled); assert.ok(!h.replies.includes('不应送出的结果'));
});

test('source commentary between consultations becomes the next question and keeps the final conclusion after the second answer', async t => {
  const h = setup(t, 'hermes', 'codex');
  h.store.saveConfig({ progress: true });
  let count = 0;
  h.consultWith(async () => ({ text: ++count === 1 ? '1 + 1 = 2' : '2 × 2 = 4' }));
  h.runWith(async (input, prompt) => {
    await h.ask(prompt, { question: '1 + 1？' });
    input.onProgress?.('开发已回答 2，继续询问乘以 2 的结果');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.cards.length, 3, 'real source commentary between consultations remains visible');
    const secondQuestionId = h.cards[2]!.id;
    await h.ask(prompt, { question: '把结果乘 2' });
    assert.equal(h.cards.length, 4);
    assert.equal(h.cards[2]!.id, secondQuestionId, 'the inter-consultation progress card becomes the second question');
    assert.ok(h.cards[2]!.card.text.includes('把结果乘 2'));
    assert.deepEqual(h.cards[2]!.card.mention, { openId: 'ou_target' });
    input.onProgress?.('已拿到最终结果，正在汇总');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.cards.length, 5);
    return '两步均已完成';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.cards.length, 5);
  assert.deepEqual(h.cards.map(item => item.chatId), ['oc_team', conversationKey('pm', 'oc_team'), 'oc_team', conversationKey('pm', 'oc_team'), 'oc_team']);
  assert.equal(h.cards[1]!.card.text, '1 + 1 = 2');
  assert.equal(h.cards[3]!.card.text, '2 × 2 = 4');
  assert.equal(h.cards[4]!.card.text, '两步均已完成');
  assert.ok(h.cards[0]!.card.text.includes('1 + 1？'));
  assert.ok(h.cards[2]!.card.text.includes('把结果乘 2'));
});

test('an existing source progress card becomes the first question while its conclusion is a new last message', async t => {
  const h = setup(t, 'hermes', 'codex');
  h.store.saveConfig({ progress: true });
  let progressId = '';
  h.runWith(async (input, prompt) => {
    input.onProgress?.('准备向产品确认验收要求');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.cards.length, 1);
    progressId = h.cards[0]!.id;
    assert.ok(h.cards[0]!.card.buttons?.length);
    await h.ask(prompt);
    assert.equal(h.cards.length, 2, 'the existing source card must be adopted rather than adding another question card');
    assert.equal(h.cards[0]!.id, progressId);
    assert.ok(h.cards[0]!.card.text.includes('登录需要哪些校验？'));
    assert.deepEqual(h.cards[0]!.card.mention, { openId: 'ou_target' });
    assert.equal(h.cards[0]!.card.buttons, undefined);
    return '已结合产品意见完成';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.cards.length, 3);
  assert.equal(h.cards[0]!.id, progressId);
  assert.notEqual(h.cards[2]!.id, progressId);
  assert.equal(h.cards[2]!.card.text, '已结合产品意见完成');
  assert.equal(h.cards[2]!.card.mention, undefined);
});

test('target dispatch waits for the public question acknowledgement', async t => {
  const h = setup(t);
  let questionStarted!: () => void;
  let acknowledge!: () => void;
  const started = new Promise<void>(resolve => { questionStarted = resolve; });
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  const originalSend = h.bridge.transport!.sendCard;
  h.bridge.transport!.sendCard = async (chatId, card) => {
    if (card.mention) {
      questionStarted();
      await acknowledged;
    }
    return originalSend(chatId, card);
  };
  h.runWith(async (_input, prompt) => {
    const pending = h.ask(prompt);
    await started;
    assert.equal(h.consults.length, 0, 'an unacknowledged public question cannot dispatch the target');
    assert.equal(h.cards.length, 0);
    acknowledge();
    assert.equal((await pending).groupReply, 'sent');
    return '咨询完成';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.consults.length, 1);
  assert.equal(h.cards.length, 3);
});

test('uncertain public question delivery prevents target dispatch and caches the failure without duplicate sends', async t => {
  const h = setup(t);
  let questionSends = 0;
  const originalSend = h.bridge.transport!.sendCard;
  h.bridge.transport!.sendCard = async (chatId, card) => {
    if (card.mention) {
      questionSends++;
      throw new Error('question acknowledgement lost');
    }
    return originalSend(chatId, card);
  };
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.ask(prompt));
    await assert.rejects(h.ask(prompt));
    assert.equal(questionSends, 1);
    assert.equal(h.consults.length, 0);
    return '提问送达未确认，尚未咨询目标';
  });
  await h.bridge.receive(h.message());
  assert.equal(questionSends, 1);
  assert.equal(h.consults.length, 0);
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0]!.card.text, '提问送达未确认，尚未咨询目标');
});

for (const failure of ['offline', 'throws'] as const) {
  test(`Hermes ${failure} is reported before a public question or model task, without exposing native details`, async t => {
    const h = setup(t); let checks = 0;
    h.statusWith(async engine => {
      assert.equal(engine, 'hermes'); checks++;
      if (failure === 'throws') throw new Error('secret-native-token');
      return { available: false, error: 'secret-native-token' };
    });
    h.runWith(async (_input, prompt) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(h.ask(prompt), error => {
          assert.match((error as Error).message, /请在应用的机器人页面检查/);
          assert.ok(!(error as Error).message.includes('secret-native'));
          return true;
        });
      }
      return '请先打开 Hermes，再发起任务';
    });
    await h.bridge.receive(h.message());
    assert.equal(checks, 1, 'an unavailable target must not be automatically retried');
    assert.equal(h.consults.length, 0);
    assert.deepEqual(h.cards.map(item => item.card.text), ['请先打开 Hermes，再发起任务']);
    assert.equal(h.bridge.hasActiveWork(), false);
  });
}

test('revoked group access during Hermes availability check prevents public dispatch', async t => {
  const h = setup(t);
  h.statusWith(async () => { h.store.saveBot('pm', { allowedGroups: [] }); return { available: true }; });
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.ask(prompt), /变化|取消/); return '咨询已取消';
  });
  await h.bridge.receive(h.message());
  assert.equal(h.consults.length, 0);
  assert.deepEqual(h.cards.map(item => item.card.text), ['咨询已取消']);
});

test('stopping the source releases a stuck Hermes availability check without publishing', async t => {
  const h = setup(t);
  h.statusWith(async () => {
    void h.bridge.stop('oc_team');
    return new Promise(() => {});
  });
  h.runWith(async (_input, prompt) => {
    await assert.rejects(h.ask(prompt), /变化|停止|取消/);
    throw new Error('本轮任务已停止');
  });
  await h.bridge.receive(h.message());
  assert.equal(h.consults.length, 0);
  assert.ok(h.cards.every(item => !item.card.mention && !item.card.title.includes('咨询')));
  assert.equal(h.bridge.hasActiveWork(), false);
});
