import type { AppState, BotProfile, DesktopNotificationTarget, Message, Session } from './types';

const cwd = 'D:\\Projects\\feishu-codex';
const chatId = 'demo-feishu';
const now = new Date().toISOString();
const privateChats = [
  { chatId: 'oc_demo_private_codex', actorId: 'ou_demo', botAppId: 'cli_demo', botId: 'default' },
  { chatId: 'oc_demo_private_product', actorId: 'ou_demo_product', botAppId: 'cli_demoproduct', botId: 'product' }
];
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
const state: AppState = {
  csrfToken: 'demo', service: { name: 'Feishu Codex', version: '0.2.0', startedAt: now, uptimeSeconds: 240 },
  config: { appId: 'cli_demo', hasSecret: true, enabled: true, allowedActors: ['ou_demo'], defaultWorkspace: cwd, model: '', effort: 'high', progress: true, autoNotifyDesktop: false, desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1,
    desktopNotificationTarget: { chatId: privateChats[0]!.chatId, actorId: privateChats[0]!.actorId, botAppId: privateChats[0]!.botAppId } },
  connection: { status: 'connected' }, codex: { available: true, authenticated: true, mode: 'shared', version: '0.117.0' },
  runtime: { state: 'ready', canWrite: true, runtime: { state: 'ready' }, bridge: { state: 'ready' }, desktop: { mode: 'shared', running: true } },
  conversations: [{ chatId, actorId: 'ou_demo', botId: 'default', botName: 'Codex', chatType: 'p2p', cwd, threadId: sessions[0].id, title: sessions[0].title, revision: 1, updatedAt: now, preview: '', busy: false }],
  bots: [
    { id: 'default', name: 'Codex', appId: 'cli_demo', hasSecret: true, enabled: true, allowedActors: ['ou_demo'], allowedGroups: ['oc_demo_team'], roleInstructions: '协助团队实现功能、检查代码并完成验证。', privateRoleInstructions: '', includeGroupContext: true, model: '', effort: 'high', connection: { status: 'connected' } },
    { id: 'product', name: '产品助手（演示）', appId: 'cli_demoproduct', hasSecret: true, enabled: true, allowedActors: ['ou_demo_product'], allowedGroups: [], roleInstructions: '整理需求和验收标准，帮助团队澄清产品决策。', privateRoleInstructions: '协助整理个人想法和产品笔记。', includeGroupContext: true, model: '', effort: '', connection: { status: 'connected' } }
  ],
  pendingActors: [{ botId: 'product', botName: '产品助手（演示）', actorId: 'ou_demo_pending', chatId: 'oc_demo_private', lastSeenAt: now }],
  pendingGroups: [{ botId: 'product', chatId: 'oc_demo_pending', title: '演示协作群', actorId: 'ou_demo_pending', lastSeenAt: now }],
  pendingRequests: [], logs: [
    { id: 'l1', at: now, level: 'info', text: '飞书长连接已建立' },
    { id: 'l2', at: now, level: 'info', text: 'Codex 共享后台已就绪' }
  ]
};

export async function demoRequest(route: string, body?: Record<string, unknown>, method = 'POST'): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 70));
  const url = new URL(route, location.origin);
  const verb = body === undefined ? 'GET' : method.toUpperCase();
  if (url.pathname === '/api/state') { syncDefaultBot(); return structuredClone(state); }
  if (url.pathname === '/api/bots' && verb === 'GET') return { bots: structuredClone(state.bots) };
  if (url.pathname === '/api/bots' && verb === 'POST') {
    if (state.bots!.length >= 20) throw new Error('最多可配置 20 个机器人。');
    const patch = botPatch(body!);
    if (!patch.name || !patch.appId || !secretFrom(body!)) throw new Error('请填写机器人名称、App ID 和 App Secret。');
    const bot: BotProfile = { id: `bot-${crypto.randomUUID()}`, name: patch.name, appId: '', hasSecret: false, enabled: false, allowedActors: [], allowedGroups: [], roleInstructions: '', privateRoleInstructions: '', includeGroupContext: true, model: '', effort: '', connection: { status: 'stopped' } };
    return activateCredentials(bot, body!);
  }
  const botRoute = /^\/api\/bots\/([^/]+)(?:\/(credentials|connection))?$/.exec(url.pathname);
  if (botRoute) {
    const bot = requireBot(decodeURIComponent(botRoute[1]));
    if (botRoute[2] === 'credentials' && verb === 'POST') return activateCredentials(bot, body!);
    if (botRoute[2] === 'connection' && verb === 'POST') return setConnection(bot, body!);
    if (!botRoute[2] && verb === 'PATCH') {
      const patch = botPatch(body!);
      if ((patch.appId !== undefined && patch.appId !== bot.appId) || secretFrom(body!)) return activateCredentials(bot, body!);
      const saved = saveBot({ ...bot, ...patch });
      return changed({ bot: saved });
    }
    if (!botRoute[2] && verb === 'DELETE') {
      if (bot.id === 'default') throw new Error('默认机器人不能删除，可以关闭连接。');
      assertNoActiveWork('请等当前任务完成后再删除机器人。');
      state.bots = state.bots!.filter(item => item.id !== bot.id);
      clearPending(bot.id);
      return changed({ ok: true });
    }
    throw new Error('演示模式不支持这个机器人操作。');
  }
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
  if (url.pathname === '/api/credentials') return activateCredentials(requireBot('default'), body || {});
  if (url.pathname === '/api/config') return saveConfig(body || {});
  if (url.pathname === '/api/connection') return setConnection(requireBot('default'), body || {});
  if (url.pathname === '/api/actors') {
    const bot = requireBot(String(body?.botId || 'default'));
    const actorId = String(body?.actorId || '').trim();
    if (typeof body?.allow !== 'boolean' || !/^ou_[\w-]+$/.test(actorId)) throw new Error('飞书账号 ID 或授权操作无效。');
    const allowedActors = bot.allowedActors.filter(id => id !== actorId);
    if (body.allow) allowedActors.push(actorId);
    saveBot({ ...bot, allowedActors });
    state.pendingActors = state.pendingActors.filter(item => (item.botId || 'default') !== bot.id || item.actorId !== actorId);
  }
  if (url.pathname === '/api/groups') {
    const bot = requireBot(String(body?.botId || 'default'));
    const groupId = String(body?.chatId || '').trim();
    if (typeof body?.allow !== 'boolean' || !/^oc_[\w-]+$/.test(groupId)) throw new Error('飞书群 ID 或授权操作无效。');
    const allowedGroups = bot.allowedGroups.filter(id => id !== groupId);
    if (body.allow) allowedGroups.push(groupId);
    saveBot({ ...bot, allowedGroups });
    state.pendingGroups = state.pendingGroups!.filter(item => item.botId !== bot.id || item.chatId !== groupId);
  }
  return changed({ ok: true, accepted: true });
}

function requireBot(id: string): BotProfile {
  const bot = state.bots!.find(item => item.id === id);
  if (!bot) throw new Error('这个机器人不存在，请刷新页面。');
  return bot;
}

function syncDefaultBot(): void {
  const bot = requireBot('default');
  state.config = { ...state.config, appId: bot.appId, hasSecret: bot.hasSecret, enabled: bot.enabled, allowedActors: [...bot.allowedActors], model: bot.model, effort: bot.effort };
  state.connection = { ...bot.connection };
  const configured = state.bots!.filter(item => item.appId);
  const connected = configured.filter(item => item.connection.status === 'connected').length;
  const status = connected ? 'connected' : configured.some(item => item.connection.status === 'connecting') ? 'connecting' : configured.some(item => item.connection.status === 'error') ? 'error' : 'stopped';
  state.connectionSummary = { status, connected, total: configured.length, detail: `${connected} / ${configured.length} 个机器人已连接` };
  state.notificationTargets = privateChats.flatMap(target => {
    const owner = state.bots!.find(item => item.id === target.botId && item.appId === target.botAppId && item.hasSecret && item.allowedActors.includes(target.actorId));
    return owner ? [{ ...target, botName: owner.name }] : [];
  });
}

function saveBot(bot: BotProfile): BotProfile {
  const index = state.bots!.findIndex(item => item.id === bot.id);
  if (index < 0) state.bots!.push(bot); else state.bots![index] = bot;
  state.conversations = state.conversations.map(item => (item.botId || 'default') === bot.id ? { ...item, botName: bot.name } : item);
  state.pendingActors = state.pendingActors.map(item => (item.botId || 'default') === bot.id ? { ...item, botName: bot.name } : item);
  syncDefaultBot();
  initializeNotificationTarget();
  return bot;
}

function changed<T>(result: T): T {
  syncDefaultBot();
  initializeNotificationTarget();
  window.dispatchEvent(new Event('demo-change'));
  return structuredClone(result);
}

function initializeNotificationTarget(): void {
  if (state.config.desktopNotificationTarget !== undefined || state.notificationTargets?.length !== 1) return;
  const { chatId, actorId, botAppId } = state.notificationTargets[0]!;
  state.config.desktopNotificationTarget = { chatId, actorId, botAppId };
}

function clearPending(botId: string): void {
  state.pendingActors = state.pendingActors.filter(item => (item.botId || 'default') !== botId);
  state.pendingGroups = state.pendingGroups!.filter(item => item.botId !== botId);
}

function assertNoActiveWork(message: string): void {
  if (state.conversations.some(item => item.busy)) throw new Error(message);
}

function secretFrom(body: Record<string, unknown>): string {
  if (body.appSecret === undefined) return '';
  if (typeof body.appSecret !== 'string' || body.appSecret.length > 1500) throw new Error('App Secret 无效');
  return body.appSecret.trim();
}

function botPatch(body: Record<string, unknown>): Partial<BotProfile> {
  const patch: Partial<BotProfile> = {};
  for (const name of ['name', 'appId', 'roleInstructions', 'privateRoleInstructions', 'model', 'effort'] as const) {
    const value = body[name];
    if (value === undefined) continue;
    const limit = name === 'roleInstructions' || name === 'privateRoleInstructions' ? 12_000 : name === 'name' ? 80 : 1500;
    if (typeof value !== 'string' || value.length > limit || (name === 'name' && !value.trim())) throw new Error(`设置 ${name} 无效`);
    patch[name] = value.trim();
  }
  if (patch.appId !== undefined && !/^cli_(?:[\da-f]{16}|demo[a-z\d]*)$/i.test(patch.appId)) throw new Error('请填写有效的飞书 App ID；演示可使用 cli_demo 开头、后接字母和数字的标识。');
  secretFrom(body);
  for (const name of ['allowedActors', 'allowedGroups'] as const) {
    const value = body[name];
    if (value === undefined) continue;
    const pattern = name === 'allowedActors' ? /^ou_[\w-]+$/ : /^oc_[\w-]+$/;
    if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !pattern.test(id))) throw new Error('授权名单无效');
    patch[name] = [...new Set(value as string[])];
  }
  if (body.includeGroupContext !== undefined) {
    if (typeof body.includeGroupContext !== 'boolean') throw new Error('补充群聊背景设置无效');
    patch.includeGroupContext = body.includeGroupContext;
  }
  return patch;
}

function assertUniqueApp(botId: string, appId: string): void {
  if (state.bots!.some(item => item.id !== botId && item.appId.toLowerCase() === appId.toLowerCase())) throw new Error('这个 App ID 已用于另一个机器人，请使用独立的飞书应用。');
}

function activateCredentials(bot: BotProfile, body: Record<string, unknown>): unknown {
  const patch = botPatch(body);
  const appId = patch.appId ?? bot.appId;
  const hasSecret = Boolean(secretFrom(body)) || (appId === bot.appId && bot.hasSecret);
  if (!appId || !hasSecret) throw new Error('请填写有效的飞书 App ID 和 App Secret。');
  assertUniqueApp(bot.id, appId);
  assertNoActiveWork('请等当前对话完成后再更换应用凭据。');
  const appChanged = bot.appId !== appId;
  const saved = saveBot({ ...bot, ...patch, appId, hasSecret, enabled: true, connection: { status: 'connected' }, ...(appChanged ? { allowedActors: [], allowedGroups: [] } : {}) });
  if (appChanged) clearPending(bot.id);
  return changed({ id: saved.id, config: state.config, connection: saved.connection, bot: saved });
}

function setConnection(bot: BotProfile, body: Record<string, unknown>): unknown {
  if (typeof body.enabled !== 'boolean') throw new Error('缺少连接开关');
  if (body.enabled && (!bot.appId || !bot.hasSecret)) throw new Error('请先填写应用凭据。');
  const saved = saveBot({ ...bot, enabled: body.enabled, connection: { status: body.enabled ? 'connected' : 'stopped' } });
  return changed({ connection: saved.connection, bot: saved });
}

function saveConfig(body: Record<string, unknown>): unknown {
  syncDefaultBot();
  const bot = requireBot('default');
  const patch = botPatch({ ...body, name: body.botName });
  const config = { ...state.config };
  if (body.defaultWorkspace !== undefined) {
    if (typeof body.defaultWorkspace !== 'string' || !body.defaultWorkspace.trim()) throw new Error('请选择本机项目目录。');
    config.defaultWorkspace = body.defaultWorkspace.trim();
  }
  for (const key of ['progress', 'autoNotifyDesktop'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new Error('设置无效');
    config[key] = body[key];
  }
  if (body.desktopNotificationMode !== undefined) {
    if (body.desktopNotificationMode !== 'all' && body.desktopNotificationMode !== 'long') throw new Error('桌面通知范围无效');
    config.desktopNotificationMode = body.desktopNotificationMode;
  }
  if (body.desktopNotificationMinMinutes !== undefined) {
    const value = body.desktopNotificationMinMinutes;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1440) throw new Error('通知时长应为 1–1440 的整数分钟');
    config.desktopNotificationMinMinutes = value;
  }
  if (body.desktopNotificationTarget !== undefined) {
    const value = body.desktopNotificationTarget;
    if (value === null) config.desktopNotificationTarget = null;
    else {
      if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || Object.keys(value).some(key => !['chatId', 'actorId', 'botAppId'].includes(key))) throw new Error('通知接收位置无效');
      const target = value as Partial<DesktopNotificationTarget>;
      const match = state.notificationTargets?.find(item => item.chatId === target.chatId && item.actorId === target.actorId && item.botAppId === target.botAppId);
      if (!match) throw new Error('通知接收位置已失效，请重新选择');
      if (match.botId === bot.id && ((patch.appId !== undefined && patch.appId !== match.botAppId) || (patch.allowedActors !== undefined && !patch.allowedActors.includes(match.actorId)))) throw new Error('通知接收位置已失效，请重新选择');
      config.desktopNotificationTarget = { chatId: match.chatId, actorId: match.actorId, botAppId: match.botAppId };
    }
  }
  const appId = patch.appId ?? bot.appId;
  assertUniqueApp(bot.id, appId);
  const appChanged = appId !== bot.appId;
  const secret = secretFrom(body);
  if (appChanged || secret) assertNoActiveWork('请等当前对话完成后再更换应用凭据。');
  state.config = config;
  saveBot({ ...bot, ...patch, hasSecret: Boolean(secret) || (!appChanged && bot.hasSecret), ...(appChanged ? { allowedActors: [], allowedGroups: [] } : {}), ...((appChanged || secret) ? { enabled: false, connection: { status: 'stopped' as const } } : {}) });
  if (appChanged) clearPending(bot.id);
  return changed({ config: state.config });
}
