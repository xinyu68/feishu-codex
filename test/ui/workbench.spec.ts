import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.route('**/api/**', route => { throw new Error(`Demo contacted a real API: ${route.request().url()}`); });
});

for (const viewport of [{ width: 1240, height: 800 }, { width: 1024, height: 680 }, { width: 900, height: 640 }]) {
  test(`workbench, bots and settings fit ${viewport.width} × ${viewport.height} without outer scrolling`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?demo=1');
    await expect(page.getByRole('heading', { name: '让飞书和桌面，接着同一件事' })).toBeVisible();
    await expect(page.getByText('现在已经完成了这几项：', { exact: true })).toBeVisible();
    const overflow = () => page.evaluate(() => ({ x: document.documentElement.scrollWidth > window.innerWidth, y: document.documentElement.scrollHeight > window.innerHeight }));
    expect(await overflow()).toEqual({ x: false, y: false });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
    await page.screenshot({ path: `artifacts/workbench-${viewport.width}.png` });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '对话与通知', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '飞书连接', exact: true })).toHaveCount(0);
    expect(await overflow()).toEqual({ x: false, y: false });
    await page.screenshot({ path: `artifacts/settings-${viewport.width}.png` });
    await page.getByRole('button', { name: '机器人', exact: true }).click();
    await expect(page.getByRole('tab', { name: '对话设置', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: '私聊角色说明', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '群聊角色说明', exact: true })).toBeVisible();
    expect(await overflow()).toEqual({ x: false, y: false });
    await page.screenshot({ path: `artifacts/bots-${viewport.width}.png` });
  });
}

test('task and project switching update the workbench immediately and new tasks have no stale history', async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: /验证独立入口与共享入口/ }).click();
  await expect(page.getByRole('heading', { name: '验证独立入口与共享入口' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '接着你的想法，开始做事' })).toBeVisible();
  await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible();
  await page.locator('.project-button').click();
  await page.locator('.project-options').getByRole('button', { name: /sample-web-app/ }).click();
  await expect(page.locator('.directory')).toContainText('D:\\Projects\\sample-web-app');
  await expect(page.locator('.message-column')).not.toContainText('现在已经完成了这几项');
});

test('typing submits locally, offers active steering and the native launch button remains safe in demo', async ({ page }) => {
  await page.goto('/?demo=1');
  const composer = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true });
  await expect(composer).toBeVisible();
  await composer.fill('新工作台界面测试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '补充当前任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await expect(page.getByText('这是一条界面演示回复。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '打开 Codex', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('界面演示模式');
});
