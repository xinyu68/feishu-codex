import { expect, test, type Page } from '@playwright/test';
import type { AppState, BotProfile } from '../../ui/src/types';

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

async function setup(page: Page, state = fixture()) {
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
      const bot: BotProfile = { id: 'tester', name: String(input.name), appId: String(input.appId), hasSecret: true, enabled: true, allowedActors: [], allowedGroups: [], roleInstructions: String(input.roleInstructions || ''), model: '', effort: '', connection: { status: 'connected' } };
      state.bots!.push(bot); body = { bot };
    }
    if (url.pathname.startsWith('/api/bots/')) {
      const [, , , id, operation] = url.pathname.split('/');
      const bot = state.bots!.find(item => item.id === id)!;
      if (operation === 'credentials') { bot.appId = String(input.appId); bot.hasSecret = true; }
      if (operation === 'connection') { bot.enabled = Boolean(input.enabled); bot.connection.status = bot.enabled ? 'connected' : 'stopped'; }
      if (method === 'PATCH') Object.assign(bot, input);
      if (method === 'DELETE') state.bots = state.bots!.filter(item => item.id !== id);
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
  await page.goto('/');
  return { state, writes, reads };
}

test('adding a role bot only submits after explicit confirmation and switches to its own settings', async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '添加机器人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加机器人' });
  await dialog.getByRole('textbox', { name: '机器人名称' }).fill('测试');
  await dialog.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_tester');
  await dialog.locator('input[type=password]').fill('fixture-secret');
  await dialog.getByRole('textbox', { name: /角色说明/ }).fill('负责检查需求和验收，不自动修改代码。');
  await dialog.getByRole('heading', { name: '添加机器人' }).click();
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: '验证并添加' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('combobox', { name: '管理机器人' })).toHaveValue('tester');
  await expect(page.getByRole('textbox', { name: 'App ID', exact: true })).toHaveValue('cli_tester');
  await expect(page.locator('input[type=password]')).toHaveValue('');
  expect(writes).toEqual([{ path: '/api/bots', method: 'POST', body: { name: '测试', appId: 'cli_tester', appSecret: 'fixture-secret', roleInstructions: '负责检查需求和验收，不自动修改代码。' } }]);
});

test('group and actor authorization are separate and scoped to the selected bot', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: /账号与群聊/ }).click();
  await expect(page.getByText('ou_product_pending', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '允许群聊', exact: true })).not.toBeVisible();
  await page.getByRole('combobox', { name: '管理机器人' }).selectOption('product');
  await expect(page.getByText('ou_product_pending', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '管理机器人' }).selectOption('product');
  await page.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_product2');
  await page.getByRole('heading', { name: '飞书连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('对应的 App Secret');
  expect(writes).toEqual([]);
  await page.locator('input[type=password]').fill('fixture-replacement');
  await page.getByRole('heading', { name: '飞书连接', exact: true }).click();
  await expect(page.locator('input[type=password]')).toHaveValue('');
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接飞书', exact: true })).toBeVisible();
  expect(writes).toEqual([
    { path: '/api/bots/product/credentials', method: 'POST', body: { appId: 'cli_product2', appSecret: 'fixture-replacement' } },
    { path: '/api/bots/product/connection', method: 'POST', body: { enabled: false } },
  ]);
});

test('removing an extra bot requires confirmation and the default bot has no remove action', async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除这个机器人' })).not.toBeVisible();
  await page.getByRole('combobox', { name: '管理机器人' }).selectOption('product');
  await page.getByRole('button', { name: '移除这个机器人' }).click();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '管理机器人' })).toHaveValue('default');
  expect(writes).toEqual([{ path: '/api/bots/product', method: 'DELETE', body: {} }]);
});

test('role and model preferences save only to the selected bot', async ({ page }) => {
  const { state, writes } = await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '管理机器人' }).selectOption('product');
  await page.locator('.bot-role-settings summary').click();
  await page.getByRole('textbox', { name: '角色说明', exact: true }).fill('负责需求分析和验收标准。');
  await page.getByRole('heading', { name: '飞书连接', exact: true }).click();
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
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.settings-content .inline-status')).toHaveText('飞书未连接');
  await page.getByRole('combobox', { name: '管理机器人' }).selectOption('product');
  await expect(page.locator('.settings-content .inline-status')).toHaveText('飞书已连接');
});
