import { test, expect } from '@playwright/test';

test('real management API, binding revision and SSE drive the rendered conversation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8796/');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'API 集成测试任务' })).toBeVisible();
  await expect(page.getByText('这是隔离后台的测试任务。', { exact: true })).toBeVisible();
  await page.locator('textarea').fill('通过真实 HTTP 接口发消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('正在运行命令', { exact: true })).toBeVisible();
  await expect(page.locator('.working-meta')).toContainText('已运行');
  await expect(page.getByText('正在通过真实 API 检查实时回复…', { exact: true })).toBeVisible();
  await expect(page.getByText('API 与 SSE 已连通，收到你的测试消息。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.getByRole('heading', { name: /新会话|新任务/, exact: true })).toBeVisible();
  await expect(page.getByText('API 与 SSE 已连通，收到你的测试消息。', { exact: true })).not.toBeVisible();
  await page.locator('.project-button').click();
  await page.locator('.project-options').getByRole('button', { name: /second-project/ }).click();
  await expect(page.locator('.directory')).toContainText('second-project');
  expect(errors).toEqual([]);
});
