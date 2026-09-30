import type { AppState, BotProfile, Conversation, DesktopNotificationTarget, Message, Session } from './types';

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
const initialMessages: Message[] = [
  { id: 'm1', role: 'user', text: '我们把后台重新做成一个桌面应用吧。打开就能看到当前项目和任务，在飞书上也能接着聊。', at: now },
  { id: 'm2', role: 'assistant', text: '可以。工作台会围绕你正在做的事展开，当前项目、任务和消息放在同一个页面。\n\n现在已经完成了这几项：\n\n- **项目与任务同步**：在这里切换后，飞书会接着同一个任务\n- **双端接续**：桌面和飞书使用同一个 Codex 后台\n- **独立启动**：原来的 Codex 图标仍然可以单独使用\n\n接下来可以在这里继续，也可以点击右上角 **打开 Codex**，回到熟悉的桌面界面。', at: now }
];
const histories = new Map<string, Message[]>([['desktop-workbench', initialMessages]]);
const sessionChats = new Map<string, string>();
const state: AppState = {
  csrfToken: 'demo', service: { name: 'Feishu Codex', version: '0.2.0', startedAt: now, uptimeSeconds: 240 },
  config: { appId: 'cli_demo', hasSecret: true, enabled: true, allowedActors: ['ou_demo'], defaultWorkspace: cwd, model: '', effort: 'high', progress: true, autoNotifyDesktop: true, desktopNotificationMode: 'long', desktopNotificationMinMinutes: 1,
    desktopNotificationTarget: { chatId: privateChats[0]!.chatId, actorId: privateChats[0]!.actorId, botAppId: privateChats[0]!.botAppId } },
  connection: { status: 'connected' }, codex: { available: true, authenticated: true, mode: 'shared', version: '0.117.0' },
  runtime: { state: 'ready', canWrite: true, runtime: { state: 'ready' }, bridge: { state: 'ready' }, desktop: { mode: 'shared', running: true } },
  conversations: [{ chatId, actorId: 'ou_demo', botId: 'default', botName: 'Codex', chatType: 'p2p', cwd, threadId: sessions[0].id, title: sessions[0].title, revision: 1, updatedAt: now, preview: '', busy: false }],
  bots: [
    { id: 'default', name: 'Codex', engine: 'codex', appId: 'cli_demo', hasSecret: true, enabled: true, allowedActors: ['ou_demo'], allowedGroups: ['oc_demo_team'], roleInstructions: '协助团队实现功能、检查代码并完成验证。', privateRoleInstructions: '', includeGroupContext: true, model: '', effort: 'high', connection: { status: 'connected' } },
    { id: 'product', name: '产品助手（演示）', engine: 'codex', appId: 'cli_demoproduct', hasSecret: true, enabled: true, allowedActors: ['ou_demo_product'], allowedGroups: [], roleInstructions: '整理需求和验收标准，帮助团队澄清产品决策。', privateRoleInstructions: '协助整理个人想法和产品笔记。', includeGroupContext: true, model: '', effort: '', connection: { status: 'connected' } }
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
    const bot: BotProfile = { id: `bot-${crypto.randomUUID()}`, name: patch.name, engine: patch.engine ?? 'codex', appId: '', hasSecret: false, enabled: false, allowedActors: [], allowedGroups: [], roleInstructions: '', privateRoleInstructions: '', includeGroupContext: true, model: '', effort: '', connection: { status: 'stopped' } };
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
      if (patch.engine && patch.engine !== (bot.engine ?? 'codex')) throw new Error('机器人创建后不能更换处理对话的 AI，请删除后重新添加。');
      const saved = saveBot({ ...bot, ...patch });
      return changed({ bot: saved });
    }
    if (!botRoute[2] && verb === 'DELETE') {
      const owned = state.conversations.filter(item => item.chatId !== 'local-preview' && (item.botId || 'default') === bot.id);
      if (owned.some(item => item.busy) || state.pendingRequests.some(item => owned.some(conversation => conversation.chatId === item.chatId))) {
        throw new Error('这个机器人还有任务或待处理请求，请完成后再删除。');
      }
      if (state.config.desktopNotificationTarget?.botAppId === bot.appId) state.config.desktopNotificationTarget = null;
      state.bots = state.bots!.filter(item => item.id !== bot.id);
      state.conversations = state.conversations.filter(item => !owned.includes(item));
      clearPending(bot.id);
      if (!state.conversations.length) conversationFor('local-preview');
      return changed({ ok: true });
    }
    throw new Error('演示模式不支持这个机器人操作。');
  }
  if (url.pathname === '/api/projects') return { projects: [
    { name: 'feishu-codex', path: cwd, threadCount: 4, lastActiveAt: now },
    { name: 'sample-web-app', path: 'D:\\Projects\\sample-web-app', threadCount: 12, lastActiveAt: now },
    { name: '个人工作区', path: 'C:\\Users\\Developer\\Documents\\workspace', threadCount: 3, lastActiveAt: now }
  ] };
  if (url.pathname === '/api/sessions') return { sessions: structuredClone(sessionsFor(url.searchParams.get('cwd') || '', url.searchParams.get('chatId') || undefined)) };
  if (url.pathname === '/api/history') {
    const conversation = conversationFor(url.searchParams.get('chatId') || undefined);
    return { messages: structuredClone(historyFor(conversation)), threadId: conversation.threadId, source: 'codex' };
  }
  if (url.pathname === '/api/models') return { models: engineForChat(url.searchParams.get('chatId') || undefined) === 'hermes' ? [] : [{ id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }] };
  if (url.pathname === '/api/bind' || url.pathname === '/api/new') {
    const conversation = conversationFor(typeof body?.chatId === 'string' ? body.chatId : undefined);
    const selectedWorkspace = String(body?.cwd || cwd);
    const threadId = typeof body?.threadId === 'string' ? body.threadId : undefined;
    if (threadId && threadId.startsWith('hermes:') !== (engineForChat(conversation.chatId) === 'hermes')) throw new Error('Hermes 和 Codex 使用独立会话，请选择当前执行端的会话或新建。');
    const session = sessionsFor(selectedWorkspace, conversation.chatId).find(item => item.id === threadId);
    if (threadId && !session) throw new Error('该会话不属于所选项目，请刷新列表后重试。');
    Object.assign(conversation, { cwd: selectedWorkspace, threadId: session?.id, title: session?.title || '新任务', revision: (conversation.revision || 0) + 1, updatedAt: new Date().toISOString() });
  }
  if (url.pathname === '/api/chat') {
    const conversation = conversationFor(typeof body?.chatId === 'string' ? body.chatId : undefined);
    if (!conversation.threadId) {
      conversation.threadId = `${engineForChat(conversation.chatId) === 'hermes' ? 'hermes:' : ''}demo-session-${crypto.randomUUID()}`;
      conversation.title = String(body?.text || '新任务').slice(0, 50);
      sessions.push({ id: conversation.threadId, title: conversation.title, cwd: conversation.cwd, updatedAt: now, preview: '' });
      sessionChats.set(conversation.threadId, conversation.chatId);
    }
    const messages = historyFor(conversation);
    messages.push({ id: crypto.randomUUID(), role: 'user', text: String(body?.text), at: now });
    conversation.busy = true;
    setTimeout(() => {
      messages.push({ id: crypto.randomUUID(), role: 'assistant', text: '这是一条界面演示回复。预览模式不会连接飞书，也不会提交真实的 Codex 或 Hermes 任务。', at: now });
      conversation.busy = false;
      window.dispatchEvent(new Event('demo-change'));
    }, 1300);
  }
  if (url.pathname === '/api/stop') conversationFor(typeof body?.chatId === 'string' ? body.chatId : undefined).busy = false;
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
  const bot = state.bots!.find(item => item.id === 'default');
  state.config = { ...state.config, appId: bot?.appId || '', hasSecret: bot?.hasSecret || false, enabled: bot?.enabled || false, allowedActors: [...(bot?.allowedActors || [])], model: bot?.model ?? state.config.model, effort: bot?.effort ?? state.config.effort };
  state.connection = bot ? { ...bot.connection } : { status: 'stopped' };
  const configured = state.bots!.filter(item => item.appId);
  const connected = configured.filter(item => item.connection.status === 'connected').length;
  const status = connected ? 'connected' : configured.some(item => item.connection.status === 'connecting') ? 'connecting' : configured.some(item => item.connection.status === 'error') ? 'error' : 'stopped';
  state.connectionSummary = { status, connected, total: configured.length, detail: `${connected} / ${configured.length} 个机器人已连接` };
  state.notificationTargets = privateChats.flatMap(target => {
    const owner = state.bots!.find(item => item.id === target.botId && item.appId === target.botAppId && item.engine !== 'hermes' && item.hasSecret && item.allowedActors.includes(target.actorId));
    return owner ? [{ ...target, botName: owner.name }] : [];
  });
}

function saveBot(bot: BotProfile): BotProfile {
  bot = { ...bot, engine: bot.engine ?? 'codex', engineStatus: bot.engine === 'hermes' ? { available: true } : undefined };
  if (bot.engine === 'hermes') {
    bot.model = ''; bot.effort = '';
    if (state.config.desktopNotificationTarget?.botAppId === bot.appId) state.config.desktopNotificationTarget = null;
  }
  const index = state.bots!.findIndex(item => item.id === bot.id);
  if (index < 0) state.bots!.push(bot); else state.bots![index] = bot;
  state.conversations = state.conversations.map(item => item.chatId !== 'local-preview' && (item.botId || 'default') === bot.id ? { ...item, botName: bot.name } : item);
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
  if (body.engine !== undefined) {
    if (body.engine !== 'codex' && body.engine !== 'hermes') throw new Error('不支持的机器人执行端');
    patch.engine = body.engine;
  }
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
  if (state.bots!.some(item => item.id === bot.id) && patch.engine && patch.engine !== (bot.engine ?? 'codex')) throw new Error('机器人创建后不能更换处理对话的 AI，请删除后重新添加。');
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
  const engine = botPatch({ engine: body.engine }).engine;
  if (engine && engine !== (requireBot('default').engine ?? 'codex')) throw new Error('机器人创建后不能更换处理对话的 AI，请删除后重新添加。');
  syncDefaultBot();
  const bot = state.bots!.find(item => item.id === 'default');
  const patch = botPatch({ ...body, name: body.botName, engine: undefined });
  if (!bot && (Object.keys(patch).some(key => key !== 'model' && key !== 'effort') || body.appSecret !== undefined)) throw new Error('这个机器人不存在，请通过添加机器人重新配置。');
  const config = { ...state.config };
  if (patch.model !== undefined) config.model = patch.model;
  if (patch.effort !== undefined) config.effort = patch.effort;
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
      if (match.botId === bot?.id && ((patch.appId !== undefined && patch.appId !== match.botAppId) || (patch.allowedActors !== undefined && !patch.allowedActors.includes(match.actorId)))) throw new Error('通知接收位置已失效，请重新选择');
      config.desktopNotificationTarget = { chatId: match.chatId, actorId: match.actorId, botAppId: match.botAppId };
    }
  }
  if (!bot) { state.config = config; return changed({ config: state.config }); }
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

function conversationFor(id = state.conversations[0]?.chatId || 'local-preview'): Conversation {
  const existing = state.conversations.find(item => item.chatId === id);
  if (existing) return existing;
  if (id !== 'local-preview') throw new Error('这个对话已移除，请选择其他对话。');
  const conversation: Conversation = { chatId: id, actorId: 'local', cwd: state.config.defaultWorkspace, title: '新任务', revision: 0, updatedAt: now, preview: '', busy: false };
  state.conversations.push(conversation);
  return conversation;
}

function historyFor(conversation: Conversation): Message[] {
  if (!conversation.threadId) return [];
  if (!histories.has(conversation.threadId)) histories.set(conversation.threadId, []);
  return histories.get(conversation.threadId)!;
}

function engineForChat(chatId?: string): 'codex' | 'hermes' {
  if (!chatId || chatId === 'local-preview') return 'codex';
  const conversation = conversationFor(chatId);
  return requireBot(conversation.botId || 'default').engine ?? 'codex';
}

function sessionsFor(workspace: string, chatId?: string): Session[] {
  const hermes = engineForChat(chatId) === 'hermes';
  return sessions.filter(item => item.cwd === workspace && item.id.startsWith('hermes:') === hermes
    && (!hermes || sessionChats.get(item.id) === chatId));
}
