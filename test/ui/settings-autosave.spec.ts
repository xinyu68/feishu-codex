import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:8796';
async function config(page: Page) { return (await (await page.request.get(`${base}/api/state`)).json()).config; }
async function openSettings(page: Page) {
  await page.goto(base);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '对话与通知', exact: true }).click();
}
async function openCredentials(page: Page) {
  await page.goto(base);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
}
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => {
  const state = await (await page.request.get(`${base}/api/state`)).json();
  await page.request.post(`${base}/api/connection`, { headers: { 'X-Bridge-Token': state.csrfToken }, data: { enabled: false } });
  await page.request.put(`${base}/api/config`, { headers: { 'X-Bridge-Token': state.csrfToken }, data: {
    autoNotifyDesktop: false, progress: true, model: '', effort: '', appId: 'cli_1234567890abcdef', appSecret: 'fixture-only-secret',
  } });
});

test('quick choices are saved in order without posting unrelated fields', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: object[] = [];
  await page.route('**/api/config', async route => {
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) await gate;
    await route.continue();
  });
  await openSettings(page);
  const toggle = page.getByRole('checkbox', { name: '桌面任务完成后通知飞书', exact: true });
  await toggle.check();
  await expect.poll(() => writes.length).toBe(1);
  await toggle.uncheck();
  await page.getByRole('checkbox', { name: /在飞书显示处理进度/ }).uncheck();
  expect(writes).toEqual([{ autoNotifyDesktop: true }]);
  await expect(toggle).not.toBeChecked();
  // A pending save also survives leaving the settings page.
  await page.getByRole('button', { name: '对话', exact: true }).click();
  release();
  await expect.poll(async () => ({ notify: (await config(page)).autoNotifyDesktop, progress: (await config(page)).progress })).toEqual({ notify: false, progress: false });
  expect(writes).toEqual([{ autoNotifyDesktop: true }, { autoNotifyDesktop: false }, { progress: false }]);
  await openSettings(page);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /在飞书显示处理进度/ })).not.toBeChecked();
});

test('failed auto-save remains visible and can be retried after navigation', async ({ page }) => {
  let reject = true;
  await page.route('**/api/config', async route => {
    if (reject) { reject = false; await route.fulfill({ status: 503, json: { error: '测试服务暂不可用' } }); }
    else await route.continue();
  });
  await openSettings(page);
  await page.getByRole('checkbox', { name: '桌面任务完成后通知飞书' }).check();
  await expect(page.getByRole('alert')).toContainText('自动保存失败');
  expect((await config(page)).autoNotifyDesktop).toBe(false);
  await expect(page.locator('.settings-save-status')).not.toHaveText('已保存');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('修改已保留');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '对话与通知', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '桌面任务完成后通知飞书' })).toBeChecked();
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.locator('.settings-save-status')).toHaveText('已保存');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await config(page)).autoNotifyDesktop).toBe(true);
});

test('directory waits for blur while bot model and effort save immediately together', async ({ page }) => {
  await page.route('**/api/models', route => route.fulfill({ json: { models: [{ id: 'fixture-model', name: '测试模型', efforts: ['low', 'high'], defaultEffort: 'high' }] } }));
  const writes: object[] = [];
  await page.route('**/api/config', async route => { writes.push(route.request().postDataJSON()); await route.continue(); });
  const botWrites: object[] = [];
  await page.route('**/api/bots/default', async route => { botWrites.push(route.request().postDataJSON()); await route.continue(); });
  await openSettings(page);
  const previous = (await config(page)).defaultWorkspace;
  const next = (await (await page.request.get(`${base}/api/projects`)).json()).projects.find((project: { path: string }) => project.path !== previous).path;
  const workspace = page.getByRole('textbox', { name: '本机项目目录' });
  await workspace.fill(next);
  expect((await config(page)).defaultWorkspace).toBe(previous);
  expect(writes).toEqual([]);
  await page.getByRole('heading', { name: '对话与通知', exact: true }).click();
  await expect.poll(async () => (await config(page)).defaultWorkspace).toBe(next);
  await expect(page.getByRole('combobox', { name: /模型|思考深度/ })).toHaveCount(0);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('tab', { name: '对话设置', exact: true }).click();
  await page.getByRole('combobox', { name: '机器人模型', exact: true }).selectOption('fixture-model');
  await expect.poll(async () => ({ model: (await config(page)).model, effort: (await config(page)).effort })).toEqual({ model: 'fixture-model', effort: 'high' });
  await page.getByRole('combobox', { name: '机器人思考深度', exact: true }).selectOption('low');
  await expect.poll(async () => (await config(page)).effort).toBe('low');
  expect(writes).toEqual([{ defaultWorkspace: next }]);
  expect(botWrites).toEqual([{ model: 'fixture-model', effort: 'high' }, { effort: 'low' }]);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await workspace.fill(previous);
  await workspace.press('Enter');
  await expect.poll(async () => (await config(page)).defaultWorkspace).toBe(previous);
});

test('correcting an invalid directory back to the saved value clears the failed draft', async ({ page }) => {
  await openSettings(page);
  const previous = (await config(page)).defaultWorkspace;
  const workspace = page.getByRole('textbox', { name: '本机项目目录' });
  await workspace.fill(`${previous}\\does-not-exist`);
  await workspace.press('Enter');
  await expect(page.getByRole('alert')).toContainText('存在的本机项目目录');
  await workspace.fill(previous);
  await workspace.press('Enter');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.settings-save-status')).toHaveText('已保存');
  expect((await config(page)).defaultWorkspace).toBe(previous);
});

test('credentials validate and connect on leaving the pair without pairing a new app with an old secret', async ({ page }) => {
  const writes: object[] = [];
  await page.route('**/api/bots/default/credentials', async route => { writes.push(route.request().postDataJSON()); await route.continue(); });
  await openCredentials(page);
  const appId = page.getByRole('textbox', { name: 'App ID', exact: true });
  const secret = page.locator('input[type="password"]:visible');
  const heading = page.getByRole('tab', { name: '连接设置', exact: true });
  await appId.fill('cli_abcdef0123456789');
  await secret.focus();
  expect(writes).toEqual([]);
  await secret.fill('fixture-new-secret');
  expect((await config(page)).appId).toBe('cli_1234567890abcdef');
  await heading.click();
  await expect.poll(async () => (await config(page)).appId).toBe('cli_abcdef0123456789');
  expect(writes).toEqual([{ appId: 'cli_abcdef0123456789', appSecret: 'fixture-new-secret' }]);
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await expect(secret).toHaveValue('');
  expect((await config(page)).hasSecret).toBe(true);
  expect((await config(page)).enabled).toBe(true);
  await expect(page.locator('.bot-connection-status:visible')).toHaveText('已连接');
  expect((await config(page)).appSecret).toBeUndefined();
  await appId.fill('cli_1111111111111111');
  await heading.click();
  expect(writes).toHaveLength(1);
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('对应的 App Secret');
  expect((await config(page)).appId).toBe('cli_abcdef0123456789');
  expect(writes).toHaveLength(1);
  await secret.fill('fixture-other-secret');
  await heading.click();
  await expect.poll(async () => (await config(page)).appId).toBe('cli_1111111111111111');
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await expect(secret).toHaveValue('');
  await secret.focus();
  await heading.click();
  expect(writes).toHaveLength(2);
});

test('busy credential rejection preserves both fields for retry', async ({ page }) => {
  let reject = true;
  await page.route('**/api/bots/default/credentials', async route => {
    if (reject) { reject = false; await route.fulfill({ status: 409, json: { error: '请等当前对话完成后再更换应用凭据。' } }); }
    else await route.continue();
  });
  await openCredentials(page);
  await page.getByRole('textbox', { name: 'App ID', exact: true }).fill('cli_2222222222222222');
  await page.locator('input[type="password"]:visible').fill('fixture-retry-secret');
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请等当前对话完成');
  expect((await config(page)).appId).toBe('cli_1234567890abcdef');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'App ID', exact: true })).toHaveValue('cli_2222222222222222');
  await expect(page.locator('input[type="password"]:visible')).toHaveValue('fixture-retry-secret');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(async () => (await config(page)).appId).toBe('cli_2222222222222222');
  expect((await config(page)).appId).toBe('cli_2222222222222222');
  expect((await config(page)).enabled).toBe(true);
  await page.getByRole('button', { name: '修改凭据', exact: true }).click();
  await expect(page.locator('input[type="password"]:visible')).toHaveValue('');
});
