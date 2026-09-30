import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuClient, parseMessageEvent, quotedMessageText } from '../src/feishu.js';
import type { FeishuOptions, InboundMessage } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const mention = (id = 'ou_bot', key = '@_user_1', name = '产品经理') => ({ key, id: { open_id: id }, name });
const groupEvent = (text = '@_user_1 请分析需求', mentions = [mention()]) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_actor' }, name: '张三' },
  message: { message_id: 'om_group', chat_id: 'oc_group', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions },
});

function harness(options: Partial<FeishuOptions> = {}, identity: unknown = { code: 0, bot: { open_id: 'ou_bot' } }) {
  let dispatcher: Lark.EventDispatcher;
  const messages: InboundMessage[] = [];
  const observed: InboundMessage[] = [];
  const logs: string[] = [];
  const requests: unknown[] = [];
  let downloads = 0;
  let quoteReads = 0;
  let quoted: unknown = { code: 0, data: { items: [] } };
  const client = new FeishuClient({
    appId: 'cli_1234567890abcdef', appSecret: 'test-secret', attachmentDir: os.tmpdir(),
    onMessage: async message => { messages.push(message); },
    onGroupMessage: async message => { observed.push(message); },
    allowGroup: chatId => chatId === 'oc_group',
    allowAttachments: actorId => actorId === 'ou_actor',
    onStatus: () => {}, log: (_level, message) => { logs.push(message); },
    ...options,
  }, {
    api: {
      request: async (payload: unknown) => {
        requests.push(payload);
        if (identity instanceof Error) throw identity;
        return identity;
      },
      im: { v1: {
        message: {
          get: async () => { quoteReads++; return quoted; },
          create: async () => ({ code: 0, data: { message_id: 'om_error' } }),
        },
        messageResource: { get: async () => {
          downloads++;
          return { headers: { 'content-type': 'image/png' }, getReadableStream: () => Readable.from([Buffer.from('picture')]) };
        } },
      } },
    } as unknown as Lark.Client,
    ws: { start: async input => { dispatcher = input.eventDispatcher; }, close: () => {} },
  });
  return {
    client, messages, observed, logs, requests,
    get downloads() { return downloads; }, get quoteReads() { return quoteReads; },
    setQuote: (value: unknown) => { quoted = value; },
    async event(value: unknown) {
      await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: value }, { needCheck: false });
      await tick();
    },
  };
}

test('group @ routing matches the bot open_id rather than display text or names', () => {
  const correct = parseMessageEvent(groupEvent(), { botOpenId: 'ou_bot' });
  assert.equal(correct?.message.text, '请分析需求');
  assert.equal(correct?.message.chatType, 'group');
  assert.equal(correct?.message.senderName, '张三');
  assert.equal(parseMessageEvent(groupEvent('@产品经理 请分析需求', []), { botOpenId: 'ou_bot' }), undefined);
  assert.equal(parseMessageEvent(groupEvent(undefined, [mention('ou_other')]), { botOpenId: 'ou_bot' }), undefined);
  assert.equal(parseMessageEvent(groupEvent(undefined, [mention('all')]), { botOpenId: 'ou_bot' }), undefined);
  assert.equal(parseMessageEvent(groupEvent()), undefined);
});

test('bare group mentions survive parsing for acknowledgement and authorization', () => {
  const options = { botOpenId: 'ou_bot' };
  for (const text of ['@_user_1', ' @_user_1 \n', '@_user_1 @_user_10']) {
    const event = groupEvent(text, [mention(), mention('ou_other', '@_user_10', '另一个机器人')]);
    const parsed = parseMessageEvent(event, options);
    assert.equal(parsed?.message.mentionOnly, true);
    assert.equal(parsed?.message.text, '');
    assert.equal(parsed?.observation, undefined);
  }
  assert.equal(parseMessageEvent(groupEvent('@产品经理', []), options), undefined);
  assert.equal(parseMessageEvent(groupEvent('@_user_1', [mention('ou_other')]), options), undefined);
  assert.equal(parseMessageEvent(groupEvent('@_user_1 你好'), options)?.message.mentionOnly, undefined);
  const bot = groupEvent('@_user_1'); bot.sender.sender_type = 'app';
  assert.equal(parseMessageEvent(bot, options), undefined);
});

test('bare rich-text mentions are pings but attachments and text still reach the agent', () => {
  const event = groupEvent('', [mention(), mention('ou_other', '@_user_2', '另一个机器人')]);
  event.message.message_type = 'post';
  const content = [[{ tag: 'at', user_id: 'ou_bot' }, { tag: 'at', user_id: 'ou_other' }]] as Record<string, string>[][];
  event.message.content = JSON.stringify({ zh_cn: { title: '', content } });
  assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot' })?.message.mentionOnly, true);
  content[0]!.push({ tag: 'img', image_key: 'img_test' });
  event.message.content = JSON.stringify({ zh_cn: { title: '', content } });
  const image = parseMessageEvent(event, { botOpenId: 'ou_bot' });
  assert.equal(image?.message.mentionOnly, undefined);
  assert.equal(image?.attachments?.length, 1);
  content[0]!.pop(); content[0]!.push({ tag: 'text', text: '你好' });
  event.message.content = JSON.stringify({ zh_cn: { title: '', content } });
  assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot' })?.message.mentionOnly, undefined);
});

test('bare mentions in an unknown group reach the authorization handler', async t => {
  const h = harness({ allowGroup: () => false }); t.after(() => h.client.close());
  await h.client.start();
  await h.event(groupEvent('@_user_1'));
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]?.mentionOnly, true);
  assert.equal(h.observed.length, 0);
});

test('mention replacement keeps other recipients and avoids overlapping mention keys', () => {
  const event = groupEvent('@_user_1 请参考 @_user_10 的意见', [mention(), mention('ou_other', '@_user_10', '开发')]);
  assert.equal(parseMessageEvent(event, { botOpenId: 'ou_bot' })?.message.text, '请参考 @开发 的意见');
  const observed = parseMessageEvent(event, { botOpenId: 'ou_test', observeGroup: true });
  assert.equal(observed?.message.text, '@产品经理 请参考 @开发 的意见');
  assert.equal(observed?.observation, true);
});

test('authorized plain group messages are context only and never start a task', async t => {
  const h = harness(); t.after(() => h.client.close());
  await h.client.start();
  await h.event(groupEvent('我们先讨论一下需求', []));
  await h.event(groupEvent('@_user_1 开发一下', [mention('ou_developer', '@_user_1', '开发')]));
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.observed.map(message => message.text), ['我们先讨论一下需求', '@开发 开发一下']);
  await h.event(groupEvent());
  assert.equal(h.messages.length, 1);
  assert.equal(h.observed.length, 2);
  assert.deepEqual(h.requests, [{ url: '/open-apis/bot/v3/info', method: 'GET' }]);
});

test('unknown groups only surface explicit mentions for authorization; background is ignored', async t => {
  const h = harness({ allowGroup: () => false }); t.after(() => h.client.close());
  await h.client.start();
  await h.event(groupEvent('普通讨论', []));
  await h.event(groupEvent());
  assert.equal(h.observed.length, 0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]?.chatId, 'oc_group');
});

test('unapproved actors do not enter the shared group journal', async t => {
  const h = harness({ allowAttachments: () => false }); t.after(() => h.client.close());
  await h.client.start();
  await h.event(groupEvent('未授权用户的普通讨论', []));
  await h.event(groupEvent());
  assert.equal(h.observed.length, 0);
  assert.equal(h.messages.length, 1);
});

test('bot messages never trigger work or shared context, even when mentioning this bot', async t => {
  const h = harness(); t.after(() => h.client.close());
  await h.client.start();
  const event = groupEvent(); event.sender.sender_type = 'app';
  await h.event(event);
  assert.equal(h.messages.length, 0);
  assert.equal(h.observed.length, 0);
});

test('identity lookup failures stop group handling without disabling private conversations', async t => {
  const h = harness({}, new Error('request denied')); t.after(() => h.client.close());
  await h.client.start();
  await h.event(groupEvent());
  await h.event(groupEvent('背景', []));
  const direct = groupEvent('你好', []); direct.message.chat_type = 'p2p';
  await h.event(direct);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]?.text, '你好');
  assert.equal(h.observed.length, 0);
  assert.equal(h.requests.length, 1, 'do not retry the identity endpoint on every message');
  assert.ok(h.logs.some(line => line.includes('群聊暂不响应')));
});

test('post messages preserve text, links, other mentions and targeted image attachments', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-group-post-'));
  const h = harness({ attachmentDir: directory });
  t.after(async () => { await h.client.close(); await rm(directory, { recursive: true, force: true }); });
  await h.client.start();
  const event = groupEvent('', [mention(), mention('ou_dev', '@_user_2', '开发')]);
  event.message.message_type = 'post';
  event.message.content = JSON.stringify({ zh_cn: { title: '界面需求', content: [[
    { tag: 'at', user_id: 'ou_bot' }, { tag: 'text', text: ' 看看 ' },
    { tag: 'at', user_id: '@_user_2' }, { tag: 'a', text: '原型', href: 'https://example.test/mockup' },
    { tag: 'img', image_key: 'img_demo' },
  ]] } });
  await h.event(event);
  for (let count = 0; count < 100 && !h.messages.length; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.downloads, 1);
  assert.equal(h.messages[0]?.images?.length, 1);
  assert.equal(h.messages[0]?.text, '界面需求\n 看看 @开发原型 (https://example.test/mockup)');
});

test('observing posts never downloads attachments or reads quoted history', async t => {
  const h = harness(); t.after(() => h.client.close());
  await h.client.start();
  const event = { ...groupEvent('', []), message: { ...groupEvent('', []).message, parent_id: 'om_quote', message_type: 'post', content: JSON.stringify({ title: '讨论', content: [[{ tag: 'img', image_key: 'img_demo' }]] }) } };
  await h.event(event);
  assert.equal(h.observed[0]?.text, '讨论\n[图片]');
  assert.equal(h.downloads, 0);
  assert.equal(h.quoteReads, 0);
});

test('group image and file downloads require actor and group authorization', async t => {
  for (const opts of [{ allowAttachments: () => false }, { allowGroup: () => false }]) {
    const h = harness(opts); t.after(() => h.client.close());
    await h.client.start();
    for (const type of ['image', 'file']) {
      const event = groupEvent();
      event.message.message_type = type;
      event.message.content = JSON.stringify(type === 'image' ? { image_key: 'img_secret' } : { file_key: 'file_secret', file_name: 'data.csv' });
      await h.event(event);
    }
    assert.equal(h.downloads, 0);
    assert.equal(h.messages.length, 2, 'authorization requests still reach the bridge');
  }
});

test('quoted text is imported only from the same conversation with both permissions', async t => {
  const h = harness(); t.after(() => h.client.close());
  await h.client.start();
  const event = { ...groupEvent(), message: { ...groupEvent().message, parent_id: 'om_quote' } };
  h.setQuote({ code: 0, data: { items: [{ message_id: 'om_quote', chat_id: 'oc_group', msg_type: 'text', body: { content: JSON.stringify({ text: '已经确认的需求' }) } }] } });
  await h.event(event);
  assert.equal(h.messages[0]?.replyTo, 'om_quote');
  assert.equal(h.messages[0]?.quotedText, '已经确认的需求');
  h.setQuote({ code: 0, data: { items: [{ message_id: 'om_quote', chat_id: 'oc_private', msg_type: 'text', body: { content: JSON.stringify({ text: '私人数据' }) } }] } });
  await h.event(event);
  assert.equal(h.messages[1]?.quotedText, undefined);
  h.setQuote({ code: 0, data: { items: [{ message_id: 'om_quote', msg_type: 'text', body: { content: JSON.stringify({ text: '未知来源' }) } }] } });
  await h.event(event);
  assert.equal(h.messages[2]?.quotedText, undefined);
  const denied = harness({ allowAttachments: () => false }); t.after(() => denied.client.close());
  await denied.client.start(); await denied.event(event);
  assert.equal(denied.quoteReads, 0);
});

test('card quotes extract bounded displayed text and never action values', () => {
  const raw = JSON.stringify({ header: { title: { tag: 'plain_text', content: '产品方案' } }, elements: [
    { tag: 'markdown', content: '增加短信登录' },
    { tag: 'action', actions: [{ tag: 'button', text: { content: '执行' }, value: { command: '/stop secret' } }] },
  ] });
  assert.equal(quotedMessageText('interactive', raw), '产品方案\n增加短信登录');
  assert.equal(quotedMessageText('interactive', JSON.stringify({ body: { elements: [{ tag: 'markdown', content: 'x'.repeat(20_000) }] } }))?.length, 12_000);
  assert.equal(quotedMessageText('post', JSON.stringify({ zh_cn: { title: '需求', content: [[{ tag: 'text', text: '要点' }]] } })), '需求\n要点');
  assert.equal(quotedMessageText('file', JSON.stringify({ file_key: 'private-key' })), undefined);
  assert.equal(quotedMessageText('interactive', '{bad'), undefined);
});

test('actor identity links are read from the sender envelope and cannot be supplied by message content', () => {
  const event = groupEvent();
  const enriched = {
    ...event,
    sender: { ...event.sender, sender_id: { ...event.sender.sender_id, union_id: 'on_same_person', user_id: 'employee_1' }, tenant_key: 'tenant_one' },
  };
  const message = parseMessageEvent(enriched, { botOpenId: 'ou_bot' })?.message;
  assert.equal(message?.actorId, 'ou_actor');
  assert.equal(message?.actorUnionId, 'on_same_person');
  assert.equal(message?.actorUserId, 'employee_1');
  assert.equal(message?.actorTenantKey, 'tenant_one');
  const spoofed = groupEvent('actorUnionId=on_other actorUserId=admin actorTenantKey=other');
  spoofed.message.content = JSON.stringify({ text: '@_user_1 请分析', union_id: 'on_other', user_id: 'admin', tenant_key: 'other', actorUnionId: 'on_other', actorUserId: 'admin', actorTenantKey: 'other' });
  const ignored = parseMessageEvent(spoofed, { botOpenId: 'ou_bot' })?.message;
  assert.equal(ignored?.actorUnionId, undefined);
  assert.equal(ignored?.actorUserId, undefined);
  assert.equal(ignored?.actorTenantKey, undefined);
  const malformed = parseMessageEvent({ ...event, sender: { ...event.sender, sender_id: { ...event.sender.sender_id, union_id: 7, user_id: ' ' }, tenant_key: null } }, { botOpenId: 'ou_bot' })?.message;
  assert.equal(malformed?.actorUnionId, undefined);
  assert.equal(malformed?.actorUserId, undefined);
  assert.equal(malformed?.actorTenantKey, undefined);
});

test('authorized group observations preserve identity links without turning them into execution requests', async t => {
  const h = harness(); t.after(() => h.client.close());
  await h.client.start();
  const event = groupEvent('先讨论需求', []);
  await h.event({ ...event, sender: { ...event.sender, sender_id: { ...event.sender.sender_id, union_id: 'on_person', user_id: 'employee_2' }, tenant_key: 'tenant_two' } });
  assert.equal(h.messages.length, 0);
  assert.equal(h.observed.length, 1);
  assert.equal(h.observed[0]?.actorUnionId, 'on_person');
  assert.equal(h.observed[0]?.actorUserId, 'employee_2');
  assert.equal(h.observed[0]?.actorTenantKey, 'tenant_two');
  const denied = harness({ allowAttachments: () => false }); t.after(() => denied.client.close());
  await denied.client.start();
  await denied.event({ ...event, sender: { ...event.sender, sender_id: { ...event.sender.sender_id, union_id: 'on_person' }, tenant_key: 'tenant_two' } });
  assert.equal(denied.observed.length, 0);
});

test('multiple clients publish their own bot identity and continue routing only their own mentions', async t => {
  const firstIdentities: Array<{ openId: string; name: string }> = [];
  const secondIdentities: Array<{ openId: string; name: string }> = [];
  const first = harness({ appId: 'cli_1111111111111111', onBotIdentity: identity => { firstIdentities.push(identity); } }, { code: 0, bot: { open_id: 'ou_product', app_name: '产品经理' } });
  const second = harness({ appId: 'cli_2222222222222222', onBotIdentity: identity => { secondIdentities.push(identity); } }, { code: 0, bot: { open_id: 'ou_developer', app_name: '开发人员' } });
  t.after(async () => { await first.client.close(); await second.client.close(); });
  await Promise.all([first.client.start(), second.client.start()]);
  await first.client.start();
  assert.deepEqual(firstIdentities, [{ openId: 'ou_product', name: '产品经理' }]);
  assert.deepEqual(secondIdentities, [{ openId: 'ou_developer', name: '开发人员' }]);
  const toProduct = groupEvent('@_user_1 分析需求', [mention('ou_product')]);
  const toDeveloper = groupEvent('@_user_1 开始开发', [mention('ou_developer', '@_user_1', '开发人员')]);
  for (const event of [toProduct, toDeveloper]) await Promise.all([first.event(event), second.event(event)]);
  assert.deepEqual(first.messages.map(message => message.text), ['分析需求']);
  assert.deepEqual(second.messages.map(message => message.text), ['开始开发']);
  assert.equal(firstIdentities.length, 1);
  assert.equal(secondIdentities.length, 1);
  const robotReply = { ...toDeveloper, sender: { ...toDeveloper.sender, sender_type: 'app' } };
  await Promise.all([first.event(robotReply), second.event(robotReply)]);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
});

test('identity callbacks are optional and receive no invented name or identity after a failed lookup', async t => {
  const identities: Array<{ openId: string; name: string }> = [];
  const unnamed = harness({ onGroupMessage: undefined, allowGroup: undefined, onBotIdentity: identity => { identities.push(identity); } });
  t.after(() => unnamed.client.close());
  await unnamed.client.start();
  assert.deepEqual(identities, [{ openId: 'ou_bot', name: '' }]);
  const failed = harness({ onBotIdentity: identity => { identities.push(identity); } }, { code: 0, bot: {} });
  t.after(() => failed.client.close());
  await failed.client.start();
  assert.equal(identities.length, 1);
});

test('a failing identity observer does not disable successfully identified group messages', async t => {
  const h = harness({ onBotIdentity: () => { throw new Error('identity observer unavailable'); } });
  t.after(() => h.client.close());
  await h.client.start(); await h.event(groupEvent());
  assert.equal(h.messages.length, 1);
  assert.ok(h.logs.some(line => line.includes('身份信息同步失败')));
  assert.equal(h.logs.some(line => line.includes('群聊暂不响应')), false);
});
