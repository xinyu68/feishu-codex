import type { AppState, Message, Session } from './types';

const cwd = 'D:\\Projects\\feishu-codex';
const chatId = 'demo-feishu';
const now = new Date().toISOString();
const sessions: Session[] = [
  { id: 'desktop-workbench', title: '让飞书和桌面，接着同一件事', cwd, updatedAt: now, preview: '完善桌面工作台和共享运行时的启动体验' },
  { id: 'launch-check', title: '验证独立入口与共享入口', cwd, updatedAt: now, preview: '两个入口均已通过启动验证' },
  { id: 'message-flow', title: '梳理飞书消息的收发流程', cwd, updatedAt: now, preview: '保留消息进度，避免重复发送' },
  { id: 'auth-check', title: '检查通知与文件发送', cwd, updatedAt: now, preview: '已确认内置 MCP 和 Skill 可用' }
];
let messages: Message[] = [
  { id: 'm1', role: 'user', text: '我们把后台重新做成一个桌面应用吧。打开就能看到当前项目和任务，在飞书上也能接着聊。', at: now },
  { id: 'm2', role: 'assistant', text: '可以。工作台会围绕你正在做的事展开，当前项目、任务和消息放在同一个页面。\n\n现在已经完成了这几项：\n\n- **项目与任务同步**：在这里切换后，飞书会接着同一个任务\n- **双端接续**：桌面和飞书使用同一个 Codex 后台\n- **独立启动**：原来的 Codex 图标仍然可以单独使用\n\n接下来可以在这里继续，也可以点击右上角 **打开 Codex**，回到熟悉的桌面界面。', at: now }
];
let state: AppState = {
  csrfToken: 'demo', service: { name: 'Feishu Codex', version: '0.2.0', startedAt: now, uptimeSeconds: 240 },
  config: { appId: 'cli_demo', hasSecret: true, enabled: true, allowedActors: ['ou_demo'], defaultWorkspace: cwd, model: '', effort: 'high', progress: true, autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1 },
  connection: { status: 'connected' }, codex: { available: true, authenticated: true, mode: 'shared', version: '0.117.0' },
  runtime: { state: 'ready', canWrite: true, runtime: { state: 'ready' }, bridge: { state: 'ready' }, desktop: { mode: 'shared', running: true } },
  conversations: [{ chatId, actorId: 'ou_demo', cwd, threadId: sessions[0].id, title: sessions[0].title, revision: 1, updatedAt: now, preview: '', busy: false }],
  pendingActors: [], pendingRequests: [], logs: [
    { id: 'l1', at: now, level: 'info', text: '飞书长连接已建立' },
    { id: 'l2', at: now, level: 'info', text: 'Codex 共享后台已就绪' }
  ]
};

export async function demoRequest(route: string, body?: Record<string, unknown>): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 70));
  const url = new URL(route, location.origin);
  if (url.pathname === '/api/state') return structuredClone(state);
  if (url.pathname === '/api/projects') return { projects: [
    { name: 'feishu-codex', path: cwd, threadCount: 4, lastActiveAt: now },
    { name: 'sample-web-app', path: 'D:\\Projects\\sample-web-app', threadCount: 12, lastActiveAt: now },
    { name: '个人工作区', path: 'C:\\Users\\Developer\\Documents\\workspace', threadCount: 3, lastActiveAt: now }
  ] };
  if (url.pathname === '/api/sessions') return { sessions: sessions.filter((item) => item.cwd === url.searchParams.get('cwd')) };
  if (url.pathname === '/api/history') return { messages: structuredClone(messages), threadId: state.conversations[0].threadId, source: 'codex' };
  if (url.pathname === '/api/models') return { models: [{ id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }] };
  if (url.pathname === '/api/bind' || url.pathname === '/api/new') {
    const session = sessions.find((item) => item.id === body?.threadId);
    state.conversations[0] = { ...state.conversations[0], cwd: String(body?.cwd || cwd), threadId: session?.id, title: session?.title || '新任务', revision: (state.conversations[0].revision || 0) + 1, updatedAt: new Date().toISOString() };
    messages = session?.id === 'desktop-workbench' ? messages : [];
  }
  if (url.pathname === '/api/chat') {
    messages.push({ id: crypto.randomUUID(), role: 'user', text: String(body?.text), at: now });
    state.conversations[0].busy = true;
    setTimeout(() => {
      messages.push({ id: crypto.randomUUID(), role: 'assistant', text: '这是一条界面演示回复。预览模式不会连接飞书，也不会提交真实的 Codex 任务。', at: now });
      state.conversations[0].busy = false;
      window.dispatchEvent(new Event('demo-change'));
    }, 1300);
  }
  if (url.pathname === '/api/stop') state.conversations[0].busy = false;
  if (url.pathname === '/api/config') state.config = { ...state.config, ...body, hasSecret: state.config.hasSecret || Boolean(body?.appSecret) } as AppState['config'];
  if (url.pathname === '/api/connection') state.connection = { status: body?.enabled ? 'connected' : 'stopped' };
  if (url.pathname === '/api/actors') {
    const actorId = String(body?.actorId);
    state.config.allowedActors = state.config.allowedActors.filter((id) => id !== actorId);
    if (body?.allow) state.config.allowedActors.push(actorId);
    state.pendingActors = state.pendingActors.filter((item) => item.actorId !== actorId);
  }
  window.dispatchEvent(new Event('demo-change'));
  return url.pathname === '/api/config' ? { config: structuredClone(state.config) } : { ok: true, accepted: true };
}
