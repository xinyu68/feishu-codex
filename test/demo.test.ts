import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRequest } from '../ui/src/demo.ts';
import type { AppState, BotProfile } from '../ui/src/types.ts';

test('demo API preserves multi-bot settings, authorization isolation and public response shapes', async t => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  let changes = 0;
  events.addEventListener('demo-change', () => { changes += 1; });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://demo.local' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Demo mode must not make network requests'); });
  const read = () => demoRequest('/api/state') as Promise<AppState>;
  const bot = (state: AppState, id: string) => state.bots!.find(item => item.id === id)!;

  await t.test('initial state has separate bots and cloned public data', async () => {
    const state = await read();
    assert.deepEqual(state.bots!.map(item => item.id), ['default', 'product']);
    assert.ok(state.bots!.every(item => item.engine === 'codex'));
    assert.equal(bot(state, 'product').appId, 'cli_demoproduct');
    assert.equal(state.bots!.every(item => /^cli_[a-zA-Z0-9]+$/.test(item.appId)), true);
    assert.equal(state.connectionSummary?.connected, 2);
    assert.equal(state.connectionSummary?.total, 2);
    assert.equal(state.pendingGroups?.[0]?.botId, 'product');
    assert.equal(state.config.desktopNotificationTarget?.botAppId, 'cli_demo');
    const response = await demoRequest('/api/bots') as { bots: BotProfile[] };
    response.bots[0]!.allowedActors.push('ou_external_mutation');
    assert.equal(bot(await read(), 'default').allowedActors.includes('ou_external_mutation'), false);
  });

  await t.test('roles and group background remain independent across bots and scopes', async () => {
    await demoRequest('/api/bots/product', { roleInstructions: '  群聊产品角色  ', privateRoleInstructions: '私聊产品角色', includeGroupContext: false, model: 'demo-model', effort: 'low' }, 'PATCH');
    const response = await demoRequest('/api/bots/default', { privateRoleInstructions: '  私聊开发角色  ' }, 'PATCH') as { bot: BotProfile };
    assert.equal(response.bot.privateRoleInstructions, '私聊开发角色');
    const state = await read();
    assert.equal(bot(state, 'product').roleInstructions, '群聊产品角色');
    assert.equal(bot(state, 'product').privateRoleInstructions, '私聊产品角色');
    assert.equal(bot(state, 'product').includeGroupContext, false);
    assert.equal(bot(state, 'default').includeGroupContext, true);
    assert.notEqual(bot(state, 'default').roleInstructions, '群聊产品角色');
    assert.equal(state.config.model, '');
    const before = changes;
    await assert.rejects(demoRequest('/api/bots/product', { name: '不得部分保存', includeGroupContext: 'false' }, 'PATCH'), /补充群聊背景/);
    assert.equal(bot(await read(), 'product').name, '产品助手（演示）');
    assert.equal(changes, before);
  });

  await t.test('the default notification bot can be replaced or cleared without changing conversations', async () => {
    const before = await read();
    const { chatId, actorId, botAppId } = before.notificationTargets!.find(item => item.botId === 'product')!;
    const selected = { chatId, actorId, botAppId };
    await demoRequest('/api/config', { desktopNotificationTarget: selected }, 'PUT');
    await demoRequest('/api/bots/default', { name: 'Codex' }, 'PATCH');
    assert.deepEqual((await read()).config.desktopNotificationTarget, selected);
    assert.deepEqual((await read()).conversations, before.conversations);
    await demoRequest('/api/config', { desktopNotificationTarget: null }, 'PUT');
    await demoRequest('/api/bots/product', { name: '产品助手（演示）' }, 'PATCH');
    assert.equal((await read()).config.desktopNotificationTarget, null);
    assert.equal((await read()).config.autoNotifyDesktop, before.config.autoNotifyDesktop);
  });

  await t.test('permission decisions only affect the selected bot and pending requests', async () => {
    await demoRequest('/api/actors', { botId: 'default', actorId: 'ou_demo_pending', allow: true });
    await demoRequest('/api/groups', { botId: 'default', chatId: 'oc_demo_pending', allow: true });
    let state = await read();
    assert.equal(state.pendingActors.length, 1);
    assert.equal(state.pendingGroups!.length, 1);
    assert.equal(bot(state, 'product').allowedActors.includes('ou_demo_pending'), false);
    assert.equal(bot(state, 'product').allowedGroups.includes('oc_demo_pending'), false);
    await demoRequest('/api/actors', { botId: 'product', actorId: 'ou_demo_pending', allow: true });
    await demoRequest('/api/groups', { botId: 'product', chatId: 'oc_demo_pending', allow: true });
    await demoRequest('/api/actors', { botId: 'default', actorId: 'ou_demo_pending', allow: false });
    state = await read();
    assert.equal(state.pendingActors.length, 0);
    assert.equal(state.pendingGroups!.length, 0);
    assert.equal(bot(state, 'default').allowedActors.includes('ou_demo_pending'), false);
    assert.equal(bot(state, 'product').allowedActors.includes('ou_demo_pending'), true);
    assert.deepEqual(state.config.allowedActors, bot(state, 'default').allowedActors);
  });

  await t.test('credential validation is atomic and secrets are omitted from every public response', async () => {
    const secret = 'demo-only-secret-must-never-be-returned';
    const previous = await read();
    const before = changes;
    await assert.rejects(demoRequest('/api/bots/product/credentials', { appId: 'cli_demo', appSecret: secret }), /另一个机器人/);
    await assert.rejects(demoRequest('/api/bots/product/credentials', { appId: 'cli_demoreplacement', appSecret: ' ' }), /App Secret/);
    assert.deepEqual(await read(), previous);
    assert.equal(changes, before);
    const response = await demoRequest('/api/bots/product/credentials', { appId: 'cli_demoreplacement', appSecret: secret }) as { config: AppState['config']; connection: AppState['connection']; bot: BotProfile };
    assert.equal(response.bot.appId, 'cli_demoreplacement');
    assert.equal(response.connection.status, 'connected');
    assert.equal(response.bot.hasSecret, true);
    assert.deepEqual(response.bot.allowedActors, []);
    assert.deepEqual(response.bot.allowedGroups, []);
    assert.equal(response.bot.privateRoleInstructions, '私聊产品角色');
    assert.equal(response.config.appId, 'cli_demo');
    await demoRequest('/api/bots/product/credentials', { appId: 'cli_demoreplacement', appSecret: '' });
    for (const result of [response, await read(), await demoRequest('/api/bots')]) {
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(JSON.stringify(result).includes('appSecret'), false);
    }
  });

  await t.test('connection summary follows each bot and legacy settings only synchronize the default', async () => {
    await demoRequest('/api/bots/product/connection', { enabled: false });
    let state = await read();
    assert.equal(state.connection.status, 'connected');
    assert.equal(state.connectionSummary!.connected, 1);
    assert.equal(bot(state, 'product').enabled, false);
    const response = await demoRequest('/api/config', { model: 'default-model', effort: 'medium', progress: false, appSecret: '' }, 'PUT') as { config: AppState['config'] };
    assert.equal(response.config.model, 'default-model');
    state = await read();
    assert.equal(bot(state, 'default').model, 'default-model');
    assert.equal(bot(state, 'product').model, 'demo-model');
    assert.equal(bot(state, 'product').effort, 'low');
    assert.equal(state.config.hasSecret, true);
    assert.equal(state.config.progress, false);
    await demoRequest('/api/bots/default', { effort: 'high' }, 'PATCH');
    assert.equal((await read()).config.effort, 'high');
    await demoRequest('/api/connection', { enabled: false });
    state = await read();
    assert.equal(state.connection.status, 'stopped');
    assert.equal(state.connectionSummary!.status, 'stopped');
    assert.equal(state.config.enabled, false);
  });

  await t.test('creation and deletion respect methods and preserve existing conversations', async () => {
    const before = await read();
    await assert.rejects(demoRequest('/api/bots', { name: '重复', appId: 'CLI_DEMO', appSecret: 'demo-secret' }), /另一个机器人/);
    assert.equal((await read()).bots!.length, before.bots!.length);
    const response = await demoRequest('/api/bots', { name: ' 演示审阅助手 ', appId: 'cli_demoreview', appSecret: 'demo-secret', roleInstructions: '审阅群聊内容', privateRoleInstructions: '审阅个人笔记', includeGroupContext: false }) as { id: string; bot: BotProfile; connection: AppState['connection'] };
    assert.equal(response.id, response.bot.id);
    assert.equal(response.bot.name, '演示审阅助手');
    assert.equal(response.bot.privateRoleInstructions, '审阅个人笔记');
    assert.equal(response.bot.includeGroupContext, false);
    assert.equal(response.bot.engine, 'codex');
    assert.equal(response.connection.status, 'connected');
    assert.equal((await read()).connectionSummary!.total, 3);
    await demoRequest(`/api/bots/${response.id}`, {}, 'DELETE');
    const after = await read();
    assert.equal(after.bots!.length, before.bots!.length);
    assert.deepEqual(after.conversations, before.conversations);
    await assert.rejects(demoRequest(`/api/bots/${response.id}`, { name: '不存在' }, 'PATCH'), /机器人不存在/);
  });

  await t.test('engine validation is atomic and new Hermes bots retain their selected engine', async () => {
    const previous = await read();
    const before = changes;
    for (const engine of ['unsupported', '', null, 1]) {
      await assert.rejects(demoRequest('/api/bots/default', { engine, name: 'Must not save' }, 'PATCH'), /不支持的机器人执行端/);
      await assert.rejects(demoRequest('/api/bots', { engine, name: 'Invalid engine', appId: 'cli_demoinvalid', appSecret: 'demo-secret' }), /不支持的机器人执行端/);
    }
    assert.deepEqual(await read(), previous);
    assert.equal(changes, before);
    const created = await demoRequest('/api/bots', { name: 'Hermes 演示', appId: 'cli_demohermes', appSecret: 'demo-secret', engine: 'hermes', model: 'codex-model', effort: 'high' }) as { bot: BotProfile };
    assert.equal(created.bot.engine, 'hermes');
    assert.equal(created.bot.engineStatus?.available, true);
    assert.equal(created.bot.model, '');
    assert.equal(created.bot.effort, '');
    const route = `/api/bots/${created.bot.id}`;
    await demoRequest(route, { model: 'another-codex-model', effort: 'low' }, 'PATCH');
    assert.equal(bot(await read(), created.bot.id).model, '');
    assert.equal(bot(await read(), created.bot.id).effort, '');
    const activated = await demoRequest(`${route}/credentials`, { appId: 'cli_demohermes', appSecret: '' }) as { bot: BotProfile };
    assert.equal(activated.bot.engine, 'hermes');
    const beforeRejectedCredentials = await read();
    await assert.rejects(demoRequest(route, { engine: 'codex', appId: 'cli_demohermesreplacement', appSecret: 'demo-secret' }, 'PATCH'), /删除后重新添加/);
    assert.deepEqual(await read(), beforeRejectedCredentials);
    await demoRequest(route, {}, 'DELETE');
    assert.deepEqual((await read()).conversations, previous.conversations);
  });

  await t.test('existing engines are immutable across settings and legacy routes', async () => {
    const initial = await read();
    const history = await demoRequest('/api/history?chatId=demo-feishu');
    for (const [url, method] of [['/api/bots/default', 'PATCH'], ['/api/bots/default/credentials', 'POST'], ['/api/config', 'PUT'], ['/api/credentials', 'POST']]) {
      await assert.rejects(demoRequest(url!, { engine: 'hermes', name: 'Must not save', appId: 'cli_demoreplacement', appSecret: 'demo-secret' }, method!), /删除后重新添加/);
      assert.deepEqual(await read(), initial);
    }
    assert.deepEqual(await demoRequest('/api/history?chatId=demo-feishu'), history);
  });

  await t.test('deleting the first and last bots preserves native history and allows fresh configuration', async () => {
    const initial = await read();
    const { chatId: targetChat, actorId, botAppId } = initial.notificationTargets!.find(item => item.botId === 'default')!;
    const target = { chatId: targetChat, actorId, botAppId };
    await demoRequest('/api/config', { desktopNotificationTarget: target }, 'PUT');
    await demoRequest('/api/chat', { chatId: 'demo-feishu', text: '删除测试中的在途任务' });
    await assert.rejects(demoRequest('/api/bots/default', {}, 'DELETE'), /任务或待处理请求/);
    await demoRequest('/api/bots/product', {}, 'DELETE');
    assert.deepEqual((await read()).config.desktopNotificationTarget, target);
    // Let the isolated demo reply finish before deleting its bot; no real services are used.
    await new Promise(resolve => setTimeout(resolve, 1400));
    const originalHistory = await demoRequest('/api/history?chatId=demo-feishu');
    const originalSessions = await demoRequest(`/api/sessions?cwd=${encodeURIComponent(initial.config.defaultWorkspace)}`);
    await demoRequest('/api/bots/default', {}, 'DELETE');
    const empty = await read();
    assert.deepEqual(empty.bots, []);
    assert.equal(empty.config.desktopNotificationTarget, null);
    assert.equal(empty.config.appId, '');
    assert.equal(empty.config.hasSecret, false);
    assert.equal(empty.connectionSummary?.total, 0);
    assert.equal(empty.connectionSummary?.status, 'stopped');
    assert.deepEqual(empty.conversations.map(item => item.chatId), ['local-preview']);
    assert.deepEqual((await demoRequest('/api/history?chatId=local-preview') as { messages: unknown[] }).messages, []);
    await assert.rejects(demoRequest('/api/history?chatId=demo-feishu'), /对话已移除/);
    await assert.rejects(demoRequest('/api/bots/default', { name: '迟到的保存' }, 'PATCH'), /机器人不存在/);
    await assert.rejects(demoRequest('/api/credentials', { appId: 'cli_demo', appSecret: 'demo-only-secret' }), /机器人不存在/);
    await assert.rejects(demoRequest('/api/config', { appId: 'cli_demo' }, 'PUT'), /机器人不存在/);
    await demoRequest('/api/config', { progress: true, desktopNotificationMinMinutes: 2, model: 'local-default-model' }, 'PUT');
    assert.equal((await read()).config.desktopNotificationMinMinutes, 2);
    assert.equal((await read()).config.model, 'local-default-model');
    assert.deepEqual(await demoRequest(`/api/sessions?cwd=${encodeURIComponent(initial.config.defaultWorkspace)}`), originalSessions);
    await demoRequest('/api/bind', { chatId: 'local-preview', threadId: 'desktop-workbench', cwd: initial.config.defaultWorkspace });
    assert.deepEqual(await demoRequest('/api/history?chatId=local-preview'), originalHistory);
    const replacement = await demoRequest('/api/bots', { name: '重新添加的机器人', appId: 'cli_demo', appSecret: 'demo-only-secret' }) as { bot: BotProfile };
    assert.notEqual(replacement.bot.id, 'default');
    const restored = await read();
    assert.equal(restored.bots!.length, 1);
    assert.equal(restored.bots![0]!.id, replacement.bot.id);
    assert.equal(restored.config.desktopNotificationTarget, null);
    assert.equal(restored.conversations[0]!.threadId, 'desktop-workbench');
  });
});
