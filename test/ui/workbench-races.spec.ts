import { test, expect, type Page } from '@playwright/test';

function fixtureState() {
  return {
    csrfToken: 'fixture-token',
    service: { name: 'Feishu Codex', version: 'fixture', uptimeSeconds: 1, startedAt: new Date().toISOString() },
    config: { appId: 'cli_fixture', hasSecret: true, enabled: false, allowedActors: ['ou_fixture'], defaultWorkspace: 'D:\\fixture', model: '', effort: '', progress: true },
    connection: { status: 'stopped' }, codex: { available: true, authenticated: true, mode: 'shared' },
    runtime: { state: 'ready', canWrite: true, desktop: { mode: 'none' } },
    conversations: [{ chatId: 'oc_fixture', actorId: 'ou_fixture', title: '边界测试任务', cwd: 'D:\\fixture', threadId: 'thread-first' as string | undefined, revision: 1, updatedAt: new Date().toISOString(), preview: '', busy: false }],
    pendingActors: [], pendingRequests: [], logs: [],
  };
}

async function mockEvents(page: Page) {
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        const data = (event as CustomEvent<{ type: string; data: unknown }>).detail;
        this.dispatchEvent(new MessageEvent(data.type, { data: JSON.stringify(data.data) }));
      };
      constructor() { super(); window.addEventListener('fixture-sse', this.listener); }
      close() { window.removeEventListener('fixture-sse', this.listener); }
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEventSource });
  });
}

test('draft-to-draft project changes and explicit new tasks clear the previous draft', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible();
  await page.locator('textarea').fill('这个草稿只属于旧项目');
  await page.locator('.project-button').click();
  await page.locator('.project-options').getByRole('button', { name: /sample-web-app/ }).click();
  await expect(page.locator('.directory')).toContainText('sample-web-app');
  await expect(page.locator('textarea')).toHaveValue('');
  await page.locator('textarea').fill('这个草稿只属于旧任务');
  await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.locator('textarea')).toHaveValue('');
});

test('a late old-thread history response never appears inside a new unstarted task', async ({ page }) => {
  await mockEvents(page);
  const state = fixtureState();
  let staleServed = false;
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (pathname === '/api/state') body = state;
    if (pathname === '/api/runtime-status') body = state.runtime;
    if (pathname === '/api/projects') body = { projects: [] };
    if (pathname === '/api/sessions') body = { sessions: [] };
    if (pathname === '/api/new') Object.assign(state.conversations[0], { title: '新任务', threadId: undefined, revision: 2 });
    if (pathname === '/api/history') {
      if (state.conversations[0].revision === 1) body = { threadId: 'thread-first', messages: [{ id: 'before', role: 'assistant', text: '原始历史' }] };
      else if (!staleServed) {
        staleServed = true;
        body = { threadId: 'thread-first', messages: [{ id: 'late', role: 'assistant', text: '不应出现在新任务里的迟到旧历史' }] };
      } else body = { messages: [] };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.getByText('原始历史', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const record = window as unknown as { staleHistoryAppeared: boolean };
    record.staleHistoryAppeared = false;
    new MutationObserver(() => {
      if (document.querySelector('.message-column')?.textContent?.includes('不应出现在新任务里的迟到旧历史')) record.staleHistoryAppeared = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '接着你的想法，开始做事' })).toBeVisible();
  expect(staleServed).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { staleHistoryAppeared: boolean }).staleHistoryAppeared)).toBe(false);
});

test('a lost submission response is not automatically replayed and manual retry keeps its id', async ({ page }) => {
  await mockEvents(page);
  const state = fixtureState();
  const submissions: { messageId: string; text: string }[] = [];
  const messages: { id: string; role: string; text: string }[] = [];
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (pathname === '/api/state') body = state;
    if (pathname === '/api/runtime-status') body = state.runtime;
    if (pathname === '/api/projects') body = { projects: [] };
    if (pathname === '/api/sessions') body = { sessions: [] };
    if (pathname === '/api/history') body = { threadId: 'thread-first', messages };
    if (pathname === '/api/chat') {
      const input = route.request().postDataJSON() as { messageId: string; text: string };
      submissions.push(input);
      if (!messages.some(item => item.id === input.messageId)) messages.push({ id: input.messageId, role: 'user', text: input.text });
      if (submissions.length === 1) { await route.abort('failed'); return; }
      body = { accepted: true };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.locator('textarea').fill('只执行一次的消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('提交结果尚未确认');
  await expect(page.locator('.message-column')).toContainText('只执行一次的消息');
  await expect(page.locator('textarea')).toHaveValue('只执行一次的消息');
  await page.waitForTimeout(500);
  expect(submissions).toHaveLength(1);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue('');
  expect(submissions).toHaveLength(2);
  expect(submissions[1].messageId).toBe(submissions[0].messageId);
  expect(messages).toHaveLength(1);
});

test('new stream text respects a user reading above the bottom and Markdown stays contained', async ({ page }) => {
  await mockEvents(page);
  const state = fixtureState();
  const messages = [{ id: 'long-history', role: 'assistant', text: [
    '| 文件 | 状态 |\n| --- | --- |\n| report.md | 已完成 |',
    '```typescript\nconst result = "ready";\n```',
    ...Array.from({ length: 45 }, (_, index) => `第 ${index + 1} 条历史记录。`),
  ].join('\n\n') }];
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === '/api/state' ? state : pathname === '/api/runtime-status' ? state.runtime : pathname === '/api/projects' ? { projects: [] } : pathname === '/api/sessions' ? { sessions: [] } : pathname === '/api/history' ? { threadId: 'thread-first', messages } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.getByText('第 45 条历史记录。', { exact: true })).toBeVisible();
  const pane = page.locator('.messages');
  await pane.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '最新消息', exact: true })).toBeVisible();
  const topBefore = await pane.evaluate(element => element.scrollTop);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-sse', { detail: { type: 'runtime', data: { delta: { threadId: 'thread-first', turnId: 'turn-new', itemId: 'stream-new', text: '新增的实时回复', phase: 'final_answer' } } } })));
  await expect(page.locator('.message-column')).toContainText('新增的实时回复');
  expect(await pane.evaluate(element => element.scrollTop)).toBe(topBefore);
  await expect(page.locator('.markdown table')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '复制代码', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('button', { name: '最新消息', exact: true }).click();
  await expect.poll(() => pane.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(10);
});

test('allocating a first task and completing an older send do not erase a newly edited draft', async ({ page }) => {
  await mockEvents(page);
  const state = fixtureState();
  Object.assign(state.conversations[0], { threadId: undefined, title: '新任务' });
  let releaseSubmit: (() => void) | undefined;
  const submissionPending = new Promise<void>(resolve => { releaseSubmit = resolve; });
  let received = false;
  let allocatedHistoryRead = false;
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (pathname === '/api/state') body = state;
    if (pathname === '/api/runtime-status') body = state.runtime;
    if (pathname === '/api/projects') body = { projects: [] };
    if (pathname === '/api/sessions') body = { sessions: [] };
    if (pathname === '/api/history') {
      allocatedHistoryRead = allocatedHistoryRead || state.conversations[0].threadId === 'allocated';
      body = { threadId: state.conversations[0].threadId, messages: [] };
    }
    if (pathname === '/api/chat') {
      received = true;
      Object.assign(state.conversations[0], { threadId: 'allocated', busy: true });
      await submissionPending;
      body = { accepted: true };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.locator('textarea').fill('第一条消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await page.locator('textarea').fill('仍在编辑的补充要求');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-sse', { detail: { type: 'state', data: {} } })));
  await expect.poll(() => allocatedHistoryRead).toBe(true);
  await expect(page.locator('textarea')).toHaveValue('仍在编辑的补充要求');
  releaseSubmit!();
  await expect(page.getByRole('button', { name: '补充当前任务', exact: true })).toBeEnabled();
  await expect(page.locator('textarea')).toHaveValue('仍在编辑的补充要求');
});
