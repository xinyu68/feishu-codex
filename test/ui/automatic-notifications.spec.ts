import { test, expect } from '@playwright/test';

test('desktop completion notification preference starts off and persists through the real settings API', async ({ page }) => {
  const base = 'http://127.0.0.1:8796';
  const state = await (await page.request.get(`${base}/api/state`)).json();
  const save = (enabled: boolean) => page.request.put(`${base}/api/config`, {
    headers: { 'X-Bridge-Token': state.csrfToken }, data: { autoNotifyDesktop: enabled },
  });
  await save(false);
  try {
    await page.setViewportSize({ width: 1024, height: 680 });
    await page.goto(base);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '对话与通知', exact: true }).click();
    const toggle = page.getByRole('checkbox', { name: '桌面任务完成后通知飞书', exact: true });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('需要时可说“做完飞书通知我”，仅通知本轮。')).toBeVisible();
    await toggle.check();
    await expect(page.getByRole('button', { name: '保存偏好', exact: true })).toHaveCount(0);
    await expect(page.locator('.settings-save-status')).toHaveText('已保存');
    expect((await (await page.request.get(`${base}/api/state`)).json()).config.autoNotifyDesktop).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '对话与通知', exact: true }).click();
    await expect(toggle).toBeChecked();
    await page.screenshot({ path: 'artifacts/desktop-auto-notifications-settings.png' });
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(false);
    await toggle.uncheck();
    await expect(page.locator('.settings-save-status')).toHaveText('已保存');
    expect((await (await page.request.get(`${base}/api/state`)).json()).config.autoNotifyDesktop).toBe(false);
  } finally { await save(false); }
});

test('automatic settings feedback fits a compact application window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存凭据', exact: true })).toHaveCount(0);
  await expect(page.locator('.settings-save-status')).toBeInViewport();
  expect(await page.locator('.settings-content').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(false);
  await page.getByRole('button', { name: '对话与通知', exact: true }).click();
  await expect(page.locator('.settings-save-status')).toBeInViewport();
  await expect(page.getByRole('checkbox', { name: '桌面任务完成后通知飞书' })).toBeInViewport();
  expect(await page.locator('.settings-content').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(false);
});
