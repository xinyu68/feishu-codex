import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GROUP_CONSULT_PATH, groupConsultPort } from '../src/group-consult-request.js';
import { namespaceMessage } from '../src/routing.js';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { CodexRunInput, CodexRuntime, InboundMessage, MessageCard, RuntimeConsultInput } from '../src/types.js';

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

type Engine = 'codex' | 'hermes';
type SourceRun = { input: CodexRunInput; threadId: string; turnId: string; prompt: string; engine: Engine; finished: boolean; finish: () => void };
type ConsultRun = { input: RuntimeConsultInput; engine: Engine; cancelled: boolean; finish: (text: string) => void };

async function setup(t: test.TestContext, sourceEngine: Engine = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-consult-http-'));
  const seed = new Store(dir);
  seed.saveConfig({ engine: sourceEngine, enabled: true, appId: 'cli_1234567890abcdef', appSecret: 'source-test-secret',
    allowedActors: ['pm-user'], allowedGroups: ['oc_team'], defaultWorkspace: dir, botName: '产品经理',
    roleInstructions: '整理需求', progress: false });
  seed.saveBot('qa', { enabled: true, appId: 'cli_abcdef1234567890', appSecret: 'target-test-secret',
    engine: sourceEngine === 'codex' ? 'hermes' : 'codex', name: '测试人员', roleInstructions: '分析测试问题',
    allowedActors: ['qa-user'], allowedGroups: ['oc_team'] });
  seed.rememberBotIdentity('qa', { openId: 'ou_qa', name: '测试人员' });
  const runs: SourceRun[] = [];
  const consultations: ConsultRun[] = [];
  const stopped: string[] = [];
  const connected = new Set<string>();
  const sent: { appId: string; chatId: string; card: MessageCard }[] = [];
  const sources: Promise<void>[] = [];
  const runtime = (engine: Engine): CodexRuntime => ({
    supportsSteering: engine === 'codex',
    async run(input) {
      await input.onBeforeSubmit?.();
      const threadId = input.threadId || `${engine === 'hermes' ? 'hermes:' : ''}source-${randomUUID()}`;
      const turnId = `turn-${randomUUID()}`;
      input.onThread?.(threadId);
      const prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
      input.onSubmitted?.({ threadId, turnId, mode: 'start', status: 'submitted' });
      let finish!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      const run: SourceRun = { input, threadId, turnId, prompt, engine, finished: false, finish };
      runs.push(run);
      await held;
      run.finished = true;
      return { threadId, turnId, text: '已结合咨询结果完成本轮分析。' };
    },
    async consult(input) {
      await input.onBeforeSubmit?.();
      let finish!: (text: string) => void;
      let fail!: (reason: unknown) => void;
      const held = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      const run: ConsultRun = { input, engine, cancelled: false, finish };
      const cancel = () => { run.cancelled = true; fail(input.signal.reason ?? new Error('consult cancelled')); };
      input.signal.addEventListener('abort', cancel, { once: true });
      consultations.push(run);
      if (input.signal.aborted) cancel();
      try { return { threadId: `${engine}:consult-${randomUUID()}`, text: await held }; }
      finally { input.signal.removeEventListener('abort', cancel); }
    },
    async stop(threadId) { stopped.push(threadId); }, async release() {}, async close() {}, async updateGroupHandoffPolicy() {},
    async models() { return []; }, async history() { return []; }, async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '源群会话', isUserThread: true }; },
  });
  const app = await startServer({ port: 0, dataDir: dir, codex: runtime('codex'), hermes: runtime('hermes'),
    discovery: { async projects() { return []; }, async threads() { return []; } },
    feishu: {
      async verifyCredentials() {},
      createTransport(options) {
        const send = async (chatId: string, card: MessageCard) => { sent.push({ appId: options.appId, chatId, card }); return `om_${randomUUID()}`; };
        return {
          async start() { connected.add(options.appId); options.onStatus('connected'); },
          async close() { options.onStatus('stopped'); },
          sendCard: send, sendText: (chatId, text) => send(chatId, { title: '', text }),
          async updateCard() {}, async sendImage() { return 'om_image'; }, async sendFile() { return 'om_file'; },
          async startTyping() { return async () => {}; },
        };
      },
    },
  });
  t.after(async () => {
    for (const run of runs) run.finish();
    for (const consultation of consultations) consultation.finish('清理测试');
    await Promise.allSettled(sources);
    await app.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('group-consult-http-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => connected.size === 2, 'mock transports connected');
  const message = (botId: string, text: string): InboundMessage => namespaceMessage(botId, {
    id: `om_${randomUUID()}`, chatId: 'oc_team', chatType: 'group', actorId: botId === 'default' ? 'pm-user' : 'qa-user',
    actorTenantKey: 'tenant_test', actorUnionId: 'same_human', text,
  });
  for (const botId of ['default', 'qa']) app.store.observeGroup(message(botId, '已在本群授权合作。'));
  const base = `http://127.0.0.1:${app.port}`;
  const startSource = async () => {
    const source = app.bridge.receive(message('default', '请咨询测试人员后，结合答复分析当前问题。'));
    sources.push(source);
    await until(() => runs.length === sources.length, 'source submitted');
    const run = runs[runs.length - 1]!;
    const context_token = /context_token: (fc1\.\d+\.[a-f0-9]{64})/.exec(run.prompt)?.[1];
    assert.ok(context_token, 'current source prompt must contain a bridge-issued consultation ticket');
    return { source, run, context_token };
  };
  const request = (body: unknown, init: RequestInit = {}) => fetch(`${base}${GROUP_CONSULT_PATH}`, {
    method: 'POST', body: JSON.stringify(body), ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  return { app, base, runs, consultations, stopped, sent, startSource, request };
}

for (const engine of ['codex', 'hermes'] as const) {
  test(`${engine} source can consult through its actual ephemeral port without a UI CSRF token`, async t => {
    const h = await setup(t, engine);
    const { source, run, context_token } = await h.startSource();
    assert.notEqual(h.app.port, 0);
    assert.equal(groupConsultPort(context_token), h.app.port);
    const pending = h.request({ context_token, target: '测试人员', question: '测试失败原因是什么？', context: '当前公开测试记录' }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    await until(() => h.consultations.length === 1, 'target consultation dispatched');
    assert.equal(h.sent.length, 1, 'the source question must be acknowledged before target dispatch');
    assert.equal(h.sent[0]!.appId, h.app.store.bot('default')!.appId);
    assert.equal(h.sent[0]!.chatId, 'oc_team');
    assert.deepEqual(h.sent[0]!.card.mention, { openId: 'ou_qa' });
    assert.ok(h.sent[0]!.card.text.includes('测试失败原因是什么？'));
    assert.equal(h.consultations[0]!.engine, engine === 'codex' ? 'hermes' : 'codex');
    assert.equal(run.finished, false, 'source remains in the same active turn while the HTTP call waits');
    assert.match(h.consultations[0]!.input.prompt, /测试失败原因是什么/);
    assert.ok(!h.consultations[0]!.input.prompt.includes(context_token));
    h.consultations[0]!.finish('缺少测试配置，需要补齐路径。');
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { target: '测试人员', answer: '缺少测试配置，需要补齐路径。', truncated: false, groupReply: 'sent' });
    const publicAnswer = h.sent.filter(item => item.card.text === '缺少测试配置，需要补齐路径。');
    assert.equal(publicAnswer.length, 1);
    assert.equal(publicAnswer[0]!.chatId, 'oc_team');
    assert.equal(publicAnswer[0]!.appId, h.app.store.bot('qa')!.appId, 'the consulted bot itself must publish in the original group');
    assert.equal(run.finished, false);
    assert.deepEqual(h.stopped, []);
    run.finish();
    await source;
    assert.equal(h.sent.length, 3);
    assert.equal(h.sent[1]!.appId, h.app.store.bot('qa')!.appId);
    assert.equal(h.sent[2]!.appId, h.app.store.bot('default')!.appId);
    assert.equal(h.sent[2]!.card.text, '已结合咨询结果完成本轮分析。');
    const stale = await h.request({ context_token, target: '测试人员', question: '再问一次' });
    assert.equal(stale.status, 403);
    assert.match((await stale.json() as { error: string }).error, /上下文|凭据/);
    assert.equal(h.consultations.length, 1, 'expired source tickets cannot dispatch another task');
  });
}

test('consultation HTTP rejects missing/forged tickets, browser metadata, non-POST methods and non-JSON requests before dispatch', async t => {
  const h = await setup(t);
  const { context_token } = await h.startSource();
  const body = { context_token, target: '测试人员', question: '分析测试失败' };
  for (const [input, status] of [
    [{ target: '测试人员', question: '没有票据' }, 400],
    [{ ...body, context_token: `fc1.${h.app.port}.${'0'.repeat(64)}` }, 403],
    [{ ...body, threadId: 'foreign-source' }, 400],
  ] as const) {
    const response = await h.request(input);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json() as { error: unknown }).error, 'string');
  }
  for (const headers of [
    { Origin: h.base }, { Origin: 'https://foreign.invalid' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'none' },
  ]) {
    const response = await h.request(body, { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    await response.arrayBuffer();
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${h.base}${GROUP_CONSULT_PATH}`, { method, headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 405, method);
    await response.arrayBuffer();
  }
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
    const response = await h.request(body, { headers: { 'Content-Type': contentType } });
    assert.equal(response.status, 415, contentType);
    await response.arrayBuffer();
  }
  const missingType = await fetch(`${h.base}${GROUP_CONSULT_PATH}`, { method: 'POST', body: Buffer.from(JSON.stringify(body)) });
  assert.equal(missingType.status, 415);
  await missingType.arrayBuffer();
  for (const body of ['{', 'null', '[]', '"ticket"']) {
    const response = await h.request({}, { body });
    assert.equal(response.status, 400, body);
    await response.arrayBuffer();
  }
  assert.equal(h.consultations.length, 0);
  assert.deepEqual(h.stopped, []);
});

test('consultation capability does not disable CSRF protection on ordinary management writes', async t => {
  const h = await setup(t);
  const { context_token } = await h.startSource();
  const state = await fetch(`${h.base}/api/state`).then(response => response.json()) as { csrfToken: string };
  assert.ok(state.csrfToken);
  for (const token of [undefined, context_token]) {
    const response = await fetch(`${h.base}/api/config`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Bridge-Token': token } : {}) }, body: JSON.stringify({ progress: false }),
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
  }
  const accepted = await fetch(`${h.base}/api/config`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': state.csrfToken }, body: JSON.stringify({ progress: false }),
  });
  assert.equal(accepted.status, 200);
  await accepted.arrayBuffer();
  assert.equal(h.consultations.length, 0);
});

test('disconnecting the consultation HTTP client cancels only its target analysis while source work continues', async t => {
  const h = await setup(t);
  const { source, run, context_token } = await h.startSource();
  const body = { context_token, target: '测试人员', question: '等待测试分析' };
  const client = http.request(`${h.base}${GROUP_CONSULT_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  t.after(() => client.destroy());
  client.end(JSON.stringify(body));
  await until(() => h.consultations.length === 1, 'consultation dispatched');
  assert.equal(h.consultations[0]!.input.signal.aborted, false);
  client.destroy();
  await until(() => h.consultations[0]!.cancelled, 'disconnected consultation aborted');
  assert.equal(h.consultations[0]!.input.signal.aborted, true);
  assert.equal(run.finished, false);
  assert.deepEqual(h.stopped, [], 'a transport abort must not call stop on the source chat');
  assert.equal(h.app.bridge.hasActiveWork(), true, 'the original source turn remains active');
  const replay = await h.request(body);
  assert.equal(replay.status, 409);
  await replay.arrayBuffer();
  assert.equal(h.consultations.length, 1, 'a disconnected request cannot be dispatched again');
  run.finish();
  await source;
  assert.equal(run.finished, true);
  assert.deepEqual(h.stopped, []);
});
