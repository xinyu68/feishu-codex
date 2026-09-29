import { expect, test } from '@playwright/test';

test('empty installation opens bot connection setup without an old service', async ({ page }) => {
  const now = new Date().toISOString();
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') {
      await route.fulfill({ json: {
        csrfToken: 'first-run-fixture', service: { name: 'Feishu Codex', version: '0.2.7', startedAt: now, uptimeSeconds: 0 },
        config: { appId: '', hasSecret: false, enabled: false, allowedActors: [], defaultWorkspace: '', model: '', effort: '', progress: true, autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1 },
        connection: { status: 'stopped' }, codex: { available: false }, conversations: [], pendingActors: [], pendingRequests: [], logs: [],
      } });
    } else if (pathname === '/api/projects') await route.fulfill({ json: { projects: [] } });
    else if (pathname === '/api/models') await route.fulfill({ json: { models: [] } });
    else await route.fulfill({ json: {} });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '连接设置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '机器人', exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole('textbox', { name: 'App ID' })).toBeVisible();
  await expect(page.getByRole('link', { name: /飞书开发者后台/ })).toHaveAttribute('href', 'https://open.feishu.cn/app');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '对话与通知', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'App ID' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /模型|思考深度/ })).toHaveCount(0);
});
