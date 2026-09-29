import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:8796';
const getConfig = async (page: Page) => (await (await page.request.get(`${base}/api/state`)).json()).config;
async function defaults(page: Page, url = base) {
  await page.goto(url);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '对话与通知', exact: true }).click();
}

test('notification mode and minutes auto-save, retain choices when off and survive reload', async ({ page }) => {
  const state = await (await page.request.get(`${base}/api/state`)).json();
  const patch = (data: object) => page.request.put(`${base}/api/config`, { headers: { 'X-Bridge-Token': state.csrfToken }, data });
  await patch({ autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1 });
  try {
    await defaults(page);
    const manualHint = page.getByText('需要时可说“做完飞书通知我”，仅通知本轮。');
    await expect(manualHint).toBeVisible();
    const toggle = page.getByRole('checkbox', { name: '桌面任务完成后通知飞书', exact: true });
    const mode = page.getByRole('combobox', { name: '桌面通知范围', exact: true });
    const minutes = page.getByRole('spinbutton', { name: '长任务通知阈值（分钟）', exact: true });
    await expect(mode).toHaveCount(0);
    await toggle.check();
    await expect(manualHint).toHaveCount(0);
    await expect(mode).toHaveValue('all');
    await expect(minutes).toHaveCount(0);
    await mode.selectOption('long');
    await expect.poll(async () => (await getConfig(page)).desktopNotificationMode).toBe('long');
    await expect(minutes).toHaveValue('1');
    await minutes.fill('3');
    expect((await getConfig(page)).desktopNotificationMinMinutes).toBe(1);
    await minutes.press('Enter');
    await expect.poll(async () => (await getConfig(page)).desktopNotificationMinMinutes).toBe(3);
    await toggle.uncheck();
    await expect(manualHint).toBeVisible();
    await expect(mode).toHaveCount(0);
    await expect.poll(async () => (await getConfig(page)).autoNotifyDesktop).toBe(false);
    await defaults(page);
    await toggle.check();
    await expect(mode).toHaveValue('long');
    await expect(minutes).toHaveValue('3');
    await mode.selectOption('all');
    await expect.poll(async () => (await getConfig(page)).desktopNotificationMode).toBe('all');
    await expect(minutes).toHaveCount(0);
    expect((await getConfig(page)).desktopNotificationMinMinutes).toBe(3);
  } finally { await patch({ autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1 }); }
});

test('invalid threshold is clearly rejected without persisting or falsely reporting success', async ({ page }) => {
  const state = await (await page.request.get(`${base}/api/state`)).json();
  const patch = (data: object) => page.request.put(`${base}/api/config`, { headers: { 'X-Bridge-Token': state.csrfToken }, data });
  await patch({ autoNotifyDesktop: true, desktopNotificationMode: 'long', desktopNotificationMinMinutes: 1 });
  try {
    await defaults(page);
    const minutes = page.getByRole('spinbutton', { name: '长任务通知阈值（分钟）' });
    for (const value of ['', '0', '-1', '1.5', '1441']) {
      await minutes.fill(value);
      await minutes.press('Enter');
      await expect(page.getByRole('alert')).toContainText('1–1440');
      expect((await getConfig(page)).desktopNotificationMinMinutes).toBe(1);
    }
    await minutes.fill('5');
    await minutes.press('Tab');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => (await getConfig(page)).desktopNotificationMinMinutes).toBe(5);
  } finally { await patch({ autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1 }); }
});

test('expanded long-task controls fit the compact desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await defaults(page, '/?demo=1');
  await expect(page.getByText('需要时可说“做完飞书通知我”，仅通知本轮。')).toBeInViewport();
  expect(await page.locator('.settings-content').evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0);
  await page.getByRole('checkbox', { name: '桌面任务完成后通知飞书' }).check();
  await page.getByRole('combobox', { name: '桌面通知范围' }).selectOption('long');
  await expect(page.getByRole('spinbutton', { name: '长任务通知阈值（分钟）' })).toBeInViewport();
  await expect(page.getByText('从本轮开始执行到结束计时；明确要求的通知不受时长限制。')).toBeInViewport();
  expect(await page.locator('.settings-content').evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(false);
  await page.screenshot({ path: 'artifacts/notification-duration-settings.png' });
});
