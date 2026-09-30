import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as Lark from '@larksuiteoapi/node-sdk';
import { actionSignature, FeishuClient, formatSdkLog, isAllowedCommand, parseCardEvent, parseMessageEvent, renderCard, renderMarkdown, safeFilename, splitText } from '../src/feishu.js';
import type { FeishuOptions, InboundMessage } from '../src/types.js';

const privateEvent = (content = JSON.stringify({ text: '有没有需要我待处理的' }), type = 'text') => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_actor' } },
  message: { message_id: 'om_message', chat_id: 'oc_chat', chat_type: 'p2p', message_type: type, content, create_time: '1758710000000' },
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(overrides: Partial<FeishuOptions> = {}, methods: Record<string, unknown> = {}, retryDelay: (milliseconds: number, signal: AbortSignal) => Promise<void> = async () => {}) {
  let dispatcher: Lark.EventDispatcher;
  let wsClosed = false;
  const messages: InboundMessage[] = [];
  const statuses: string[] = [];
  const logs: string[] = [];
  const created: any[] = [];
  const patched: any[] = [];
  const recalled: any[] = [];
  const imageUploads: any[] = [];
  const fileUploads: any[] = [];
  let downloads = 0;
  let reactionDeletes = 0;
  const api = { im: { v1: {
    message: {
      create: async (payload: unknown) => { created.push(payload); return { code: 0, data: { message_id: `om_${created.length}`, chat_id: 'oc_chat' } }; },
      patch: async (payload: unknown) => { patched.push(payload); return { code: 0 }; },
      delete: async (payload: unknown) => { recalled.push(payload); return { code: 0 }; },
    },
    messageReaction: {
      create: async () => ({ code: 0, data: { reaction_id: 'reaction1' } }),
      delete: async () => { reactionDeletes++; return { code: 0 }; },
    },
    messageResource: {
      get: async () => { downloads++; return { headers: { 'content-type': 'image/jpeg' }, getReadableStream: () => Readable.from([Buffer.from('image bytes')]) }; },
    },
    image: {
      create: async (payload: unknown) => { imageUploads.push(payload); return { image_key: `img_${imageUploads.length}` }; },
    },
    file: {
      create: async (payload: unknown) => { fileUploads.push(payload); return { file_key: `file_${fileUploads.length}` }; },
    },
    ...methods,
  } } } as unknown as Lark.Client;
  const client = new FeishuClient({
    appId: 'cli_1234567890abcdef', appSecret: 'local-test-secret', attachmentDir: os.tmpdir(),
    onMessage: async message => { messages.push(message); },
    onStatus: status => { statuses.push(status); },
    log: (_level, text) => { logs.push(text); },
    ...overrides,
  }, { api, retryDelay, ws: {
    start: async options => { dispatcher = options.eventDispatcher; },
    close: () => { wsClosed = true; },
  } });
  return {
    client, messages, statuses, logs, created, patched, recalled, imageUploads, fileUploads,
    get downloads() { return downloads; }, get reactionDeletes() { return reactionDeletes; }, get wsClosed() { return wsClosed; },
    async event(type: string, event: unknown) { return dispatcher.invoke({ schema: '2.0', header: { event_type: type }, event }, { needCheck: false }); },
  };
}

test('plain follow-ups remain untouched and only human private messages enter Codex', () => {
  assert.equal(parseMessageEvent(privateEvent())?.message.text, '有没有需要我待处理的');
  const group = privateEvent(); group.message.chat_type = 'group';
  assert.equal(parseMessageEvent(group), undefined);
  const bot = privateEvent(); bot.sender.sender_type = 'app';
  assert.equal(parseMessageEvent(bot), undefined);
  assert.equal(parseMessageEvent(undefined), undefined);
  assert.equal(parseMessageEvent({ message: {} }), undefined);
  assert.equal(parseMessageEvent(privateEvent('{')), undefined);
  assert.equal(parseMessageEvent(privateEvent('null')), undefined);
});

test('supported group commands addressed to two bots reach each bot without changing ordinary mentions', () => {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_actor' } },
    message: {
      message_id: 'om_multi_new', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 @_user_2 /new' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot_a' }, name: '机器人 A' },
        { key: '@_user_2', id: { open_id: 'ou_bot_b' }, name: '机器人 B' },
      ],
    },
  };
  for (const command of ['/new', '/status', '/stop', '/session']) {
    event.message.content = JSON.stringify({ text: `@_user_1 @_user_2 ${command}` });
    assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot_a' })?.message.text, command);
    assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot_b' })?.message.text, command);
    assert.equal(parseMessageEvent(event, { botOpenId: 'ou_other' }), undefined);
  }
  event.message.content = JSON.stringify({ text: '@_user_1 @_user_2 /session S1' });
  assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot_a' })?.message.text, '@机器人 B /session S1');
  event.message.content = JSON.stringify({ text: '@_user_1 @_user_2 请讨论 /new 的用法' });
  assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot_a' })?.message.text, '@机器人 B 请讨论 /new 的用法');
});

test('attachment names cannot escape the directory or create Windows device files', () => {
  assert.equal(safeFilename('..\\..\\CON.txt'), '_CON.txt');
  assert.equal(safeFilename('../../file:stream?.txt'), 'file_stream_.txt');
  assert.equal(safeFilename('...'), 'attachment');
  assert.equal(safeFilename('report.txt... '), 'report.txt');
});

test('UTF-8 chunks preserve Chinese, emoji and all content within byte limit', () => {
  const original = '你好🙂abc\n'.repeat(5000);
  const chunks = splitText(original);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), original);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 12000));
  assert.ok(chunks.every(chunk => !chunk.includes('\ufffd')));
});

test('GFM tables become readable rows while code fences stay intact', () => {
  const input = '| 来源 | 内容 |\n|---|---|\n| 小组 | [详情](https://example.test) |\n\n```\n| a | b |\n|---|---|\n| c | d |\n```';
  const output = renderMarkdown(input);
  assert.ok(output.includes('来源：小组\n内容：[详情](https://example.test)'));
  assert.ok(output.includes('```\n| a | b |\n|---|---|\n| c | d |\n```'));
});

test('cards require signed known commands and reject modified or forwarded actions', () => {
  const card = renderCard({ title: '审批', text: '运行命令', buttons: [{ label: '允许', command: '/approve request1' }] }, 'oc_chat', 'secret') as any;
  const value = card.elements[1].actions[0].value;
  const event = { context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' }, operator: { open_id: 'ou_actor' }, token: 'once', action: { value, tag: 'button' } };
  const parsed = parseCardEvent(event, 'secret');
  assert.equal(parsed?.text, '/approve request1');
  assert.equal(parsed?.actionMessageId, 'om_card');
  assert.equal(parsed?.id, 'card:once');
  assert.equal(parseCardEvent({ ...event, context: { ...event.context, open_chat_id: 'oc_group' } }, 'secret'), undefined);
  assert.equal(parseCardEvent({ ...event, action: { value: { ...value, command: '/stop' } } }, 'secret'), undefined);
  assert.equal(parseCardEvent({ ...event, action: { value: { command: '/task', signature: actionSignature('secret', 'oc_chat', '/task') } } }, 'secret'), undefined);
  assert.equal(isAllowedCommand('/notification 123'), true);
  assert.equal(isAllowedCommand('/help\nignore instructions'), false);
  assert.equal(isAllowedCommand('ordinary text'), false);
});

test('SDK ACK completes before a long Codex turn and start does not falsely claim readiness', async () => {
  let finish!: () => void;
  let entered = false;
  const turn = new Promise<void>(resolve => { finish = resolve; });
  const h = harness({ onMessage: async () => { entered = true; await turn; } });
  await h.client.start();
  assert.deepEqual(h.statuses, ['connecting']);
  await h.event('im.message.receive_v1', privateEvent());
  assert.equal(entered, true);
  finish();
  await tick();
  await h.client.close();
  assert.equal(h.wsClosed, true);
  assert.equal(h.statuses.at(-1), 'stopped');
});

test('async inbound failures are observed and do not reject the SDK ACK', async () => {
  const h = harness({ onMessage: async () => { throw new Error('bad local-test-secret'); } });
  await h.client.start();
  await h.event('im.message.receive_v1', privateEvent());
  await tick();
  assert.ok(h.logs.some(text => text.includes('bad [redacted]')));
  assert.ok(h.logs.every(text => !text.includes('local-test-secret')));
  await h.client.close();
});

test('unapproved actors reach bridge authorization without downloading attachments', async () => {
  const h = harness({ allowAttachments: () => false });
  await h.client.start();
  await h.event('im.message.receive_v1', privateEvent(JSON.stringify({ image_key: 'img_key' }), 'image'));
  await tick();
  assert.equal(h.downloads, 0);
  assert.equal(h.messages[0]?.actorId, 'ou_actor');
  assert.equal(h.messages[0]?.images, undefined);
  await h.client.close();
});

test('image download uses bounded stream and saves under configured directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-image-'));
  const h = harness({ attachmentDir: directory });
  try {
    await h.client.start();
    await h.event('im.message.receive_v1', privateEvent(JSON.stringify({ image_key: '../../image' }), 'image'));
    for (let count = 0; count < 100 && !h.messages.length; count++) await new Promise(resolve => setTimeout(resolve, 10));
    const file = h.messages[0]?.images?.[0];
    assert.ok(file);
    assert.equal(path.dirname(file), directory);
    assert.equal(path.extname(file), '.jpg');
    assert.equal(await readFile(file, 'utf8'), 'image bytes');
  } finally { await h.client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('oversized streams are cancelled, partial files removed, and no turn is started', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-large-'));
  const h = harness({ attachmentDir: directory }, { messageResource: {
    get: async () => ({ headers: {}, getReadableStream: () => Readable.from([Buffer.alloc(21 * 1024 * 1024)]) }),
  } });
  try {
    await h.client.start();
    await h.event('im.message.receive_v1', privateEvent(JSON.stringify({ file_key: 'file_key', file_name: '../large.txt' }), 'file'));
    for (let count = 0; count < 100 && !h.created.length; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.messages.length, 0);
    assert.equal(h.created.length, 1);
    assert.match(h.created[0].data.content, /20 MB/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await h.client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('API nonzero codes are failures rather than synthetic success IDs', async () => {
  const h = harness({}, { message: { create: async () => ({ code: 99991672, msg: 'missing scope' }), patch: async () => ({ code: 234001, msg: 'denied' }) } });
  await assert.rejects(h.client.sendText('oc_chat', 'test'), /99991672/);
  await assert.rejects(h.client.sendCard('oc_chat', { title: 't', text: 'text' }), /99991672/);
  await assert.rejects(h.client.updateCard('om_card', { title: 'done', text: '已处理' }), /234001/);
});

test('outbound images are uploaded and sent as native Feishu image messages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-outbound-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = path.join(directory, 'preview.png');
  await writeFile(image, Buffer.from('png bytes'));
  const h = harness();
  const messageId = await h.client.sendImage('oc_chat', image);
  assert.equal(messageId, 'om_1');
  assert.equal(h.imageUploads.length, 1);
  assert.deepEqual(h.imageUploads[0].data.image, Buffer.from('png bytes'));
  assert.equal(h.created[0].data.msg_type, 'image');
  assert.deepEqual(JSON.parse(h.created[0].data.content), { image_key: 'img_1' });
});

test('outbound files are uploaded and sent as native Feishu file messages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-outbound-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.pdf');
  await writeFile(file, Buffer.from('pdf bytes'));
  const h = harness();
  const messageId = await h.client.sendFile('oc_chat', file);
  assert.equal(messageId, 'om_1');
  assert.equal(h.fileUploads.length, 1);
  assert.equal(h.fileUploads[0].data.file_type, 'stream');
  assert.equal(h.fileUploads[0].data.file_name, 'report.pdf');
  assert.deepEqual(h.fileUploads[0].data.file, Buffer.from('pdf bytes'));
  assert.equal(h.created[0].data.msg_type, 'file');
  assert.deepEqual(JSON.parse(h.created[0].data.content), { file_key: 'file_1' });
});

test('resolved card replaces action elements so repeat approval buttons disappear', async () => {
  const h = harness();
  const id = await h.client.sendCard('oc_chat', { title: '审批', text: '执行？', buttons: [{ label: '批准', command: '/approve req' }] });
  await h.client.updateCard(id, { title: '已批准', text: '请求已处理', tone: 'green' });
  const payload = JSON.parse(h.patched[0].data.content);
  assert.equal(payload.header.template, 'green');
  assert.equal(payload.elements.filter((element: any) => element.tag === 'action').length, 0);
  assert.equal(payload.config.update_multi, true);
});

test('typing is removed exactly once across manual cleanup and transport shutdown', async () => {
  const h = harness();
  const cleanup = await h.client.startTyping('om_message');
  await cleanup(); await cleanup(); await h.client.close();
  assert.equal(h.reactionDeletes, 1);
  const second = harness();
  await second.client.startTyping('om_message');
  await second.client.close();
  assert.equal(second.reactionDeletes, 1);
});

test('a failed typing reaction does not stop message handling', async () => {
  const h = harness({}, { messageReaction: { create: async () => ({ code: 999, msg: 'unavailable' }) } });
  const cleanup = await h.client.startTyping('om_message');
  await cleanup();
  assert.ok(h.logs.some(text => text.includes('处理表情不可用')));
});

test('SDK HTTP wrapper preserves token and message response decoding with finite timeouts', async () => {
  const originalAdapter = Lark.defaultHttpInstance.defaults.adapter;
  const timeouts: number[] = [];
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    timeouts.push(config.timeout ?? 0);
    return {
      config, status: 200, statusText: 'OK', headers: {},
      data: config.url?.includes('/auth/')
        ? { code: 0, tenant_access_token: 'mock-token', app_access_token: 'mock-token', expire: 7200 }
        : { code: 0, data: { message_id: 'om_timeout', chat_id: 'oc_chat' } },
    };
  };
  const client = new FeishuClient({
    appId: 'cli_abcdef0123456789', appSecret: 'mock-secret', attachmentDir: os.tmpdir(),
    onMessage: async () => {}, onStatus: () => {}, log: () => {},
  }, { ws: { start: async () => {}, close: () => {} } });
  try {
    assert.equal(await client.sendText('oc_chat', 'hello'), 'om_timeout');
    assert.ok(timeouts.length >= 2);
    assert.ok(timeouts.every(timeout => timeout === 20_000));
  } finally { Lark.defaultHttpInstance.defaults.adapter = originalAdapter; await client.close(); }
});

test('SDK logger unwraps nested argument arrays and retains safe error diagnostics', () => {
  const text = formatSdkLog([
    ['[ws]', ['connect failed', new Error('handshake timeout')]],
    [{ code: 99991672, msg: 'missing scope', message: 'request failed', headers: { Authorization: 'header-secret' }, config: { data: 'request-secret' }, response: { data: 'response-secret' } }],
  ], 'app-secret');
  assert.match(text, /\[ws\] connect failed message: handshake timeout/);
  assert.match(text, /code: 99991672 msg: missing scope message: request failed/);
  assert.doesNotMatch(text, /header-secret|request-secret|response-secret|SDK detail omitted/);
});

test('SDK logger redacts secrets and token values without serializing arbitrary objects', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const dangerous = { headers: 'never-log-this', token: 'never-log-token', toJSON() { throw new Error('must not serialize'); } };
  const text = formatSdkLog([
    ['app-secret', 'Bearer bearer-value', '{"tenant_access_token":"tenant-value", "refresh_token": "refresh-value"}', 'token=plain-value', 'appSecret="other-secret"', new Error('https://example.test/api?token=url-value')],
    dangerous, cyclic,
  ], 'app-secret');
  assert.doesNotMatch(text, /app-secret|bearer-value|tenant-value|refresh-value|plain-value|other-secret|url-value|never-log/);
  assert.match(text, /\[redacted\]/);
  assert.ok(text.length <= 1200);
});

test('SDK unhandled-event warnings retain event names for diagnosing real subscriptions', async () => {
  const h = harness();
  await h.client.start();
  try {
    await h.event('im.message.reaction.created_v1', { message_id: 'om_message' });
    await h.event('im.message.reaction.deleted_v1', { message_id: 'om_message' });
    assert.ok(h.logs.some(text => text.includes('no im.message.reaction.created_v1 handle')));
    assert.ok(h.logs.some(text => text.includes('no im.message.reaction.deleted_v1 handle')));
    assert.equal(h.messages.length, 0);
  } finally { await h.client.close(); }
});

test('usage refresh survives card rendering and removed aliases are rejected', () => {
  const command = '/usage';
  const card = renderCard({ title: 'Codex 套餐余量', text: '剩余 50%', buttons: [{ label: '刷新余量', command }] }, 'oc_chat', 'secret') as any;
  const rows = card.elements.filter((element: any) => element.tag === 'action');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actions.length, 1);
  assert.equal(rows[0].actions[0].text.content, '刷新余量');
  const value = rows[0].actions[0].value;
  assert.equal(value.command, command);
  const event = { context: { open_message_id: 'om_usage', open_chat_id: 'oc_chat' }, operator: { open_id: 'ou_actor' }, token: 'refresh-usage', action: { value, tag: 'button' } };
  assert.deepEqual(parseCardEvent(event, 'secret'), {
    id: 'card:refresh-usage', chatId: 'oc_chat', actorId: 'ou_actor', text: command, actionMessageId: 'om_usage',
  });
  assert.equal(parseCardEvent({ ...event, context: { ...event.context, open_chat_id: 'oc_other' } }, 'secret'), undefined);
  assert.equal(parseCardEvent({ ...event, action: { value: { ...value, command: '/usage reset' }, tag: 'button' } }, 'secret'), undefined);
  for (const removed of ['/quota', '/balance', '/bal']) assert.equal(isAllowedCommand(removed), false);
});

test('recalling a card uses the SDK message path and clears action signing state after success', async () => {
  const h = harness();
  const card = { title: '处理中', text: '正在处理', buttons: [{ label: '停止', command: '/stop' }] };
  const id = await h.client.sendCard('oc_chat', card);
  await h.client.recallCard(id);
  assert.deepEqual(h.recalled, [{ path: { message_id: id } }]);
  await assert.rejects(h.client.updateCard(id, card), /Unknown card destination/);
  assert.equal(h.patched.length, 0);
});

test('failed card recall throws and keeps the saved action destination for fallback updates', async () => {
  let failure: 'api' | 'network' | 'empty' | undefined = 'api';
  const patches: Array<{ data: { content: string } }> = [];
  const networkError = new Error('simulated recall connection loss');
  const h = harness({}, { message: {
    create: async () => ({ code: 0, data: { message_id: 'om_recall', chat_id: 'oc_chat' } }),
    patch: async (payload: { data: { content: string } }) => { patches.push(payload); return { code: 0 }; },
    delete: async () => {
      if (failure === 'api') return { code: 230011, msg: 'cannot recall local-test-secret' };
      if (failure === 'network') throw networkError;
      if (failure === 'empty') return undefined;
      return { code: 0 };
    },
  } });
  const card = { title: '处理中', text: '正在处理', buttons: [{ label: '停止', command: '/stop' }] };
  const id = await h.client.sendCard('oc_chat', card);
  await assert.rejects(h.client.recallCard(id), error => {
    assert.match(String(error), /撤回卡片失败.*230011/);
    assert.doesNotMatch(String(error), /local-test-secret/);
    return true;
  });
  await h.client.updateCard(id, card);
  failure = 'network';
  await assert.rejects(h.client.recallCard(id), error => error === networkError);
  await h.client.updateCard(id, card);
  failure = 'empty';
  await assert.rejects(h.client.recallCard(id), /撤回卡片失败.*unknown/);
  await h.client.updateCard(id, card);
  assert.equal(patches.length, 3);
  const value = JSON.parse(patches[0]!.data.content).elements[1].actions[0].value;
  assert.equal(value.signature, actionSignature('local-test-secret', 'oc_chat', '/stop'));
  failure = undefined;
  await h.client.recallCard(id);
  await assert.rejects(h.client.updateCard(id, card), /Unknown card destination/);
});

test('SDK card recall issues DELETE to the message endpoint with a bounded timeout', async () => {
  const originalAdapter = Lark.defaultHttpInstance.defaults.adapter;
  const requests: Array<{ url?: string; method?: string; timeout?: number }> = [];
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    requests.push({ url: config.url, method: config.method, timeout: config.timeout });
    return {
      config, status: 200, statusText: 'OK', headers: {},
      data: config.url?.includes('/auth/')
        ? { code: 0, tenant_access_token: 'mock-recall-token', app_access_token: 'mock-recall-token', expire: 7200 }
        : { code: 0, data: {} },
    };
  };
  const client = new FeishuClient({
    appId: 'cli_abcdef0123456780', appSecret: 'mock-recall-secret', attachmentDir: os.tmpdir(),
    onMessage: async () => {}, onStatus: () => {}, log: () => {},
  }, { ws: { start: async () => {}, close: () => {} } });
  try {
    await client.recallCard('om_progress');
    const deleted = requests.filter(request => request.method === 'delete');
    assert.equal(deleted.length, 1);
    assert.match(deleted[0]!.url!, /\/open-apis\/im\/v1\/messages\/om_progress$/);
    assert.equal(deleted[0]!.timeout, 20_000);
  } finally { Lark.defaultHttpInstance.defaults.adapter = originalAdapter; await client.close(); }
});

test('completion adds official DONE to the original message and survives typing cleanup and shutdown', async () => {
  const created: any[] = [];
  const deleted: any[] = [];
  const h = harness({}, { messageReaction: {
    create: async (payload: any) => {
      created.push(payload);
      return { code: 0, data: { reaction_id: payload.data.reaction_type.emoji_type === 'DONE' ? 'done-id' : 'typing-id' } };
    },
    delete: async (payload: unknown) => { deleted.push(payload); return { code: 0 }; },
  } });
  const clearTyping = await h.client.startTyping('om_user');
  await h.client.markCompleted('om_user');
  assert.deepEqual(created[1], {
    path: { message_id: 'om_user' }, data: { reaction_type: { emoji_type: 'DONE' } },
  });
  await clearTyping();
  await h.client.close();
  await clearTyping();
  assert.deepEqual(deleted, [{ path: { message_id: 'om_user', reaction_id: 'typing-id' } }]);
});

test('completion failures propagate once without cleanup registration or hidden retries', async () => {
  const networkError = new Error('completion connection reset');
  const responses = [
    () => ({ code: 230001, msg: 'rejected local-test-secret' }),
    () => undefined,
    () => { throw networkError; },
  ];
  for (const [index, response] of responses.entries()) {
    let calls = 0;
    let deletes = 0;
    const h = harness({}, { messageReaction: {
      create: async () => { calls++; return response(); },
      delete: async () => { deletes++; return { code: 0 }; },
    } });
    await assert.rejects(h.client.markCompleted('om_user'), error => {
      if (index === 2) assert.equal(error, networkError);
      else {
        assert.match(String(error), index === 0 ? /添加完成表情失败.*230001/ : /添加完成表情失败.*unknown/);
        assert.doesNotMatch(String(error), /local-test-secret/);
      }
      return true;
    });
    await h.client.close();
    assert.equal(calls, 1);
    assert.equal(deletes, 0);
    assert.equal(h.logs.length, 0);
  }
});

test('SDK completion uses the reaction POST endpoint with DONE and a bounded timeout', async () => {
  const originalAdapter = Lark.defaultHttpInstance.defaults.adapter;
  const requests: Array<{ url?: string; method?: string; timeout?: number; data: unknown }> = [];
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    requests.push({ url: config.url, method: config.method, timeout: config.timeout, data: config.data });
    return {
      config, status: 200, statusText: 'OK', headers: {},
      data: config.url?.includes('/auth/')
        ? { code: 0, tenant_access_token: 'mock-done-token', app_access_token: 'mock-done-token', expire: 7200 }
        : { code: 0, data: { reaction_id: 'done-sdk-id' } },
    };
  };
  const client = new FeishuClient({
    appId: 'cli_abcdef0123456781', appSecret: 'mock-done-secret', attachmentDir: os.tmpdir(),
    onMessage: async () => {}, onStatus: () => {}, log: () => {},
  }, { ws: { start: async () => {}, close: () => {} } });
  try {
    await client.markCompleted('om_original');
    await client.close();
    const reactions = requests.filter(request => request.url?.includes('/reactions'));
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0]!.method, 'post');
    assert.match(reactions[0]!.url!, /\/open-apis\/im\/v1\/messages\/om_original\/reactions$/);
    assert.equal(reactions[0]!.timeout, 20_000);
    assert.deepEqual(JSON.parse(String(reactions[0]!.data)), { reaction_type: { emoji_type: 'DONE' } });
  } finally { Lark.defaultHttpInstance.defaults.adapter = originalAdapter; await client.close(); }
});

test('card retries reuse a UUID after an uncertain network result; distinct sends use distinct UUIDs', async () => {
  const requests: any[] = [];
  const waits: number[] = [];
  const h = harness({}, { message: { create: async (request: any) => {
    requests.push(request);
    if (requests.length === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return { code: 0, data: { message_id: 'om_recovered' } };
  } } }, async milliseconds => { waits.push(milliseconds); });
  const card = { title: '结果', text: '完成' };
  assert.equal(await h.client.sendCard('oc_chat', card), 'om_recovered');
  assert.deepEqual(requests[0], requests[1]);
  assert.match(requests[0].data.uuid, /^[a-f0-9-]{36}$/);
  assert.deepEqual(waits, [300]);
  await h.client.sendCard('oc_chat', card);
  assert.notEqual(requests[1].data.uuid, requests[2].data.uuid);
});

test('text chunks each keep their own UUID across retries', async () => {
  const requests: any[] = [];
  const attempts = new Map<string, number>();
  const h = harness({}, { message: { create: async (request: any) => {
    requests.push(request);
    const uuid = request.data.uuid as string;
    const attempt = (attempts.get(uuid) ?? 0) + 1;
    attempts.set(uuid, attempt);
    if (attempt === 1) throw { response: { status: 503 } };
    return { code: 0, data: { message_id: `om_${attempts.size}` } };
  } } });
  const text = 'a'.repeat(12_001);
  assert.equal(await h.client.sendText('oc_chat', text), 'om_2');
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[2], requests[3]);
  assert.equal(JSON.parse(requests[0].data.content).text + JSON.parse(requests[2].data.content).text, text);
});

test('only known transient network, HTTP and Feishu rate-limit errors receive bounded retries', async () => {
  const cases: Array<{ response?: any; error?: unknown; attempts: number }> = [
    ...['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].map(code => ({ error: { code }, attempts: 3 })),
    { error: { response: { status: 429 } }, attempts: 3 },
    { error: { response: { status: 502 } }, attempts: 3 },
    { error: { response: { status: 400, data: { code: 99991400 } } }, attempts: 3 },
    { response: { code: 99991400, msg: 'rate limited' }, attempts: 3 },
    { error: { response: { status: 403 }, code: 'ECONNRESET' }, attempts: 1 },
    { response: { code: 99991672, msg: 'missing permission' }, attempts: 1 },
    { response: { code: 230001, msg: 'invalid content' }, attempts: 1 },
    { error: new Error('unknown ECONNRESET-looking text'), attempts: 1 },
    { error: { code: 'ERR_CANCELED' }, attempts: 1 },
    { response: { code: 0, data: {} }, attempts: 1 },
  ];
  for (const item of cases) {
    let calls = 0;
    const waits: number[] = [];
    const uuids = new Set<string>();
    const h = harness({}, { message: { create: async (request: any) => {
      calls++; uuids.add(request.data.uuid);
      if (item.error) throw item.error;
      return item.response;
    } } }, async milliseconds => { waits.push(milliseconds); });
    await assert.rejects(h.client.sendText('oc_chat', 'hello'));
    assert.equal(calls, item.attempts);
    assert.equal(uuids.size, 1);
    assert.deepEqual(waits, item.attempts === 3 ? [300, 900] : []);
  }
});

test('card patch retries the same message and body without creating another card', async () => {
  const requests: any[] = [];
  const h = harness({}, { message: { patch: async (request: any) => {
    requests.push(request);
    if (requests.length === 1) throw { response: { status: 500 } };
    return { code: 0 };
  } } });
  await h.client.updateCard('om_existing', { title: '完成', text: '结果' });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].path.message_id, 'om_existing');
});

test('image and file message retries reuse uploaded content without repeating uploads', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-retry-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'content.png');
  await writeFile(file, Buffer.from('content'));
  for (const kind of ['image', 'file'] as const) {
    const requests: any[] = [];
    const h = harness({}, { message: { create: async (request: any) => {
      requests.push(request);
      if (requests.length === 1) throw { code: 'ECONNRESET' };
      return { code: 0, data: { message_id: 'om_uploaded' } };
    } } });
    await (kind === 'image' ? h.client.sendImage('oc_chat', file) : h.client.sendFile('oc_chat', file));
    assert.equal(kind === 'image' ? h.imageUploads.length : h.fileUploads.length, 1);
    assert.deepEqual(requests[0], requests[1]);
    let uploads = 0;
    const failed = harness({}, { [kind]: { create: async () => { uploads++; throw { code: 'ECONNRESET' }; } } });
    await assert.rejects(kind === 'image' ? failed.client.sendImage('oc_chat', file) : failed.client.sendFile('oc_chat', file));
    assert.equal(uploads, 1);
    assert.equal(failed.created.length, 0);
  }
});

test('typing cleanup shares retries, clears only after success and does not remove DONE', async () => {
  const requests: any[] = [];
  const h = harness({}, { messageReaction: {
    create: async () => ({ code: 0, data: { reaction_id: 'typing-id' } }),
    delete: async (request: any) => {
      requests.push(request);
      if (requests.length < 3) throw { code: 'ECONNRESET' };
      return { code: 0 };
    },
  } });
  const cleanup = await h.client.startTyping('om_user');
  await Promise.all([cleanup(), cleanup(), cleanup()]);
  await cleanup(); await h.client.close();
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.path.message_id === 'om_user' && request.path.reaction_id === 'typing-id'));
  assert.equal(h.logs.length, 0);
});

test('exhausted typing cleanup stays registered and shutdown makes only one final attempt', async () => {
  let calls = 0;
  const h = harness({}, { messageReaction: {
    create: async () => ({ code: 0, data: { reaction_id: 'typing-id' } }),
    delete: async () => { calls++; throw { code: 'ECONNRESET' }; },
  } });
  const cleanup = await h.client.startTyping('om_user');
  await cleanup();
  assert.equal(calls, 3);
  assert.ok(h.logs.some(text => text.includes('表情可能仍保留')));
  await h.client.close();
  assert.equal(calls, 4);
});

test('shutdown cancels a pending typing backoff and shares cleanup instead of retrying', async () => {
  let calls = 0;
  let waiting!: () => void;
  const backoff = new Promise<void>(resolve => { waiting = resolve; });
  const h = harness({}, { messageReaction: {
    create: async () => ({ code: 0, data: { reaction_id: 'typing-id' } }),
    delete: async () => { calls++; throw { code: 'ECONNRESET' }; },
  } }, async (_milliseconds, signal) => {
    waiting();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  const cleanup = await h.client.startTyping('om_user');
  const clearing = cleanup();
  await backoff;
  await h.client.close();
  await clearing;
  assert.equal(calls, 1);
  assert.ok(h.wsClosed);
  assert.ok(h.logs.some(text => text.includes('表情可能仍保留')));
});

test('shutdown cancels message retries without starting another UUID or attempt', async () => {
  let calls = 0;
  let waiting!: () => void;
  const backoff = new Promise<void>(resolve => { waiting = resolve; });
  const failure = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  const h = harness({}, { message: { create: async () => { calls++; throw failure; } } }, async (_milliseconds, signal) => {
    waiting();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  const sent = assert.rejects(h.client.sendCard('oc_chat', { title: '结果', text: '已完成' }), error => error === failure);
  await backoff;
  await h.client.close();
  await sent;
  assert.equal(calls, 1);
});

test('SDK retry preserves message UUID and timeout in the actual HTTP payload', async () => {
  const originalAdapter = Lark.defaultHttpInstance.defaults.adapter;
  const sent: Array<{ uuid: string; content: string }> = [];
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    const authentication = config.url?.includes('/auth/');
    if (!authentication) {
      sent.push(JSON.parse(String(config.data)));
      assert.equal(config.timeout, 20_000);
      if (sent.length === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    }
    return {
      config, status: 200, statusText: 'OK', headers: {},
      data: authentication
        ? { code: 0, tenant_access_token: 'mock-retry-token', app_access_token: 'mock-retry-token', expire: 7200 }
        : { code: 0, data: { message_id: 'om_retry', chat_id: 'oc_chat' } },
    };
  };
  const client = new FeishuClient({
    appId: 'cli_abcdef0123456782', appSecret: 'mock-retry-secret', attachmentDir: os.tmpdir(),
    onMessage: async () => {}, onStatus: () => {}, log: () => {},
  }, { ws: { start: async () => {}, close: () => {} }, retryDelay: async () => {} });
  try {
    assert.equal(await client.sendCard('oc_chat', { title: '完成', text: '结果' }), 'om_retry');
    assert.equal(sent.length, 2);
    assert.match(sent[0]!.uuid, /^[a-f0-9-]{36}$/);
    assert.deepEqual(sent[0], sent[1]);
  } finally { Lark.defaultHttpInstance.defaults.adapter = originalAdapter; await client.close(); }
});

test('guarded card creation and updates stop retries when publication is revoked', async () => {
  for (const update of [false, true]) {
    let allowed = true;
    let calls = 0;
    const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const request = async () => { calls++; throw failure; };
    const h = harness({}, { message: { create: request, patch: request } }, async () => { allowed = false; });
    const options = { canSend: () => allowed };
    const card = { title: '咨询答复', text: '分析' };
    try {
      await assert.rejects(update ? h.client.updateCard('om_card', card, options) : h.client.sendCard('oc_chat', card, options), /发送已取消|授权已变化/);
      assert.equal(calls, 1);
      await assert.rejects(h.client.sendCard('oc_chat', card, options), /发送已取消|授权已变化/);
      assert.equal(calls, 1);
    } finally { await h.client.close(); }
  }
});

test('consultation abort cancels publication backoff without another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  let waiting!: () => void;
  const backoff = new Promise<void>(resolve => { waiting = resolve; });
  const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const h = harness({}, { message: { create: async () => { calls++; throw failure; } } }, async (_milliseconds, signal) => {
    waiting();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  try {
    const rejected = assert.rejects(h.client.sendCard('oc_chat', { title: '咨询答复', text: '分析' }, { signal: controller.signal }), error => error === failure);
    await backoff;
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
  } finally { await h.client.close(); }
});

test('guarded SDK card calls pass cancellation to the actual HTTP request', async () => {
  const originalAdapter = Lark.defaultHttpInstance.defaults.adapter;
  let calls = 0;
  let started!: () => void;
  let observedSignal: AbortSignal | undefined;
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    if (!config.url?.includes('/auth/')) {
      calls++;
      observedSignal = config.signal as AbortSignal;
      started();
      await new Promise<void>((_resolve, reject) => observedSignal!.addEventListener('abort', () => reject(observedSignal!.reason), { once: true }));
    }
    return { config, status: 200, statusText: 'OK', headers: {},
      data: { code: 0, tenant_access_token: 'mock-cancel-token', app_access_token: 'mock-cancel-token', expire: 7200 } };
  };
  const client = new FeishuClient({
    appId: 'cli_abcdef0123456783', appSecret: 'mock-cancel-secret', attachmentDir: os.tmpdir(),
    onMessage: async () => {}, onStatus: () => {}, log: () => {},
  }, { ws: { start: async () => {}, close: () => {} }, retryDelay: async () => {} });
  try {
    for (const update of [false, true]) {
      const controller = new AbortController();
      const sent = new Promise<void>(resolve => { started = resolve; });
      const card = { title: '咨询答复', text: '分析' };
      const rejected = assert.rejects(update ? client.updateCard('om_card', card, { signal: controller.signal })
        : client.sendCard('oc_chat', card, { signal: controller.signal }), /cancel|stop/i);
      await sent;
      assert.ok(observedSignal);
      controller.abort(new Error('consultation stopped'));
      await rejected;
      assert.equal(observedSignal.aborted, true);
    }
    assert.equal(calls, 2);
  } finally { Lark.defaultHttpInstance.defaults.adapter = originalAdapter; await client.close(); }
});

test('publication authorization is rechecked after asynchronous SDK token lookup', async () => {
  const originalAdapter = Lark.defaultHttpInstance.defaults.adapter;
  let allowed = true;
  let messageRequests = 0;
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    if (config.url?.includes('/auth/')) allowed = false;
    else messageRequests++;
    return { config, status: 200, statusText: 'OK', headers: {},
      data: { code: 0, tenant_access_token: 'mock-revoked-token', app_access_token: 'mock-revoked-token', expire: 7200 } };
  };
  const client = new FeishuClient({
    appId: 'cli_abcdef0123456784', appSecret: 'mock-revoked-secret', attachmentDir: os.tmpdir(),
    onMessage: async () => {}, onStatus: () => {}, log: () => {},
  }, { ws: { start: async () => {}, close: () => {} }, retryDelay: async () => {} });
  try {
    await assert.rejects(client.sendCard('oc_chat', { title: '咨询答复', text: '分析' }, { canSend: () => allowed }), /授权已变化/);
    assert.equal(messageRequests, 0);
  } finally { Lark.defaultHttpInstance.defaults.adapter = originalAdapter; await client.close(); }
});

test('trusted card mentions render a separate native mention before the question', () => {
  const card = renderCard({ title: '产品', text: '请分析登录校验要求。', mention: { openId: 'ou_developer-1_2' } }, 'oc_chat', 'secret') as any;
  assert.deepEqual(card.elements, [
    { tag: 'markdown', content: '<at id=ou_developer-1_2></at>' },
    { tag: 'markdown', content: '请分析登录校验要求。' },
  ]);
});

test('card mentions reject invalid identifiers instead of emitting markup or mentioning everyone', () => {
  for (const openId of ['all', 'cli_developer', 'ou_', 'ou_developer"', 'ou_developer></at><at id=all', 'ou_developer\n', `ou_${'x'.repeat(181)}`]) {
    assert.throws(() => renderCard({ title: '产品', text: '问题', mention: { openId } }, 'oc_chat', 'secret'), /open_id 无效/);
  }
});

test('ordinary cards preserve their elements and do not infer mentions from plain text', () => {
  assert.deepEqual(renderCard({ title: '产品', text: '@开发 请分析登录校验要求。', tone: 'green' }, 'oc_chat', 'secret'), {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '产品' } },
    elements: [{ tag: 'markdown', content: '@开发 请分析登录校验要求。' }],
  });
});
