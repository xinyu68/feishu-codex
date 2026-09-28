import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { DesktopPreferences, DesktopStatus } from '../../ui/src/types';

const ready: DesktopStatus = { state: 'ready', canWrite: true, runtime: { state: 'ready' }, bridge: { state: 'ready' }, desktop: { mode: 'closed' }, launch: { state: 'idle' } };
test.beforeEach(({ page }) => { page.on('pageerror', error => { throw error; }); });
async function fixture(page: Page, status: DesktopStatus = ready, native = true, connection = 'connected') {
  await page.addInitScript(({ initial, native }) => {
    class QuietEventSource extends EventTarget { onmessage = null; onopen = null; close() {} }
    Object.defineProperty(window, 'EventSource', { value: QuietEventSource });
    if (!native) return;
    let status = initial;
    let preferences: DesktopPreferences = { openCodexOnLaunch: true, openAtLogin: false, closeWindowAction: 'tray' };
    let cancelNextSwitch = false;
    let selectedWorkspace: string | null = 'D:\\fixture\\selected';
    const calls: string[] = [];
    const listeners = new Set<(value: typeof status) => void>();
    const update = (value: typeof status) => { status = value; listeners.forEach(callback => callback(status)); };
    Object.assign(window, { nativeCalls: calls, updateNative: update, cancelNativeSwitch: () => { cancelNextSwitch = true; }, setSelectedWorkspace: (value: string | null) => { selectedWorkspace = value; } });
    window.feishuCodex = {
      getStatus: async () => status,
      onStatus: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
      getPreferences: async () => preferences,
      setPreferences: async value => { calls.push(`preferences:${value.openCodexOnLaunch}:${value.openAtLogin}:${value.closeWindowAction}`); preferences = value; return value; },
      chooseWorkspace: async () => { calls.push('chooseWorkspace'); return selectedWorkspace; },
      switchToShared: async () => { calls.push('switch'); if (cancelNextSwitch) { cancelNextSwitch = false; return { ok: false, cancelled: true }; } update({ ...status, launch: { state: 'switching', message: '正在重启 Codex 并连接飞书…' } }); return { ok: true }; },
      openCodex: async () => { calls.push('open'); return { ok: true }; },
      retry: async () => { calls.push('retry'); return { ok: true }; },
      quit: async () => { calls.push('quit'); return { ok: true }; },
      openLogs: async () => ({ ok: true }),
      restoreExisting: async () => { calls.push('restore'); update({ state: 'starting', canWrite: false, reason: '正在连接本机服务…' }); return { ok: true }; },
    };
  }, { initial: status, native });
  const state = {
    csrfToken: 'fixture-token', service: { name: 'Feishu Codex', version: 'fixture', uptimeSeconds: 1, startedAt: new Date().toISOString() },
    config: { appId: 'cli_fixture', hasSecret: true, enabled: true, allowedActors: ['ou_fixture'], defaultWorkspace: 'D:\\fixture', model: '', effort: '', progress: true },
    connection: { status: connection }, codex: { available: true, authenticated: true, mode: 'shared' }, runtime: status,
    conversations: [{ chatId: 'oc_fixture', actorId: 'ou_fixture', title: '启动体验测试', cwd: 'D:\\fixture', revision: 1, updatedAt: new Date().toISOString(), preview: '', busy: false }], pendingActors: [], pendingRequests: [], logs: [],
  };
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/config' && route.request().method() === 'PUT') {
      Object.assign(state.config, route.request().postDataJSON());
      await route.fulfill({ json: { config: state.config } });
      return;
    }
    const body = pathname === '/api/state' ? state : pathname === '/api/runtime-status' ? status : pathname === '/api/projects' ? { projects: [] } : pathname === '/api/sessions' ? { sessions: [] } : pathname === '/api/history' ? { messages: [] } : pathname === '/api/models' ? { models: [] } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '启动体验测试' })).toBeVisible();
}

test('native startup preference defaults on, persists on change, and fits the settings view', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await fixture(page);
  await expect(page.locator('.capability-status')).toHaveText('飞书可用，Codex 桌面未打开');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '应用与运行', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: '启动应用时同时打开 Codex' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('.toast')).toContainText('下次启动或重新双击应用图标时生效');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '应用与运行', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['preferences:false:false:tray']);
  expect(await page.evaluate(() => ({ outer: document.documentElement.scrollHeight > innerHeight, settings: document.querySelector('.application-settings')!.scrollHeight > document.querySelector('.application-settings')!.clientHeight }))).toEqual({ outer: false, settings: false });
  await page.screenshot({ path: 'artifacts/launch-preference-1024.png' });
});

test('retained data offers recovery and never hides all actions behind an old migration result', async ({ page }) => {
  await fixture(page, { state: 'setup', setupMode: 'restore', canWrite: false,
    reason: '原有飞书配置和偏好已保留，恢复连接后即可继续使用。', migration: { status: 'succeeded', message: '接管完成' } });
  for (const [name, contentType] of [['html', 'text/html'], ['js', 'text/javascript'], ['css', 'text/css']]) {
    const body = await readFile(new URL(`../../desktop/bootstrap.${name}`, import.meta.url));
    await page.route(`**/bootstrap.${name}`, route => route.fulfill({ body, contentType }));
  }
  await page.goto('/bootstrap.html');
  await expect(page.getByRole('button', { name: '恢复连接', exact: true })).toBeEnabled();
  await expect(page.locator('#description')).not.toContainText('接管完成');
  await page.getByRole('button', { name: '恢复连接', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['restore']);
  await expect(page.locator('#description')).toHaveText('正在连接本机服务…');
});

test('login startup and close behavior are editable; old Codex icon row is removed', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await fixture(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '应用与运行', exact: true }).click();
  const startup = page.getByRole('checkbox', { name: '开机自动启动' });
  await expect(startup).not.toBeChecked();
  await startup.check();
  await expect(startup).toBeChecked();
  await page.getByRole('combobox', { name: '点击窗口关闭按钮' }).selectOption('quit');
  await expect(page.getByText('退出前会检查运行中的任务。')).toBeVisible();
  await expect(page.getByText('原来的 Codex 图标')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual([
    'preferences:true:true:tray', 'preferences:true:true:quit',
  ]);
  expect(await page.evaluate(() => ({ outer: document.documentElement.scrollHeight > innerHeight, settings: document.querySelector('.application-settings')!.scrollHeight > document.querySelector('.application-settings')!.clientHeight }))).toEqual({ outer: false, settings: false });
});

test('Feishu settings link and help describe the current behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await fixture(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const link = page.getByRole('link', { name: /飞书开发者后台/ });
  await expect(link).toHaveAttribute('href', 'https://open.feishu.cn/app');
  expect(await page.evaluate(() => ({ outer: document.documentElement.scrollHeight > innerHeight, settings: document.querySelector('.settings-content')!.scrollHeight > document.querySelector('.settings-content')!.clientHeight }))).toEqual({ outer: false, settings: false });
  await page.getByRole('button', { name: '使用帮助' }).click();
  const help = page.getByRole('dialog', { name: '如何使用' });
  await expect(help).toContainText('/usage 套餐余量');
  await expect(help).toContainText('开机自启和关闭窗口方式');
});

test('browser workbench does not offer a native startup setting', async ({ page }) => {
  await fixture(page, ready, false);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '应用与运行', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '启动应用时同时打开 Codex' })).toHaveCount(0);
});

test('desktop folder picker saves the selected workspace and ignores cancellation', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 偏好', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '本机项目目录' })).toHaveCount(0);
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await expect(page.locator('.workspace-folder-path')).toHaveText('D:\\fixture\\selected');
  await expect(page.locator('.settings-save-status')).toHaveText('已保存');
  await page.evaluate(() => (window as unknown as { setSelectedWorkspace: (value: string | null) => void }).setSelectedWorkspace(null));
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await expect(page.locator('.workspace-folder-path')).toHaveText('D:\\fixture\\selected');
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['chooseWorkspace', 'chooseWorkspace']);
});

test('failed startup retries the host before offering to reopen Codex', async ({ page }) => {
  await fixture(page, { ...ready, state: 'error', canWrite: false, runtime: { state: 'backoff' }, launch: { state: 'error', message: '后台尚未就绪' } });
  await page.locator('.desktop-guidance').getByRole('button', { name: '重试连接', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['retry']);
  await page.evaluate(value => (window as unknown as { updateNative: (value: DesktopStatus) => void }).updateNative(value), { ...ready, launch: { state: 'error', message: '上次打开失败，请重试' } });
  await page.locator('.desktop-guidance').getByRole('button', { name: '重试打开', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['retry', 'open']);
});

test('independent desktop offers one connect action; cancelled native confirmation stays quiet', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page, { ...ready, state: 'paused', canWrite: false, desktop: { mode: 'independent' } });
  await expect(page.getByText('Codex 已打开，但尚未连接飞书', { exact: true })).toBeVisible();
  await expect(page.locator('.capability-status')).toHaveText('Codex 未接入飞书，飞书发送已暂停');
  await expect(page.locator('textarea')).toBeDisabled();
  await page.evaluate(() => (window as unknown as { cancelNativeSwitch: () => void }).cancelNativeSwitch());
  await page.locator('.desktop-guidance').getByRole('button', { name: '连接飞书', exact: true }).click();
  await expect(page.getByText('Codex 已打开，但尚未连接飞书', { exact: true })).toBeVisible();
  await expect(page.getByText('操作未完成', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['switch']);
  await page.locator('.desktop-guidance').getByRole('button', { name: '连接飞书', exact: true }).click();
  await expect(page.locator('.desktop-guidance')).toContainText('正在重启 Codex 并连接飞书');
  await expect(page.getByText('等待你退出官方 Codex', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '正在连接', exact: true })).toHaveCount(0);
  await page.evaluate(value => (window as unknown as { updateNative: (value: DesktopStatus) => void }).updateNative(value), { ...ready, desktop: { mode: 'shared' } });
  await expect(page.locator('.desktop-guidance')).toHaveCount(0);
  await expect(page.locator('.capability-status')).toHaveText('飞书与桌面可共同操作');
  await expect(page.locator('textarea')).toBeEnabled();
  expect(await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight }))).toEqual({ x: false, y: false });
});

for (const [name, status, connection] of [
  ['runtime failure', { ...ready, runtime: { state: 'backoff' }, desktop: { mode: 'shared' } }, 'connected'],
  ['bridge failure', { ...ready, bridge: { state: 'unhealthy' }, desktop: { mode: 'shared' } }, 'connected'],
  ['connection failure', { ...ready, desktop: { mode: 'shared' } }, 'error'],
  ['unknown desktop', { ...ready, canWrite: false, desktop: { mode: 'unknown' } }, 'connected'],
] as const) test(`${name} never claims Feishu is ready`, async ({ page }) => {
  await fixture(page, status, true, connection);
  await expect(page.locator('.capability-status')).not.toContainText('飞书可用');
  await expect(page.locator('.capability-status')).not.toContainText('可共同操作');
  await expect(page.locator('.status-bar .status-dot').first()).not.toHaveClass(/good/);
});

test('bootstrap exposes the same confirm-and-connect flow before the workbench is ready', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await fixture(page, { ...ready, state: 'paused', canWrite: false, desktop: { mode: 'independent' } });
  for (const [name, contentType] of [['html', 'text/html'], ['js', 'text/javascript'], ['css', 'text/css']]) {
    const body = await readFile(new URL(`../../desktop/bootstrap.${name}`, import.meta.url));
    await page.route(`**/bootstrap.${name}`, route => route.fulfill({ body, contentType }));
  }
  await page.goto('/bootstrap.html');
  await expect(page.getByText('Codex 已打开，但尚未连接飞书', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { cancelNativeSwitch: () => void }).cancelNativeSwitch());
  await page.getByRole('button', { name: '连接飞书', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接飞书', exact: true })).toBeVisible();
  await expect(page.locator('#error')).toBeEmpty();
  await page.getByRole('button', { name: '连接飞书', exact: true }).click();
  await expect(page.getByText('正在连接飞书', { exact: true })).toBeVisible();
  await expect(page.locator('#desktopDescription')).toContainText('正在重启 Codex 并连接飞书');
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['switch', 'switch']);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(false);
  await page.evaluate(value => (window as unknown as { updateNative: (value: DesktopStatus) => void }).updateNative(value), { ...ready, state: 'error', canWrite: false, runtime: { state: 'backoff' }, launch: { state: 'error' } });
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)).toEqual(['switch', 'switch', 'retry']);
});
