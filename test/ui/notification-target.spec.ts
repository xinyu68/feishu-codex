import { test, expect, type Page } from '@playwright/test';
import type { AppState, DesktopNotificationTarget, NotificationTarget } from '../../ui/src/types';

const targets: NotificationTarget[] = [
  { chatId: 'oc_writer', actorId: 'ou_writer', botAppId: 'cli_1234567890abcdef', botId: 'default', botName: '写作助手' },
  { chatId: 'bot:reviewer:oc_reviewer', actorId: 'ou_reviewer', botAppId: 'cli_abcdef0123456789', botId: 'reviewer', botName: '代码审查' },
];
const key = (target: DesktopNotificationTarget) => JSON.stringify([target.botAppId, target.chatId, target.actorId]);
const selection = (target: DesktopNotificationTarget) => ({ chatId: target.chatId, actorId: target.actorId, botAppId: target.botAppId });

async function fixture(page: Page) {
  const state: AppState = {
    csrfToken: 'fixture-token', service: { name: 'Feishu Codex', version: 'fixture', uptimeSeconds: 1, startedAt: new Date().toISOString() },
    config: { appId: targets[0]!.botAppId, hasSecret: true, enabled: false, allowedActors: [targets[0]!.actorId],
      defaultWorkspace: 'D:\\fixture', model: '', effort: '', progress: true, autoNotifyDesktop: false,
      desktopNotificationMode: 'long', desktopNotificationMinMinutes: 1, desktopNotificationTarget: null },
    connection: { status: 'stopped' }, codex: { available: true, authenticated: true, mode: 'shared' },
    runtime: { state: 'ready', canWrite: true, desktop: { mode: 'none' } },
    bots: targets.map(target => ({ id: target.botId, name: target.botName, appId: target.botAppId, hasSecret: true,
      enabled: false, allowedActors: [target.actorId], allowedGroups: [], roleInstructions: '', model: '', effort: '',
      connection: { status: 'stopped' } })),
    conversations: targets.map(target => ({ chatId: target.chatId, actorId: target.actorId, botId: target.botId, botName: target.botName,
      chatType: 'p2p', title: `${target.botName}的原会话`, cwd: 'D:\\fixture', threadId: `thread-${target.botId}`, revision: 1,
      updatedAt: new Date().toISOString(), preview: '', busy: false })),
    notificationTargets: [...targets], pendingActors: [], pendingRequests: [], logs: [],
  };
  const writes: object[] = [];
  const operations: string[] = [];
  const faults = { reject: false };
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: (() => void) | null = null;
      listener = () => this.dispatchEvent(new MessageEvent('state', { data: '{}' }));
      constructor() { super(); window.addEventListener('fixture-state', this.listener); }
      close() { window.removeEventListener('fixture-state', this.listener); }
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEventSource });
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') operations.push(pathname);
    let body: unknown = {};
    if (pathname === '/api/state') body = state;
    if (pathname === '/api/runtime-status') body = state.runtime;
    if (pathname === '/api/projects') body = { projects: [] };
    if (pathname === '/api/models') body = { models: [] };
    if (pathname === '/api/sessions') body = { sessions: [] };
    if (pathname === '/api/history') body = { messages: [] };
    if (pathname === '/api/config') {
      const patch = route.request().postDataJSON(); writes.push(patch);
      if (faults.reject) { await route.fulfill({ status: 503, json: { error: '模拟保存失败' } }); return; }
      Object.assign(state.config, patch); body = { config: state.config };
    }
    await route.fulfill({ json: body });
  });
  return { state, writes, operations, faults, refresh: () => page.evaluate(() => window.dispatchEvent(new Event('fixture-state'))) };
}

async function settings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '对话与通知', exact: true }).click();
}

async function bot(page: Page, name: string) {
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: `管理${name}`, exact: true }).click();
}
const detail = (page: Page) => page.locator('.bot-detail:visible');
const badges = (page: Page) => page.getByRole('complementary', { name: '机器人列表' }).getByText('默认通知', { exact: true });

test('one-click default notification bot saves with automatic notifications off, stays unique and preserves the active conversation', async ({ page }) => {
  const fx = await fixture(page); await page.goto('/');
  await settings(page);
  await expect(page.getByRole('checkbox', { name: '桌面任务完成后通知飞书' })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: '默认通知接收位置', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '管理 Codex 默认机器人', exact: true }).click();
  await expect(page.getByRole('button', { name: '机器人', exact: true })).toHaveClass(/selected/);
  await page.getByRole('button', { name: '管理代码审查', exact: true }).click();
  await detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[1]!));
  await expect(badges(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '管理代码审查', exact: true })).toContainText('默认通知');
  await expect(detail(page).getByText('已设为默认', { exact: true })).toBeVisible();
  expect(fx.writes).toEqual([{ desktopNotificationTarget: selection(targets[1]!) }]);
  expect(fx.state.config.autoNotifyDesktop).toBe(false);

  await page.reload(); await settings(page);
  await page.getByRole('button', { name: '管理 Codex 默认机器人', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理代码审查', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(badges(page)).toHaveCount(1);
  await page.getByRole('button', { name: '管理写作助手', exact: true }).click();
  await detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  await expect(badges(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '管理代码审查', exact: true })).not.toContainText('默认通知');
  await expect(page.getByRole('button', { name: '管理写作助手', exact: true })).toContainText('默认通知');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '写作助手的原会话', exact: true })).toBeVisible();
  expect(fx.operations).toEqual(['/api/config', '/api/config']);
});

test('failed default-bot change preserves its draft across navigation and refresh without claiming it was saved', async ({ page }) => {
  const fx = await fixture(page); fx.state.config.desktopNotificationTarget = selection(targets[0]!); fx.faults.reject = true;
  await page.goto('/'); await bot(page, '代码审查');
  await detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('自动保存失败');
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  await expect(detail(page).getByText('已设为默认', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理代码审查', exact: true })).toContainText('尚未保存');
  await expect(page.getByRole('button', { name: '管理写作助手', exact: true })).toContainText('默认通知');
  await fx.refresh(); await settings(page); await bot(page, '代码审查');
  await expect(detail(page)).toContainText('尚未保存');
  fx.faults.reject = false;
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[1]!));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(detail(page).getByText('已设为默认', { exact: true })).toBeVisible();
  await expect(badges(page)).toHaveCount(1);
});

test('failed clearing keeps a null draft through navigation and can be retried', async ({ page }) => {
  const fx = await fixture(page); fx.state.config.desktopNotificationTarget = selection(targets[1]!); fx.faults.reject = true;
  await page.goto('/'); await bot(page, '代码审查');
  await detail(page).getByRole('button', { name: '取消默认', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('自动保存失败');
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[1]!));
  await fx.refresh(); await settings(page); await bot(page, '代码审查');
  await expect(detail(page).getByText('已设为默认', { exact: true })).toHaveCount(0);
  await expect(detail(page)).toContainText('尚未保存');
  fx.faults.reject = false;
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toBeNull();
  await expect(badges(page)).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true })).toBeEnabled();
  expect(fx.writes).toEqual([{ desktopNotificationTarget: null }, { desktopNotificationTarget: null }]);
});

test('revoked default remains visibly invalid without switching to another eligible bot', async ({ page }) => {
  const fx = await fixture(page); fx.state.config.desktopNotificationTarget = selection(targets[1]!);
  await page.goto('/'); await bot(page, '代码审查');
  await expect(badges(page)).toHaveCount(1);
  fx.state.notificationTargets = [targets[0]!]; await fx.refresh();
  await expect(page.getByText('Codex 默认通知已失效，请重新设置。', { exact: true }).first()).toBeVisible();
  await expect(badges(page)).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true })).toBeDisabled();
  expect(fx.writes).toEqual([]);
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[1]!));
  await page.getByRole('button', { name: '管理写作助手', exact: true }).click();
  await detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  await expect(badges(page)).toHaveCount(1);
  await expect(page.getByText('Codex 默认通知已失效，请重新设置。', { exact: true })).toHaveCount(0);
  expect(fx.state.config.autoNotifyDesktop).toBe(false);
});

test('no private recipient guides authorization and still allows clearing an invalid default', async ({ page }) => {
  const fx = await fixture(page); fx.state.config.desktopNotificationTarget = selection(targets[1]!); fx.state.notificationTargets = [];
  fx.state.bots![1]!.allowedActors = [];
  await page.goto('/'); await bot(page, '代码审查');
  await expect(detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true })).toBeDisabled();
  await expect(detail(page)).toContainText('请在访问权限中允许接收通知的私聊账号');
  await detail(page).getByRole('button', { name: '去授权', exact: true }).click();
  await expect(detail(page).getByRole('tab', { name: /访问权限/ })).toHaveAttribute('aria-selected', 'true');
  expect(fx.writes).toEqual([]);
  await detail(page).getByRole('button', { name: '取消默认', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toBeNull();
  await expect(page.getByText('Codex 默认通知已失效，请重新设置。', { exact: true })).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true })).toBeDisabled();
  expect(fx.writes).toEqual([{ desktopNotificationTarget: null }]);
});

test('authorized Codex with only group history explains the missing DM and becomes selectable when it arrives', async ({ page }) => {
  const fx = await fixture(page);
  fx.state.bots![1]!.engine = 'hermes';
  fx.state.notificationTargets = [];
  fx.state.conversations.forEach(item => { item.chatType = 'group'; });
  await page.goto('/'); await settings(page);
  await expect(page.getByText('待建立通知私聊', { exact: true }).first()).toBeVisible();
  await bot(page, '写作助手');
  await expect(detail(page)).toContainText('账号已授权。请在飞书私聊「写作助手」发一条消息');
  await expect(detail(page).getByRole('button', { name: '去授权', exact: true })).toHaveCount(0);
  const setDefault = detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true });
  await expect(setDefault).toBeDisabled();
  fx.state.conversations[0]!.chatType = 'p2p';
  fx.state.notificationTargets = [targets[0]!];
  await fx.refresh();
  await expect(setDefault).toBeEnabled();
  await setDefault.click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  expect(fx.writes).toEqual([{ desktopNotificationTarget: selection(targets[0]!) }]);
});

test('a bot with several eligible private recipients requires an explicit recipient before setting or updating its default', async ({ page }) => {
  const fx = await fixture(page);
  const extra: NotificationTarget = { ...targets[1]!, actorId: 'ou_second_account', chatId: 'bot:reviewer:oc_second' };
  fx.state.notificationTargets!.push(extra); fx.state.bots![1]!.allowedActors.push(extra.actorId);
  await page.goto('/'); await bot(page, '代码审查');
  const recipient = detail(page).getByRole('combobox', { name: '通知接收人', exact: true });
  const setDefault = detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true });
  await expect(recipient).toHaveValue('');
  await expect(setDefault).toBeDisabled();
  expect(fx.writes).toEqual([]);
  await recipient.selectOption(key(extra));
  await expect(setDefault).toBeEnabled();
  expect(fx.writes).toEqual([]);
  await setDefault.click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(extra));
  await expect(badges(page)).toHaveCount(1);
  await recipient.selectOption(key(targets[1]!));
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(extra));
  await detail(page).getByRole('button', { name: '更新接收人', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[1]!));
  expect(fx.writes).toEqual([{ desktopNotificationTarget: selection(extra) }, { desktopNotificationTarget: selection(targets[1]!) }]);
});

test('an external default change refreshes the badge and management destination without writing preferences', async ({ page }) => {
  const fx = await fixture(page); fx.state.config.desktopNotificationTarget = selection(targets[0]!);
  await page.goto('/'); await bot(page, '写作助手');
  await expect(page.getByRole('button', { name: '管理写作助手', exact: true })).toContainText('默认通知');
  fx.state.config.desktopNotificationTarget = selection(targets[1]!); await fx.refresh();
  await expect(page.getByRole('button', { name: '管理代码审查', exact: true })).toContainText('默认通知');
  await expect(page.getByRole('button', { name: '管理写作助手', exact: true })).not.toContainText('默认通知');
  await settings(page); await page.getByRole('button', { name: '管理 Codex 默认机器人', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理代码审查', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(fx.writes).toEqual([]);
});

for (const change of ['removed bot', 'replaced app'] as const) {
  test(`an orphaned default after ${change} can be cleared without assigning its recipient to another bot`, async ({ page }) => {
    const fx = await fixture(page);
    fx.state.config.desktopNotificationTarget = selection(targets[1]!);
    if (change === 'removed bot') {
      fx.state.bots = [fx.state.bots![0]!];
      fx.state.notificationTargets = [targets[0]!];
      fx.state.conversations = [fx.state.conversations[0]!];
    } else {
      fx.state.bots![1]!.appId = 'cli_replaced';
      fx.state.notificationTargets![1] = { ...targets[1]!, botAppId: 'cli_replaced' };
    }
    await page.goto('/'); await settings(page);
    await page.getByRole('button', { name: '管理 Codex 默认机器人', exact: true }).click();
    await expect(page.getByText('Codex 默认通知已失效，请重新设置。', { exact: true })).toBeVisible();
    await expect(badges(page)).toHaveCount(0);
    expect(fx.writes).toEqual([]);
    await page.getByRole('button', { name: '清除失效默认', exact: true }).click();
    await expect.poll(() => fx.state.config.desktopNotificationTarget).toBeNull();
    await expect(page.getByRole('button', { name: '清除失效默认', exact: true })).toHaveCount(0);
    await expect(badges(page)).toHaveCount(0);
    expect(fx.writes).toEqual([{ desktopNotificationTarget: null }]);
  });
}

function addHermes(fx: Awaited<ReturnType<typeof fixture>>, id: string) {
  const target: NotificationTarget = { botId: id, botName: 'Hermes ' + id, botAppId: 'cli_' + id,
    chatId: 'bot:' + id + ':oc_' + id, actorId: 'ou_' + id, engine: 'hermes' };
  fx.state.bots!.push({ id, name: target.botName, engine: 'hermes', appId: target.botAppId, hasSecret: true,
    enabled: true, allowedActors: [target.actorId], allowedGroups: [], roleInstructions: '', model: '', effort: '',
    connection: { status: 'connected' }, engineStatus: { available: true } });
  fx.state.notificationTargets!.push(target);
  return target;
}

test('Codex and Hermes defaults stay independent across changes, clearing and settings navigation', async ({ page }) => {
  const fx = await fixture(page);
  const h1 = addHermes(fx, 'h1'); const h2 = addHermes(fx, 'h2');
  fx.state.config.desktopNotificationTarget = selection(targets[0]!);
  fx.state.config.hermesNotificationTarget = selection(h1);
  const before = structuredClone(fx.state.conversations);
  await page.goto('/'); await bot(page, h2.botName);
  const sidebar = page.getByRole('complementary', { name: '机器人列表' });
  await expect(sidebar.getByRole('region', { name: 'Codex 机器人', exact: true })).toContainText('写作助手');
  await expect(sidebar.getByRole('region', { name: 'Hermes 机器人', exact: true })).toContainText(h2.botName);
  await expect(badges(page)).toHaveCount(2);
  await detail(page).getByRole('button', { name: '设为 Hermes 默认通知', exact: true }).click();
  await expect.poll(() => fx.state.config.hermesNotificationTarget).toEqual(selection(h2));
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  await settings(page);
  await expect(page.getByRole('button', { name: '管理 Codex 默认机器人', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理 Hermes 默认机器人', exact: true }).click();
  await expect(detail(page)).toHaveAttribute('aria-label', h2.botName + '设置');
  await detail(page).getByRole('tab', { name: '连接设置', exact: true }).click();
  await expect(detail(page).getByRole('region', { name: 'Hermes 默认通知机器人', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/split-defaults-bots.png' });
  await detail(page).getByRole('button', { name: '取消默认', exact: true }).click();
  await expect.poll(() => fx.state.config.hermesNotificationTarget).toBeNull();
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  await bot(page, '代码审查');
  await detail(page).getByRole('button', { name: '设为 Codex 默认通知', exact: true }).click();
  await expect.poll(() => fx.state.config.desktopNotificationTarget).toEqual(selection(targets[1]!));
  expect(fx.state.config.hermesNotificationTarget).toBeNull();
  expect(fx.state.conversations).toEqual(before);
  expect(fx.operations.every(route => route === '/api/config')).toBe(true);
});

test('each empty engine group can add a bot with that type already selected', async ({ page }) => {
  await fixture(page); await page.goto('/'); await bot(page, '写作助手');
  await page.getByRole('button', { name: '添加 Hermes 机器人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加机器人' });
  await expect(dialog.getByRole('combobox', { name: '处理对话的 AI' })).toHaveValue('hermes');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await settings(page);
  await expect(page.locator('.notification-destinations')).toContainText('未添加机器人');
});

test('failed Hermes default saving retains its draft without corrupting the saved Codex choice', async ({ page }) => {
  const fx = await fixture(page); const h1 = addHermes(fx, 'h1'); const h2 = addHermes(fx, 'h2');
  fx.state.config.desktopNotificationTarget = selection(targets[0]!);
  fx.state.config.hermesNotificationTarget = selection(h1);
  fx.faults.reject = true;
  await page.goto('/'); await bot(page, h2.botName);
  await detail(page).getByRole('button', { name: '设为 Hermes 默认通知', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('自动保存失败');
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
  expect(fx.state.config.hermesNotificationTarget).toEqual(selection(h1));
  await settings(page); await page.getByRole('button', { name: '管理 Hermes 默认机器人', exact: true }).click();
  await expect(detail(page)).toHaveAttribute('aria-label', h2.botName + '设置');
  fx.faults.reject = false;
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect.poll(() => fx.state.config.hermesNotificationTarget).toEqual(selection(h2));
  expect(fx.state.config.desktopNotificationTarget).toEqual(selection(targets[0]!));
});
