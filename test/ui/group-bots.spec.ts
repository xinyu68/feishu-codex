import { expect, test, type Page } from '@playwright/test';
import type { AppState, BotProfile } from '../../ui/src/types';

test.beforeEach(({ page }) => { page.on('pageerror', error => { throw error; }); });

function fixture(): AppState {
  const now = new Date().toISOString();
  const bot = (id: string, name: string): BotProfile => ({ id, name, appId: `cli_${id}`, hasSecret: true, enabled: true,
    allowedActors: [`ou_${id}`], allowedGroups: [], roleInstructions: '', model: '', effort: '', connection: { status: 'connected' } });
  return {
    csrfToken: 'isolated-group-fixture', service: { name: 'Feishu Codex', version: 'test', uptimeSeconds: 1, startedAt: now },
    config: { appId: 'cli_default', hasSecret: true, enabled: true, allowedActors: ['ou_default'], defaultWorkspace: 'D:\\fixture', model: '', effort: '', progress: true, autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1 },
    connection: { status: 'connected' }, codex: { available: true, authenticated: true, mode: 'shared' },
    runtime: { canWrite: true, desktop: { mode: 'shared', running: true } },
    bots: [bot('default', '开发'), bot('product', '产品经理')],
    conversations: [
      { botId: 'default', botName: '开发', chatId: 'route-development', rawChatId: 'oc_team', chatType: 'group', chatTitle: '项目协作群', actorId: 'ou_default', cwd: 'D:\\fixture', threadId: 'thread-development', title: '开发会话', updatedAt: now, preview: '', busy: false, revision: 1 },
      { botId: 'product', botName: '产品经理', chatId: 'route-product', rawChatId: 'oc_team', chatType: 'group', chatTitle: '项目协作群', actorId: 'ou_product', cwd: 'D:\\fixture', threadId: 'thread-product', title: '产品会话', updatedAt: now, preview: '', busy: false, revision: 1 },
    ],
    pendingActors: [{ botId: 'product', actorId: 'ou_product_pending', chatId: 'oc_team', lastSeenAt: now }],
    pendingGroups: [{ botId: 'product', chatId: 'oc_team', title: '项目协作群', actorId: 'ou_product_pending' }],
    pendingRequests: [], logs: [],
  };
}

async function setup(page: Page, state = fixture(), url = '/') {
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  await page.addInitScript(() => {
    class SilentEventSource extends EventTarget { close() {} }
    Object.defineProperty(window, 'EventSource', { value: SilentEventSource });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'GET') reads.push(url.pathname + url.search);
    const input = method === 'GET' ? {} : route.request().postDataJSON() as Record<string, unknown>;
    if (method !== 'GET') writes.push({ path: url.pathname, method, body: input });
    let body: unknown = { ok: true };
    if (url.pathname === '/api/state') body = state;
    if (url.pathname === '/api/runtime-status') body = state.runtime;
    if (url.pathname === '/api/projects') body = { projects: [] };
    if (url.pathname === '/api/models') body = { models: [{ id: 'test-model', name: '测试模型', efforts: ['low', 'high'], defaultEffort: 'high' }] };
    if (url.pathname === '/api/sessions') body = { sessions: state.conversations.filter(item => !url.searchParams.get('chatId') || item.chatId === url.searchParams.get('chatId')).map(item => ({ id: item.threadId, cwd: item.cwd, title: item.title, updatedAt: item.updatedAt, preview: '' })) };
    if (url.pathname === '/api/history') {
      const conversation = state.conversations.find(item => item.chatId === url.searchParams.get('chatId'));
      body = { source: 'codex', threadId: conversation?.threadId, messages: conversation ? [{ id: `message-${conversation.threadId}`, role: 'assistant', text: `${conversation.botName}的独立历史` }] : [] };
    }
    if (url.pathname === '/api/bots' && method === 'POST') {
      const bot: BotProfile = { id: 'tester', name: String(input.name), engine: input.engine === 'hermes' ? 'hermes' : 'codex', appId: String(input.appId), hasSecret: true, enabled: true, allowedActors: [], allowedGroups: [], roleInstructions: String(input.roleInstructions || ''), model: '', effort: '', connection: { status: 'connected' } };
      state.bots!.push(bot); body = { bot };
    }
    if (url.pathname.startsWith('/api/bots/')) {
      const [, , , id, operation] = url.pathname.split('/');
      const bot = state.bots!.find(item => item.id === id)!;
      if (operation === 'credentials') { bot.appId = String(input.appId); bot.hasSecret = true; bot.enabled = true; bot.connection.status = 'connected'; }
      if (operation === 'connection') { bot.enabled = Boolean(input.enabled); bot.connection.status = bot.enabled ? 'connected' : 'stopped'; }
      if (method === 'PATCH') {
        if (input.engine && input.engine !== (bot.engine || 'codex')) {
          for (const conversation of state.conversations.filter(item => item.botId === id)) {
            conversation.threadId = undefined; conversation.title = '新会话'; conversation.preview = '';
          }
          bot.model = ''; bot.effort = '';
          if (input.engine === 'hermes' && state.config.desktopNotificationTarget?.botAppId === bot.appId) state.config.desktopNotificationTarget = null;
        }
        Object.assign(bot, input);
      }
      if (method === 'DELETE') {
        state.bots = state.bots!.filter(item => item.id !== id);
        state.conversations = state.conversations.filter(item => item.chatId === 'local-preview' || (item.botId || 'default') !== id);
        state.pendingActors = state.pendingActors.filter(item => (item.botId || 'default') !== id);
        state.pendingGroups = state.pendingGroups!.filter(item => item.botId !== id);
        state.notificationTargets = state.notificationTargets?.filter(item => item.botId !== id);
        if (state.config.desktopNotificationTarget?.botAppId === bot.appId) state.config.desktopNotificationTarget = null;
      }
      body = { bot };
    }
    if (url.pathname === '/api/actors') {
      const bot = state.bots!.find(item => item.id === input.botId)!;
      bot.allowedActors = bot.allowedActors.filter(id => id !== input.actorId);
      if (input.allow) bot.allowedActors.push(String(input.actorId));
      state.pendingActors = state.pendingActors.filter(item => !(item.botId === bot.id && item.actorId === input.actorId));
    }
    if (url.pathname === '/api/groups') {
      const bot = state.bots!.find(item => item.id === input.botId)!;
      bot.allowedGroups = bot.allowedGroups.filter(id => id !== input.chatId);
      if (input.allow) bot.allowedGroups.push(String(input.chatId));
      state.pendingGroups = state.pendingGroups!.filter(item => !(item.botId === bot.id && item.chatId === input.chatId));
    }
    await route.fulfill({ json: body });
  });
  await page.goto(url);
  return { state, writes, reads };
}

test('adding a bot only submits after explicit confirmation and starts with access setup', async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '添加机器人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加机器人' });
  await dialog.getByRole('textbox', { name: '机器人名称' }).fill('测试');
  await dialog.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_tester');
  await dialog.locator('input[type=password]').fill('fixture-secret');
  await expect(dialog.getByRole('textbox', { name: /角色说明/ })).toHaveCount(0);
  await dialog.getByRole('heading', { name: '添加机器人' }).click();
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: '验证并添加' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '管理测试', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /访问权限/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('开始使用', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'App ID', exact: true })).toHaveValue('cli_tester');
  await expect(page.locator('input[type=password]:visible')).toHaveValue('');
  expect(writes).toEqual([{ path: '/api/bots', method: 'POST', body: { name: '测试', engine: 'codex', appId: 'cli_tester', appSecret: 'fixture-secret' } }]);
});

test('group and actor authorization are separate and scoped to the selected bot', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('tab', { name: /访问权限/ }).click();
  await expect(page.getByText('ou_product_pending', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '允许群聊', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('tab', { name: /访问权限/ }).click();
  await expect(page.getByRole('heading', { name: '谁能使用', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '哪些群可用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许群聊', exact: true }).click();
  await expect(page.getByRole('button', { name: '允许群聊', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '允许访问', exact: true })).toBeVisible();
  expect(state.bots![0].allowedGroups).toEqual([]);
  expect(state.bots![1].allowedActors).toEqual(['ou_product']);
  await page.getByRole('button', { name: '允许访问', exact: true }).click();
  await expect(page.getByRole('button', { name: '允许访问', exact: true })).not.toBeVisible();
  expect(writes.map(item => item.body)).toEqual([
    { botId: 'product', chatId: 'oc_team', allow: true }, { botId: 'product', actorId: 'ou_product_pending', allow: true },
  ]);
  expect(state.bots![0].allowedActors).toEqual(['ou_default']);
});

test('switching a group role changes its preview and operations keep the opaque route key', async ({ page }) => {
  const { writes, reads } = await setup(page);
  await expect(page.locator('.conversation-source')).toHaveText('开发 · 群聊 / 项目协作群');
  await expect(page.getByText('开发的独立历史', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '飞书对话' }).selectOption('route-product');
  await expect(page.locator('.conversation-source')).toHaveText('产品经理 · 群聊 / 项目协作群');
  await expect(page.getByText('产品经理的独立历史', { exact: true })).toBeVisible();
  await expect(page.getByText('开发的独立历史', { exact: true })).not.toBeVisible();
  await expect(page.locator('.session-list')).toContainText('产品会话');
  await expect(page.locator('.session-list')).not.toContainText('开发会话');
  expect(reads.some(url => url.startsWith('/api/sessions?') && url.includes('chatId=route-product'))).toBe(true);
  await page.getByRole('textbox', { name: '发送给 Codex 的消息' }).fill('整理需求');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].path).toBe('/api/chat');
  expect(writes[0].body.chatId).toBe('route-product');
});

test('an additional bot requires a matching secret when changing its app and only edits its own connection', async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await page.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_product2');
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('对应的 App Secret');
  expect(writes).toEqual([]);
  await page.locator('input[type=password]:visible').fill('fixture-replacement');
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await expect(page.locator('input[type=password]:visible')).toHaveValue('');
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接飞书', exact: true })).toBeVisible();
  expect(writes).toEqual([
    { path: '/api/bots/product/credentials', method: 'POST', body: { appId: 'cli_product2', appSecret: 'fixture-replacement' } },
    { path: '/api/bots/product/connection', method: 'POST', body: { enabled: false } },
  ]);
});

test('deletion is available on the conversation tab and cancel or escape never delete a bot', async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除机器人', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  const remove = page.getByRole('button', { name: '删除机器人', exact: true });
  const dialog = page.getByRole('alertdialog', { name: '删除「产品经理」？' });
  await remove.click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(dialog).toContainText('会话历史保留');
  await page.screenshot({ path: test.info().outputPath('delete-confirmation.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(remove).toBeFocused();
  await remove.click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(writes).toEqual([]);
  await remove.click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理产品经理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理开发', exact: true })).toBeVisible();
  expect(writes).toEqual([{ path: '/api/bots/product', method: 'DELETE', body: {} }]);
});

test('deleting the first and last bots clears the default target and shows an addable empty state', async ({ page }) => {
  const state = fixture();
  state.config.desktopNotificationTarget = { botAppId: 'cli_default', chatId: 'oc_private', actorId: 'ou_default' };
  await setup(page, state);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '删除机器人', exact: true }).click();
  let dialog = page.getByRole('alertdialog', { name: '删除「开发」？' });
  await expect(dialog).toContainText('删除后需重新设置通知接收位置');
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理开发', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '产品经理', exact: true })).toBeVisible();
  expect(state.config.desktopNotificationTarget).toBeNull();
  await page.getByRole('button', { name: '删除机器人', exact: true }).click();
  dialog = page.getByRole('alertdialog', { name: '删除「产品经理」？' });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有机器人', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有机器人', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加机器人', exact: true }).click();
  const adding = page.getByRole('dialog', { name: '添加机器人' });
  await adding.getByRole('textbox', { name: '机器人名称' }).fill('新机器人');
  await adding.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_new');
  await adding.locator('input[type=password]').fill('fixture-secret');
  await adding.getByRole('button', { name: '验证并添加' }).click();
  await expect(page.getByRole('button', { name: '管理新机器人', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有机器人', exact: true })).not.toBeVisible();
});

test('busy deletion errors remain reviewable and a subsequent retry can remove the bot', async ({ page }) => {
  const { writes } = await setup(page);
  let reject = true;
  await page.route('**/api/bots/product', async route => {
    if (route.request().method() === 'DELETE' && reject) {
      reject = false;
      await route.fulfill({ status: 409, json: { error: '这个机器人还有任务正在运行，请结束后再删除。' } });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('button', { name: '删除机器人', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '删除「产品经理」？' });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('还有任务正在运行');
  await expect(page.getByRole('button', { name: '管理产品经理', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理产品经理', exact: true })).toHaveCount(0);
  expect(writes).toEqual([{ path: '/api/bots/product', method: 'DELETE', body: {} }]);
});

test('role and model preferences save only to the selected bot', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('textbox', { name: '群聊角色说明', exact: true }).fill('负责需求分析和验收标准。');
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect.poll(() => state.bots![1].roleInstructions).toBe('负责需求分析和验收标准。');
  await page.getByRole('combobox', { name: '机器人模型' }).selectOption('test-model');
  await expect(page.getByRole('combobox', { name: '机器人思考深度' })).toHaveValue('high');
  await page.getByRole('combobox', { name: '机器人思考深度' }).selectOption('low');
  await expect.poll(() => state.bots![1].effort).toBe('low');
  expect(writes).toEqual([
    { path: '/api/bots/product', method: 'PATCH', body: { roleInstructions: '负责需求分析和验收标准。' } },
    { path: '/api/bots/product', method: 'PATCH', body: { model: 'test-model', effort: 'high' } },
    { path: '/api/bots/product', method: 'PATCH', body: { effort: 'low' } },
  ]);
  expect(state.bots![0].model).toBe('');
  expect(state.bots![0].roleInstructions).toBe('');
});

test('global connection status reflects additional bots when the default bot is stopped', async ({ page }) => {
  const state = fixture();
  state.connection = { status: 'stopped' };
  state.bots![0].connection = { status: 'stopped' };
  state.connectionSummary = { status: 'connected', connected: 1, total: 2 };
  await setup(page, state);
  await expect(page.locator('.header-status .connection-pill')).toHaveText('1/2 个机器人已连接');
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await expect(page.locator('.bot-connection-status:visible')).toHaveText('未连接');
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await expect(page.locator('.bot-connection-status:visible')).toHaveText('已连接');
});


test('group background defaults on and auto-saves separately for each bot', async ({ page }) => {
  const { state, writes } = await setup(page);
  const openRole = async () => {
    await page.getByRole('button', { name: '机器人', exact: true }).click();
  };
  await openRole();
  const toggle = page.getByRole('checkbox', { name: '补充群聊背景', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => state.bots![0].includeGroupContext).toBe(false);
  await expect(page.getByText('仅处理 @我的消息，保留历史、引用和交接。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => state.bots![1].includeGroupContext).toBe(false);
  await page.getByRole('button', { name: '管理开发', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(() => state.bots![0].includeGroupContext).toBe(true);
  await page.reload();
  await openRole();
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  expect(writes).toEqual([
    { path: '/api/bots/default', method: 'PATCH', body: { includeGroupContext: false } },
    { path: '/api/bots/product', method: 'PATCH', body: { includeGroupContext: false } },
    { path: '/api/bots/default', method: 'PATCH', body: { includeGroupContext: true } },
  ]);
});


test('failed group background auto-save retains its draft and offers a local retry', async ({ page }) => {
  const { state } = await setup(page);
  await page.route('**/api/bots/default', route => route.fulfill({ status: 503, json: { error: '测试保存失败' } }));
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: '补充群聊背景', exact: true });
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('测试保存失败');
  await expect(toggle).not.toBeChecked();
  expect(state.bots![0].includeGroupContext).toBeUndefined();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '管理开发', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('测试保存失败');
  await page.unroute('**/api/bots/default');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => state.bots![0].includeGroupContext).toBe(false);
});

test('group and private role instructions auto-save independently for each bot and private roles can be cleared', async ({ page }) => {
  const initial = fixture();
  initial.bots![0].roleInstructions = '开发群聊角色';
  initial.bots![1].roleInstructions = '产品群聊角色';
  const { state, writes } = await setup(page, initial);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  const groupRole = page.getByRole('textbox', { name: '群聊角色说明', exact: true });
  const privateRole = page.getByRole('textbox', { name: '私聊角色说明', exact: true });
  const blur = () => page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect(privateRole).toHaveValue('');
  await expect(page.locator('.bot-field[data-field="privateRoleInstructions"]:visible')).toContainText('可选；留空使用普通 Codex');
  await groupRole.fill('负责群聊中的开发');
  await blur();
  await expect.poll(() => state.bots![0].roleInstructions).toBe('负责群聊中的开发');
  await privateRole.fill('协助个人代码学习');
  await blur();
  await expect.poll(() => state.bots![0].privateRoleInstructions).toBe('协助个人代码学习');
  await expect(groupRole).toHaveValue('负责群聊中的开发');
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(groupRole).toHaveValue('产品群聊角色');
  await expect(privateRole).toHaveValue('');
  await privateRole.fill('协助个人需求整理');
  await blur();
  await expect.poll(() => state.bots![1].privateRoleInstructions).toBe('协助个人需求整理');
  await page.getByRole('button', { name: '管理开发', exact: true }).click();
  await expect(privateRole).toHaveValue('协助个人代码学习');
  await privateRole.fill('   ');
  await blur();
  await expect.poll(() => state.bots![0].privateRoleInstructions).toBe('');
  await expect(privateRole).toHaveValue('');
  await page.reload();
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await expect(groupRole).toHaveValue('负责群聊中的开发');
  await expect(privateRole).toHaveValue('');
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(privateRole).toHaveValue('协助个人需求整理');
  expect(writes).toEqual([
    { path: '/api/bots/default', method: 'PATCH', body: { roleInstructions: '负责群聊中的开发' } },
    { path: '/api/bots/default', method: 'PATCH', body: { privateRoleInstructions: '协助个人代码学习' } },
    { path: '/api/bots/product', method: 'PATCH', body: { privateRoleInstructions: '协助个人需求整理' } },
    { path: '/api/bots/default', method: 'PATCH', body: { privateRoleInstructions: '' } },
  ]);
  expect(state.bots![1].roleInstructions).toBe('产品群聊角色');
});

for (const field of ['roleInstructions', 'privateRoleInstructions'] as const) {
  test(`failed ${field} saves keep their draft through other saves and bot switches and allow blur retry`, async ({ page }) => {
    const initial = fixture();
    initial.bots![0].roleInstructions = '已保存的群聊角色';
    initial.bots![0].privateRoleInstructions = '已保存的私聊角色';
    const { state, writes } = await setup(page, initial);
    let failures = 0;
    await page.route('**/api/bots/default', async route => {
      if (field in route.request().postDataJSON()) {
        failures += 1;
        await route.fulfill({ status: 503, json: { error: '测试角色保存失败' } });
      } else await route.fallback();
    });
    await page.getByRole('button', { name: '机器人', exact: true }).click();
    const fieldLabel = field === 'roleInstructions' ? '群聊角色说明' : '私聊角色说明';
    const otherLabel = field === 'roleInstructions' ? '私聊角色说明' : '群聊角色说明';
    const otherField = field === 'roleInstructions' ? 'privateRoleInstructions' : 'roleInstructions';
    const role = page.getByRole('textbox', { name: fieldLabel, exact: true });
    const blur = () => page.getByRole('tab', { name: '对话设置', exact: true }).click();
    const draft = '  保留尚未保存的角色草稿  ';
    const saved = state.bots![0][field];
    await role.fill(draft);
    await blur();
    await expect(page.getByRole('alert')).toContainText('测试角色保存失败');
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(role).toHaveValue(draft);
    expect(state.bots![0][field]).toBe(saved);
    await page.getByRole('textbox', { name: otherLabel, exact: true }).fill('另一个范围独立保存');
    await blur();
    await expect.poll(() => state.bots![0][otherField]).toBe('另一个范围独立保存');
    await expect(role).toHaveValue(draft);
    await page.getByRole('tab', { name: /访问权限/ }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('tab', { name: '对话设置' }).click();
    await expect(role).toHaveValue(draft);
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '机器人', exact: true }).click();
    await expect(role).toHaveValue(draft);
    await expect(page.getByRole('alert')).toContainText('测试角色保存失败');
    await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
    await expect(role).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '管理开发', exact: true }).click();
    await expect(role).toHaveValue(draft);
    await page.unroute('**/api/bots/default');
    await role.focus();
    await blur();
    await expect.poll(() => state.bots![0][field]).toBe(draft.trim());
    await expect(role).toHaveValue(draft.trim());
    expect(failures).toBe(1);
    expect(writes).toEqual([
      { path: '/api/bots/default', method: 'PATCH', body: { [otherField]: '另一个范围独立保存' } },
      { path: '/api/bots/default', method: 'PATCH', body: { [field]: draft.trim() } },
    ]);
  });
}

test('bot selection remembers each tab and preserves unfinished credentials across all navigation', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await expect(page.getByRole('tab', { name: '对话设置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'App ID', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await page.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_draftonly');
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('对应的 App Secret');
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(page.getByRole('tab', { name: '对话设置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /访问权限/ }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await expect(page.getByRole('tab', { name: /访问权限/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '管理开发', exact: true }).click();
  await expect(page.getByRole('tab', { name: '连接设置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'App ID', exact: true })).toHaveValue('cli_draftonly');
  await expect(page.locator('input[type=password]:visible')).toHaveValue('');
  expect(writes).toEqual([]);
  expect(state.bots![0].appId).toBe('cli_default');
  expect(state.bots![1].appId).toBe('cli_product');
});

test('an in-flight role save does not overwrite the other bot or lose its newer draft', async ({ page }) => {
  const { state, writes } = await setup(page);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bots/default', async route => {
    entered = true;
    await gate;
    await route.fallback();
  });
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  const role = page.getByRole('textbox', { name: '私聊角色说明', exact: true });
  await role.fill('开发的独立私聊角色');
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await expect(role).toHaveValue('');
  await role.fill('产品的新草稿');
  release();
  await expect.poll(() => state.bots![0].privateRoleInstructions).toBe('开发的独立私聊角色');
  await expect(role).toHaveValue('产品的新草稿');
  expect(state.bots![1].privateRoleInstructions).toBeUndefined();
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect.poll(() => state.bots![1].privateRoleInstructions).toBe('产品的新草稿');
  await page.getByRole('button', { name: '管理开发', exact: true }).click();
  await expect(role).toHaveValue('开发的独立私聊角色');
  expect(writes).toEqual([
    { path: '/api/bots/default', method: 'PATCH', body: { privateRoleInstructions: '开发的独立私聊角色' } },
    { path: '/api/bots/product', method: 'PATCH', body: { privateRoleInstructions: '产品的新草稿' } },
  ]);
});

test('setup links route to bot connections', async ({ page }) => {
  await setup(page, fixture(), '/?setup=feishu');
  await expect(page.getByRole('button', { name: '机器人', exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole('tab', { name: '连接设置', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('pending first use routes to the requesting bot access', async ({ page }) => {
  const firstUse = fixture();
  firstUse.conversations = [];
  await setup(page, firstUse);
  await expect(page.getByRole('button', { name: '机器人', exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole('tab', { name: /访问权限/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '管理产品经理', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '允许访问', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许群聊', exact: true })).toBeVisible();
});

test('role save failures offer a local retry without a global error or unrelated writes', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.route('**/api/bots/product', route => route.fulfill({ status: 503, json: { error: '角色暂未保存' } }));
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  const role = page.getByRole('textbox', { name: '群聊角色说明', exact: true });
  await role.fill('产品群聊角色草稿');
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  const field = page.locator('.bot-field[data-field="roleInstructions"]:visible');
  await expect(field.getByRole('alert')).toContainText('角色暂未保存');
  await expect(field.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(role).toHaveValue('产品群聊角色草稿');
  await page.unroute('**/api/bots/product');
  await field.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => state.bots![1].roleInstructions).toBe('产品群聊角色草稿');
  await expect(field.getByRole('alert')).toHaveCount(0);
  expect(writes).toEqual([{ path: '/api/bots/product', method: 'PATCH', body: { roleInstructions: '产品群聊角色草稿' } }]);
  expect(state.bots![0].roleInstructions).toBe('');
});

test('cancelling edited credentials does not save the pair on blur', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await page.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_cancelled');
  await page.locator('input[type=password]:visible').fill('never-save-this-secret');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改凭据', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  expect(state.bots![1].appId).toBe('cli_product');
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'App ID', exact: true })).toHaveValue('cli_product');
  await expect(page.locator('input[type=password]:visible')).toHaveValue('');
});

test('a late save response preserves a newer edit to the same role field', async ({ page }) => {
  const { state, writes } = await setup(page);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bots/default', async route => {
    entered = true;
    await gate;
    await route.fallback();
  });
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  const role = page.getByRole('textbox', { name: '群聊角色说明', exact: true });
  await role.fill('第一版群聊角色');
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await role.fill('正在编辑的第二版群聊角色');
  release();
  await expect.poll(() => state.bots![0].roleInstructions).toBe('第一版群聊角色');
  await expect(role).toHaveValue('正在编辑的第二版群聊角色');
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect.poll(() => state.bots![0].roleInstructions).toBe('正在编辑的第二版群聊角色');
  expect(writes).toEqual([
    { path: '/api/bots/default', method: 'PATCH', body: { roleInstructions: '第一版群聊角色' } },
    { path: '/api/bots/default', method: 'PATCH', body: { roleInstructions: '正在编辑的第二版群聊角色' } },
  ]);
});

test('changing effort during model save queues the later choice without another bot changing', async ({ page }) => {
  const { state, writes } = await setup(page);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bots/product', async route => {
    if ('model' in route.request().postDataJSON()) { entered = true; await gate; }
    await route.fallback();
  });
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('combobox', { name: '机器人模型', exact: true }).selectOption('test-model');
  await expect.poll(() => entered).toBe(true);
  const effort = page.getByRole('combobox', { name: '机器人思考深度', exact: true });
  await expect(effort).toHaveValue('high');
  await effort.selectOption('low');
  await expect(effort).toHaveValue('low');
  release();
  await expect.poll(() => state.bots![1].effort).toBe('low');
  await expect(effort).toHaveValue('low');
  expect(writes).toEqual([
    { path: '/api/bots/product', method: 'PATCH', body: { model: 'test-model', effort: 'high' } },
    { path: '/api/bots/product', method: 'PATCH', body: { effort: 'low' } },
  ]);
  expect(state.bots![0].model).toBe('');
  expect(state.bots![0].effort).toBe('');
});

test('explicit verification reconnects saved credentials while untouched blur stays quiet', async ({ page }) => {
  const initial = fixture();
  initial.bots![1].enabled = false;
  initial.bots![1].connection = { status: 'stopped' };
  const { state, writes } = await setup(page, initial);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await expect(page.locator('.bot-connection-status:visible')).toHaveText('未连接');
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await page.getByRole('textbox', { name: 'App ID', exact: true }).focus();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改凭据', exact: true })).toBeVisible();
  await expect(page.locator('.bot-connection-status:visible')).toHaveText('已连接');
  expect(writes).toEqual([{ path: '/api/bots/product/credentials', method: 'POST', body: { appId: 'cli_product' } }]);
  expect(state.bots![1].enabled).toBe(true);
  expect(state.bots![0].appId).toBe('cli_default');
});
test('adding a Hermes bot sends the selected AI and shows Hermes conversation controls', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '添加机器人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加机器人' });
  const selector = dialog.getByRole('combobox', { name: '处理对话的 AI' });
  await expect(selector).toHaveValue('codex');
  await selector.selectOption('hermes');
  await expect(dialog).toContainText('请先打开本机 Hermes');
  await dialog.getByRole('textbox', { name: '机器人名称' }).fill('Hermes 产品');
  await dialog.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_hermes');
  await dialog.locator('input[type=password]').fill('fixture-secret');
  expect(writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('add-hermes.png') });
  await dialog.getByRole('button', { name: '验证并添加', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理Hermes 产品', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '处理对话的 AI' })).toHaveValue('hermes');
  await expect(page.getByRole('combobox', { name: '机器人模型' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '群聊角色说明' })).toBeVisible();
  await expect(page.getByRole('region', { name: '默认通知机器人' })).toHaveCount(0);
  expect(writes).toEqual([{ path: '/api/bots', method: 'POST', body: { name: 'Hermes 产品', engine: 'hermes', appId: 'cli_hermes', appSecret: 'fixture-secret' } }]);
  expect(state.bots!.find(bot => bot.id === 'default')!.engine).toBeUndefined();
});

test('switching AI is explicit, cancel restores focus, and switching both ways keeps other bots unchanged', async ({ page }) => {
  const state = fixture();
  state.config.desktopNotificationTarget = { botAppId: 'cli_product', chatId: 'oc_product', actorId: 'ou_product' };
  const { writes } = await setup(page, state);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  const selector = page.getByRole('combobox', { name: '处理对话的 AI' });
  await selector.selectOption('hermes');
  let dialog = page.getByRole('alertdialog', { name: '切换到 Hermes？' });
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(dialog).toContainText('私聊和群聊将从新的 Hermes 会话开始');
  await expect(dialog).toContainText('需重新选择 Codex 桌面通知');
  await expect(page.getByRole('textbox', { name: '群聊角色说明' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(selector).toBeFocused();
  await expect(selector).toHaveValue('codex');
  expect(writes).toEqual([]);
  await selector.selectOption('hermes');
  await dialog.getByRole('button', { name: '确认切换', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(selector).toHaveValue('hermes');
  await expect(page.getByRole('combobox', { name: '机器人模型' })).toHaveCount(0);
  expect(state.config.desktopNotificationTarget).toBeNull();
  expect(state.conversations.find(item => item.botId === 'product')!.threadId).toBeUndefined();
  expect(state.conversations.find(item => item.botId === 'default')!.threadId).toBe('thread-development');
  await page.screenshot({ path: test.info().outputPath('hermes-settings.png') });
  await selector.selectOption('codex');
  dialog = page.getByRole('alertdialog', { name: '切换到 Codex？' });
  await dialog.getByRole('button', { name: '确认切换', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(selector).toHaveValue('codex');
  await expect(page.getByRole('combobox', { name: '机器人模型' })).toBeVisible();
  expect(writes).toEqual([
    { path: '/api/bots/product', method: 'PATCH', body: { engine: 'hermes' } },
    { path: '/api/bots/product', method: 'PATCH', body: { engine: 'codex' } },
  ]);
});

test('unavailable Hermes leaves the old selection and binding and allows retry after startup', async ({ page }) => {
  const { state } = await setup(page);
  let unavailable = true;
  await page.route('**/api/bots/product', async route => {
    if (route.request().method() === 'PATCH' && unavailable) {
      unavailable = false;
      await route.fulfill({ status: 503, json: { error: 'Hermes 尚未启动，请先打开 Hermes。' } });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '管理产品经理', exact: true }).click();
  const selector = page.getByRole('combobox', { name: '处理对话的 AI' });
  await selector.selectOption('hermes');
  const dialog = page.getByRole('alertdialog', { name: '切换到 Hermes？' });
  await dialog.getByRole('button', { name: '确认切换', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Hermes 尚未启动');
  await expect(selector).toHaveValue('codex');
  expect(state.conversations.find(item => item.botId === 'product')!.threadId).toBe('thread-product');
  await dialog.getByRole('button', { name: '确认切换', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(selector).toHaveValue('hermes');
});

test('a rejected Hermes creation keeps its credentials and selected AI for retry', async ({ page }) => {
  const { state, writes } = await setup(page);
  let unavailable = true;
  await page.route('**/api/bots', async route => {
    if (route.request().method() === 'POST' && unavailable) {
      unavailable = false;
      await route.fulfill({ status: 503, json: { error: '请先打开本机 Hermes，再重试。' } });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '添加机器人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加机器人' });
  await dialog.getByRole('combobox', { name: '处理对话的 AI' }).selectOption('hermes');
  await dialog.getByRole('textbox', { name: '机器人名称' }).fill('Hermes 测试');
  await dialog.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_hermes');
  await dialog.locator('input[type=password]').fill('fixture-secret');
  await dialog.getByRole('button', { name: '验证并添加', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('打开本机 Hermes');
  await expect(dialog.getByRole('combobox', { name: '处理对话的 AI' })).toHaveValue('hermes');
  await expect(dialog.locator('input[type=password]')).toHaveValue('fixture-secret');
  expect(state.bots!.length).toBe(2);
  await dialog.getByRole('button', { name: '验证并添加', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes.length).toBe(1);
  expect(state.bots!.at(-1)!.engine).toBe('hermes');
});
