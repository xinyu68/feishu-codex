import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, localDay } from './store.js';
import { Bridge, UserError, errorText } from './bridge.js';
import { CodexClient } from './codex.js';
import { HermesClient } from './hermes.js';
import { ManagedHermesRuntime } from './hermes-runtime.js';
import { normalizeHermesDashboardUrl } from './hermes-discovery.js';
import { RuntimeRouter } from './runtime-router.js';
import { GroupConsultError } from './group-consult.js';
import { GROUP_CONSULT_PATH } from './group-consult-request.js';
import { MESSAGE_CONNECTION_PATH, MESSAGE_SEND_PATH, MessageSendError } from './message-request.js';
import { DefaultMessageSender } from './message-sender.js';
import { readRuntimeConfig } from './runtime-config.js';
import { discoverProjects, discoverThreads } from './discovery.js';
import { FeishuClient, FeishuCredentialVerificationError, verifyFeishuCredentials } from './feishu.js';
import { assertWriteAllowed, readDesktopRuntimeStatus } from './write-gate.js';
import { TransportRouter } from './transport-router.js';
import { namespaceMessage, parseRoute } from './routing.js';
import type { BotProfile, BridgeConfig, BridgeEvent, CodexRuntime, ConnectionStatus, FeishuOptions, FeishuTransport, Project, ThreadSummary } from './types.js';

const PRODUCT_VERSION = productVersion();

export async function startServer(options: { port?: number; dataDir?: string; codex?: CodexRuntime; hermes?: CodexRuntime; staticDir?: string; writeGateFile?: string; discovery?: { projects: () => Promise<Project[]>; threads: (cwd: string) => Promise<ThreadSummary[]> }; feishu?: { verifyCredentials?: (appId: string, appSecret: string) => Promise<void>; createTransport?: (options: FeishuOptions) => FeishuTransport } } = {}) {
  const store = new Store(options.dataDir);
  const hermesConnection = readHermesConnection(store.dir, text => store.log('warn', text));
  const safeText = (text: string, ...extraSecrets: string[]) => {
    let safe = text;
    for (const secret of [...store.bots().map(bot => bot.appSecret), ...extraSecrets]) if (secret) safe = safe.split(secret).join('[已隐藏]');
    return safe.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[已隐藏]').slice(0, 1500);
  };
  const port = options.port ?? Number(process.env.FEISHU_CODEX_PORT || 8790);
  let mcpPort = port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效的服务端口');
  const runtime = readRuntimeConfig(store.dir);
  const gateFile = options.writeGateFile ?? process.env.FEISHU_CODEX_WRITE_GATE_FILE;
  const checkWrite = async () => { try { await assertWriteAllowed(gateFile); } catch (error) { throw new UserError(errorText(error), 503); } };
  const codex = options.codex ?? new CodexClient({ websocketUrl: runtime.websocketUrl,
    canWatch: async () => { try { await checkWrite(); return true; } catch { return false; } },
    isConsultationThread: threadId => store.isConsultationThread(threadId),
  });
  const managedHermes = !options.hermes && hermesConnection && !hermesConnection.baseUrl
    ? new ManagedHermesRuntime({ log: (level, text) => store.log(level, text) }) : undefined;
  const runtimes = new RuntimeRouter(codex, options.hermes ?? (hermesConnection ? new HermesClient({
    ...hermesConnection, integrationDataDir: store.dir, bridgePort: () => mcpPort, ...(managedHermes ? { discover: () => managedHermes.ensure() } : {}),
  }) : undefined));
  const releaseLock = acquireLock(store.dir);
  const projects = async () => {
    const discovered = await (options.discovery?.projects ?? discoverProjects)();
    const known = new Map(discovered.map((project) => [canonical(project.path), project]));
    for (const cwd of [store.config.defaultWorkspace, ...Object.values(store.state.conversations).map((item) => item.cwd)]) {
      if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() && !known.has(canonical(cwd))) known.set(canonical(cwd), { path: cwd, name: path.basename(cwd), threadCount: 0, lastActiveAt: '' });
    }
    return [...known.values()];
  };
  const threads = options.discovery?.threads ?? discoverThreads;
  const bridge = new Bridge(store, runtimes, { projects, threads, assertCanWrite: checkWrite });
  void bridge.startNotificationTracking().catch((error) => store.log('warn', `桌面任务通知监听启动失败：${errorText(error)}`));
  const subscribers = new Set<http.ServerResponse>();
  let eventSequence = 0;
  const broadcast = (frame: string) => {
    for (const subscriber of subscribers) {
      if (subscriber.destroyed || subscriber.writableLength > 256 * 1024) { subscribers.delete(subscriber); subscriber.destroy(); }
      else subscriber.write(frame);
    }
  };
  const publish = (event: BridgeEvent) => {
    const safe = { type: event.type, chatId: event.chatId, threadId: event.threadId, ...(event.delta ? { delta: event.delta } : {}) };
    const frame = `id: ${++eventSequence}\nevent: ${event.type}\ndata: ${JSON.stringify(safe)}\n\n`;
    broadcast(frame);
  };
  const unsubscribeBridge = bridge.subscribe(publish);
  const heartbeat = setInterval(() => {
    broadcast(': heartbeat\n\n');
  }, 10_000);
  heartbeat.unref();
  let previousHostStatus = '';
  const hostHeartbeat = gateFile ? setInterval(() => {
    const { updatedAt: _updated, ...status } = readDesktopRuntimeStatus(gateFile);
    const current = JSON.stringify(status);
    if (current !== previousHostStatus) { previousHostStatus = current; publish({ type: 'runtime' }); }
  }, 3000) : undefined;
  hostHeartbeat?.unref();
  const startedAt = new Date().toISOString();
  const csrfToken = crypto.randomBytes(32).toString('hex');
  type BotConnection = { status: ConnectionStatus; detail?: string };
  const connections = new Map<string, BotConnection>();
  const router = new TransportRouter();
  const messageSender = new DefaultMessageSender(store, router);
  const messageToken = crypto.randomBytes(32).toString('hex');
  bridge.transport = router;
  const connectionFor = (botId = 'default'): BotConnection => connections.get(botId) ?? { status: 'stopped' };
  const connectionSummary = () => {
    const bots = store.bots().filter(bot => bot.appId);
    const active = bots.filter(bot => connectionFor(bot.id).status === 'connected').length;
    const status: ConnectionStatus = active ? 'connected' : bots.some(bot => connectionFor(bot.id).status === 'connecting') ? 'connecting'
      : bots.some(bot => connectionFor(bot.id).status === 'error') ? 'error' : 'stopped';
    return { status, connected: active, total: bots.length, detail: `${active} / ${bots.length} 个机器人已连接` };
  };
  let hermesStatus: Awaited<ReturnType<CodexRuntime['status']>> | undefined;
  let hermesStatusAt = 0;
  let hermesStatusPromise: Promise<void> | undefined;
  const checkHermes = async () => {
    if (!store.bots().some(bot => bot.engine === 'hermes') || (hermesStatusAt && Date.now() - hermesStatusAt < 10_000)) return;
    hermesStatusPromise ??= Promise.resolve().then(() => runtimes.forEngine('hermes').status())
      .then(status => { hermesStatus = { ...status, ...(status.error ? { error: safeText(status.error) } : {}) }; })
      .catch(error => { hermesStatus = { available: false, error: safeText(errorText(error)) }; })
      .finally(() => { hermesStatusAt = Date.now(); hermesStatusPromise = undefined; publish({ type: 'runtime' }); });
    await hermesStatusPromise;
  };
  const publicBots = () => store.publicBots().map(bot => ({ ...bot, connection: connectionFor(bot.id), ...(bot.engine === 'hermes' ? { engineStatus: hermesStatus } : {}) }));
  const requireBot = (botId: string): BotProfile => {
    const bot = store.bot(botId);
    if (!bot) throw new UserError('这个机器人不存在，请刷新页面。', 404);
    return bot;
  };
  const assertUniqueApp = (botId: string, appId: string) => {
    if (appId && store.bots().some(bot => bot.id !== botId && bot.appId.toLowerCase() === appId.toLowerCase())) {
      throw new UserError('这个 App ID 已用于另一个机器人，请使用独立的飞书应用。', 409);
    }
  };
  let changingConnection = false;
  let closing = false;
  let codexStatus: Awaited<ReturnType<typeof codex.status>> = { available: false };
  let statusAt = 0;
  let statusPromise: Promise<void> | undefined;
  const checkCodex = async () => {
    if (statusAt && Date.now() - statusAt < 10_000) return;
    statusPromise ??= codex.status().then((result) => {
      const changed = JSON.stringify(codexStatus) !== JSON.stringify(result);
      codexStatus = result; statusAt = Date.now();
      if (changed) publish({ type: 'runtime' });
    })
      .catch((error) => { codexStatus = { available: false, error: errorText(error) }; statusAt = Date.now(); })
      .finally(() => { statusPromise = undefined; });
    await statusPromise;
  };
  const closeTransport = async (botId: string) => {
    const previous = router.get(botId);
    router.delete(botId);
    await previous?.close();
  };
  const startTransport = async (bot: BotProfile) => {
    if (closing) throw new UserError('服务正在关闭。', 503);
    assertUniqueApp(bot.id, bot.appId);
    let settleReady!: (status: ConnectionStatus) => void;
    const ready = new Promise<ConnectionStatus>((resolve) => { settleReady = resolve; });
    let candidate!: FeishuTransport;
    candidate = (options.feishu?.createTransport ?? ((value) => new FeishuClient(value)))({
      appId: bot.appId, appSecret: bot.appSecret,
      attachmentDir: path.join(store.dir, 'attachments', bot.id),
      allowGroup: (chatId) => !closing && router.get(bot.id) === candidate && Boolean(store.bot(bot.id)?.allowedGroups.includes(chatId)),
      allowAttachments: (actorId, chatId, chatType) => {
        const current = store.bot(bot.id);
        return Boolean(!closing && router.get(bot.id) === candidate && current?.allowedActors.includes(actorId) && (chatType !== 'group' || (chatId && current.allowedGroups.includes(chatId))));
      },
      onMessage: async (message) => {
        if (closing || router.get(bot.id) !== candidate) return;
        await bridge.receive(namespaceMessage(bot.id, message));
      },
      onGroupMessage: async (message) => {
        const current = store.bot(bot.id);
        if (closing || router.get(bot.id) !== candidate || !current?.allowedGroups.includes(message.chatId) || !current.allowedActors.includes(message.actorId)) return;
        store.observeGroup(namespaceMessage(bot.id, message));
      },
      onBotIdentity: identity => {
        if (!closing && router.get(bot.id) === candidate) store.rememberBotIdentity(bot.id, identity);
      },
      onStatus: (status, detail) => {
        if (router.get(bot.id) !== candidate) return;
        detail = detail ? safeText(detail, bot.appSecret) : undefined;
        router.setReady(bot.id, status === 'connected');
        connections.set(bot.id, { status, ...(detail ? { detail } : {}) });
        store.log(status === 'error' ? 'error' : 'info', `${bot.name}连接：${status}${detail ? ' · ' + detail : ''}`);
        publish({ type: 'state' });
        if (status === 'connected' || status === 'error') settleReady(status);
        if (status === 'connected' && !changingConnection) queueMicrotask(deliverPending);
      },
      log: (level, text) => store.log(level, safeText(text, bot.appSecret))
    });
    router.set(bot.id, candidate, false);
    connections.set(bot.id, { status: 'connecting', detail: '正在建立飞书长连接' });
    publish({ type: 'state' });
    await candidate.start();
    return { ready };
  };
  const waitForConnected = async (ready: Promise<ConnectionStatus>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([ready, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 15_000); })]);
      if (status !== 'connected') throw new UserError('飞书长连接未建立，请检查网络和应用的长连接配置。', 503);
    } finally { if (timer) clearTimeout(timer); }
  };
  const deliverPending = () => {
    void bridge.deliverPendingNotifications().catch((error) => store.log('warn', `待发送的桌面任务通知检查失败：${errorText(error)}`));
    void bridge.deliverPendingArtifacts().catch((error) => store.log('warn', `待发送的飞书成品检查失败：${errorText(error)}`));
  };
  const setConnection = async (enabled: boolean, botId = 'default', initialStart = false) => {
    if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
    if (!initialStart && bridge.hasActiveWork()) throw new UserError('请先停止正在执行的对话，再调整连接。', 409);
    const bot = requireBot(botId);
    if (enabled && (!bot.appId || !bot.appSecret)) throw new UserError('请先填写飞书 App ID 和 App Secret。');
    assertUniqueApp(botId, bot.appId);
    if (bot.enabled === enabled && ((enabled && connectionFor(botId).status === 'connected') || (!enabled && !router.get(botId)))) return;
    changingConnection = true;
    try {
      await closeTransport(botId);
      connections.set(botId, { status: 'stopped' });
      store.saveBot(botId, { enabled });
      if (enabled) {
        await startTransport(requireBot(botId));
        deliverPending();
      }
    } catch (error) {
      connections.set(botId, { status: 'error', detail: safeText(errorText(error)) });
      await closeTransport(botId).catch(() => {});
      throw error;
    } finally { changingConnection = false; publish({ type: 'state' }); }
  };

  const activateCredentials = async (appId: string, appSecret: string, botId = 'default', patch: Partial<BotProfile> = {}) => {
    if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
    if (bridge.hasActiveWork()) throw new UserError('请等当前对话完成后再更换应用凭据。', 409);
    if (!/^cli_[\da-f]{16}$/i.test(appId) || !appSecret) throw new UserError('请填写有效的飞书 App ID 和 App Secret。');
    assertUniqueApp(botId, appId);
    const existingBot = store.bot(botId);
    if (existingBot) assertBotEngineUnchanged(existingBot, patch);
    changingConnection = true;
    const previous = store.bot(botId);
    if (previous && previous.appId !== appId && (previous.allowedActors.length || previous.allowedGroups.length)) {
      // open_id belongs to an application, so authorizations never carry to a replacement application.
      patch = { ...patch, allowedActors: [], allowedGroups: [] };
    }
    let swapped = false;
    try {
      if (!existingBot && patch.engine === 'hermes') {
        const status = await Promise.resolve().then(() => runtimes.forEngine('hermes').status())
          .catch(error => { throw new UserError(safeText(errorText(error)), 503); });
        if (!status.available || status.authenticated === false) throw new UserError(status.error || 'Hermes 尚未就绪。', 503);
        hermesStatus = { ...status, ...(status.error ? { error: safeText(status.error) } : {}) };
        hermesStatusAt = Date.now();
        patch.model = ''; patch.effort = '';
      }
      try { await (options.feishu?.verifyCredentials ?? verifyFeishuCredentials)(appId, appSecret); }
      catch (error) {
        if (error instanceof FeishuCredentialVerificationError) throw new UserError(safeText(error.message, appSecret), error.invalid ? 400 : 503);
        throw new UserError('暂时无法向飞书验证应用凭据，请检查网络后重试。', 503);
      }
      if (closing) throw new UserError('服务正在关闭，请重新打开后连接。', 503);
      if (bridge.hasActiveWork()) throw new UserError('验证期间有对话开始执行，请等任务完成后重试连接。', 409);
      swapped = true;
      await closeTransport(botId);
      connections.set(botId, { status: 'stopped' });
      store.saveBot(botId, { ...patch, appId, appSecret, enabled: true });
      const { ready } = await startTransport(requireBot(botId));
      await waitForConnected(ready);
      if (previous && previous.appId !== appId) store.resetBotBindings(botId, { preserveCurrentBotIdentity: true });
      deliverPending();
      return { config: store.publicConfig(), connection: connectionFor(botId), bot: publicBots().find(bot => bot.id === botId) };
    } catch (error) {
      if (swapped) {
        await closeTransport(botId).catch(() => {});
        if (previous) store.saveBot(botId, previous); else store.removeBot(botId);
        connections.set(botId, { status: 'stopped' });
        if (previous?.enabled) {
          try { const { ready } = await startTransport(previous); await waitForConnected(ready); deliverPending(); }
          catch { store.log('error', '原飞书连接恢复失败，请手动重试连接。'); }
        }
      }
      throw error;
    } finally { changingConnection = false; publish({ type: 'state' }); }
  };
  const stopUnauthorized = async (botId: string) => {
    const bot = requireBot(botId);
    const conversations = bridge.conversations().filter(item => item.chatId !== 'local-preview' && parseRoute(item.chatId).botId === botId);
    const activeActors = Object.values(store.state.operations)
      .filter(item => parseRoute(item.chatId).botId === botId && !['completed', 'failed'].includes(item.status)).map(item => item.actorId);
    for (const actorId of new Set([...conversations.map(item => item.actorId), ...activeActors].filter(actorId => !bot.allowedActors.includes(actorId)))) {
      await bridge.stopActor(actorId, botId);
    }
    for (const conversation of conversations) {
      if (conversation.busy && !store.isAuthorized(conversation.chatId, conversation.actorId)) await bridge.stop(conversation.chatId);
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (closing) throw new UserError('服务正在关闭，请稍后刷新。', 503);
      const requestHost = request.headers.host ?? '';
      const host = new URL(`http://${requestHost}`);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) throw new UserError('只接受本机访问。', 403);
      const origin = request.headers.origin;
      if (origin && origin !== `http://${requestHost}`) throw new UserError('不接受跨站请求。', 403);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
      const url = new URL(request.url ?? '/', host);
      if (url.pathname === '/health' && request.method === 'GET') return json(response, { status: 'ok', name: 'feishu-codex', version: PRODUCT_VERSION, pid: process.pid });
      if (url.pathname === MESSAGE_CONNECTION_PATH || url.pathname === MESSAGE_SEND_PATH) {
        if (origin || request.headers['sec-fetch-site']) throw new UserError('即时消息接口仅供本机 MCP 调用。', 403);
        if (url.pathname === MESSAGE_CONNECTION_PATH && request.method === 'GET') return json(response, { name: 'feishu-codex-message', token: messageToken });
        if (url.pathname !== MESSAGE_SEND_PATH || request.method !== 'POST') throw new UserError('请求方法不支持。', 405);
        const token = request.headers['x-feishu-mcp-token'];
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(messageToken))) throw new UserError('MCP 连接已失效，请重新连接。', 403);
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new UserError('请使用 JSON 请求。', 415);
        const input = await readBody(request);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        if (response.destroyed || request.aborted) cancel();
        try { return json(response, await messageSender.send(input, controller.signal)); }
        finally { response.off('close', cancel); }
      }
      if (url.pathname === GROUP_CONSULT_PATH) {
        // This narrow MCP endpoint uses a live operation capability, not the UI's CSRF token.
        if (request.method !== 'POST') throw new UserError('请使用 POST 咨询请求。', 405);
        if (origin || request.headers['sec-fetch-site']) throw new UserError('群咨询接口仅供本机 MCP 调用。', 403);
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new UserError('请使用 JSON 请求。', 415);
        const input = await readBody(request);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        if (response.destroyed || request.aborted) cancel();
        try { return json(response, await bridge.consultInGroup(input, controller.signal)); }
        finally { response.off('close', cancel); }
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET') {
          if (request.headers['x-bridge-token'] !== csrfToken) throw new UserError('页面连接已更新，请刷新后重试。', 403);
          if (!request.headers['content-type']?.includes('application/json')) throw new UserError('请使用 JSON 请求。', 415);
        }
        if (request.method === 'GET' && url.pathname === '/api/state') {
          void checkCodex();
          void checkHermes();
          return json(response, {
            csrfToken, service: { name: 'Feishu Codex', version: PRODUCT_VERSION, startedAt, uptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000) },
            config: store.publicConfig(), connection: connectionFor(), connectionSummary: connectionSummary(), bots: publicBots(), codex: { ...codexStatus, mode: runtime.mode },
            runtime: readDesktopRuntimeStatus(gateFile),
            stats: { messagesToday: store.state.dailyMessages[localDay()] ?? 0, totalTurns: store.state.totalTurns },
            conversations: bridge.conversations(), pendingActors: store.state.pendingActors, pendingGroups: store.state.pendingGroups,
            activeWork: bridge.hasActiveWork() || messageSender.hasPending(),
            notificationTargets: store.notificationTargets(),
            pendingRequests: bridge.pendingRequests(), logs: store.state.logs
          });
        }
        if (request.method === 'GET' && url.pathname === '/api/runtime-status') return json(response, readDesktopRuntimeStatus(gateFile));
        if (request.method === 'GET' && url.pathname === '/api/events') {
          if (subscribers.size >= 16) throw new UserError('打开的管理窗口过多，请关闭多余窗口后重试。', 429);
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write(`event: state\ndata: ${JSON.stringify({ type: 'state', reconnect: true })}\n\n`);
          subscribers.add(response);
          response.once('close', () => subscribers.delete(response));
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/projects') return json(response, { projects: await projects() });
        if (request.method === 'GET' && url.pathname === '/api/sessions') {
          const cwd = required(url.searchParams.get('cwd'), '项目目录');
          const chatId = optional(url.searchParams.get('chatId'));
          return json(response, { sessions: chatId ? await bridge.sessions(chatId, cwd) : await threads(cwd) });
        }
        if (request.method === 'GET' && url.pathname === '/api/models') {
          const chatId = optional(url.searchParams.get('chatId'));
          return json(response, { models: chatId && bridge.engineForChat(chatId) === 'hermes' ? [] : await codex.models() });
        }
        if (request.method === 'GET' && url.pathname === '/api/bots') { await checkHermes(); return json(response, { bots: publicBots() }); }
        if (request.method === 'GET' && url.pathname === '/api/history') {
          const chatId = required(url.searchParams.get('chatId'), '对话 ID');
          void bridge.watch(chatId).catch((error) => store.log('warn', errorText(error)));
          return json(response, await bridge.history(chatId));
        }
        const body = await readBody(request);
        if (request.method === 'POST' && url.pathname === '/api/bots') {
          if (store.bots().length >= 20) throw new UserError('最多可配置 20 个机器人。');
          const patch = validateBot(body);
          if (!patch.name || !patch.appId || !patch.appSecret) throw new UserError('请填写机器人名称、App ID 和 App Secret。');
          const botId = `bot-${crypto.randomUUID()}`;
          return json(response, await activateCredentials(patch.appId, patch.appSecret, botId, patch), 201);
        }
        const botRoute = /^\/api\/bots\/([^/]+)(?:\/(credentials|connection))?$/.exec(url.pathname);
        if (botRoute) {
          const botId = decodeURIComponent(botRoute[1]!);
          const current = requireBot(botId);
          if (request.method === 'POST' && botRoute[2] === 'credentials') {
            const patch = validateBot(body);
            const appId = patch.appId ?? current.appId;
            const appSecret = patch.appSecret ?? (appId === current.appId ? current.appSecret : '');
            return json(response, await activateCredentials(appId, appSecret, botId, patch));
          }
          if (request.method === 'POST' && botRoute[2] === 'connection') {
            if (typeof body.enabled !== 'boolean') throw new UserError('缺少连接开关');
            await setConnection(body.enabled, botId);
            return json(response, { connection: connectionFor(botId), bot: publicBots().find(bot => bot.id === botId) });
          }
          if (!botRoute[2] && request.method === 'PATCH') {
            if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
            const patch = validateBot(body);
            assertBotEngineUnchanged(current, patch);
            const changed = (patch.appId !== undefined && patch.appId !== current.appId) || Boolean(patch.appSecret && patch.appSecret !== current.appSecret);
            if (changed) {
              const appId = patch.appId ?? current.appId;
              const appSecret = patch.appSecret ?? (appId === current.appId ? current.appSecret : '');
              return json(response, await activateCredentials(appId, appSecret, botId, patch));
            }
            changingConnection = true;
            try {
              requireBot(botId);
              if ((patch.engine ?? current.engine) === 'hermes') { patch.model = ''; patch.effort = ''; }
              store.saveBot(botId, patch);
              await stopUnauthorized(botId);
            } finally { changingConnection = false; publish({ type: 'state' }); }
            return json(response, { bot: publicBots().find(bot => bot.id === botId) });
          }
          if (!botRoute[2] && request.method === 'DELETE') {
            if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
            changingConnection = true;
            try {
              await bridge.removeBot(botId, () => closeTransport(botId));
              connections.delete(botId);
            } finally { changingConnection = false; publish({ type: 'state' }); }
            return json(response, { ok: true, bots: publicBots() });
          }
        }
        if (request.method === 'POST' && url.pathname === '/api/credentials') {
          requireBot('default');
          if (body.engine !== undefined) assertBotEngineUnchanged(requireBot('default'), validateBot({ engine: body.engine }));
          const credentials = validateConfig(body);
          const appId = credentials.appId ?? store.config.appId;
          const appSecret = credentials.appSecret ?? (appId === store.config.appId ? store.config.appSecret : '');
          return json(response, await activateCredentials(appId, appSecret));
        }
        if (request.method === 'PUT' && url.pathname === '/api/config') {
          if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
          if (body.engine !== undefined) assertBotEngineUnchanged(requireBot('default'), validateBot({ engine: body.engine }));
          const patch = validateConfig(body);
          if (['appId', 'appSecret', 'enabled', 'allowedActors', 'allowedGroups', 'botName', 'roleInstructions', 'privateRoleInstructions', 'includeGroupContext'].some(key => key in patch)) requireBot('default');
          assertUniqueApp('default', patch.appId ?? store.config.appId);
          const credentialsChanged = (patch.appId !== undefined && patch.appId !== store.config.appId) || Boolean(patch.appSecret && patch.appSecret !== store.config.appSecret);
          if (credentialsChanged && bridge.hasActiveWork()) throw new UserError('请等当前对话完成后再更换应用凭据。', 409);
          const appChanged = patch.appId !== undefined && patch.appId !== store.config.appId;
          if (appChanged) {
            if (!patch.appSecret) patch.appSecret = '';
            patch.allowedActors = []; patch.allowedGroups = [];
          }
          if (patch.desktopNotificationTarget) {
            const target = patch.desktopNotificationTarget;
            const matches = (candidate: NonNullable<BridgeConfig['desktopNotificationTarget']>) => candidate.chatId === target.chatId
              && candidate.actorId === target.actorId && candidate.botAppId === target.botAppId;
            if (!store.notificationTargets().some(matches) || !store.notificationTargets({ ...store.config, ...patch }).some(matches)) {
              throw new UserError('默认通知接收位置不可用，请选择已配置机器人下仍获授权的飞书私聊。');
            }
          }
          if (credentialsChanged && store.config.enabled) await setConnection(false);
          store.saveConfig(patch);
          if (appChanged) store.resetBotBindings('default');
          if (patch.allowedActors || patch.allowedGroups) await stopUnauthorized('default');
          store.log('info', '已保存连接设置');
          return json(response, { config: store.publicConfig() });
        }
        if (request.method === 'POST' && url.pathname === '/api/connection') {
          if (typeof body.enabled !== 'boolean') throw new UserError('缺少连接开关');
          await setConnection(body.enabled);
          return json(response, { connection: connectionFor() });
        }
        if (request.method === 'POST' && url.pathname === '/api/actors') {
          const actorId = required(body.actorId, '账号 ID');
          const botId = optional(body.botId) ?? 'default';
          requireBot(botId);
          if (typeof body.allow !== 'boolean' || !/^ou_[\w-]+$/.test(actorId)) throw new UserError('飞书账号 ID 或授权操作无效。');
          store.authorize(actorId, body.allow, botId);
          if (!body.allow) await bridge.stopActor(actorId, botId);
          return json(response, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/groups') {
          const botId = optional(body.botId) ?? 'default';
          requireBot(botId);
          const chatId = required(body.chatId, '群 ID');
          if (typeof body.allow !== 'boolean' || !/^oc_[\w-]+$/.test(chatId)) throw new UserError('飞书群 ID 或授权操作无效。');
          store.authorizeGroup(botId, chatId, body.allow);
          if (!body.allow) await stopUnauthorized(botId);
          return json(response, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/bind') {
          await bridge.bind(required(body.chatId, '对话 ID'), required(body.cwd, '项目目录'), optional(body.threadId), revision(body.revision));
          void bridge.watch(String(body.chatId)).catch((error) => store.log('warn', errorText(error)));
          return json(response, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/new') {
          await bridge.newConversation(required(body.chatId, '对话 ID'), optional(body.cwd), revision(body.revision));
          return json(response, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/stop') {
          await bridge.stop(required(body.chatId, '对话 ID'), revision(body.revision));
          return json(response, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/answer') {
          const decision = body.decision;
          if (decision !== undefined && decision !== 'accept' && decision !== 'decline') throw new UserError('审批操作无效');
          const answers = body.answers === undefined ? undefined : validateAnswers(body.answers);
          await bridge.answer(required(body.id, '请求 ID'), { decision, answers });
          return json(response, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/chat') {
          const chatId = required(body.chatId, '对话 ID');
          const existing = store.state.conversations[chatId];
          const expectedRevision = revision(body.revision);
          if (expectedRevision !== undefined && expectedRevision !== (existing?.revision ?? 0)) throw new UserError('当前项目或任务已经切换，请确认页面后重新发送。', 409);
          if (chatId !== 'local-preview') {
            if (!existing) throw new UserError('这条飞书对话不存在，请刷新页面。', 404);
            if (!store.isAuthorized(chatId, existing.actorId)) throw new UserError('这条飞书对话的账号或群尚未授权。', 403);
          }
          const text = required(body.text, '消息');
          if (text.length > 30_000) throw new UserError('消息太长，请缩短后重试。');
          if (/^\/[a-z]+(?:\s|$)/i.test(text)) throw new UserError('本地试聊请直接发送文字；切换项目、会话、新建和停止请使用页面按钮。');
          if (body.cwd) {
            const cwd = required(body.cwd, '项目目录');
            if (chatId !== 'local-preview') {
              if (canonical(existing!.cwd) !== canonical(cwd)) throw new UserError('当前项目已切换，请刷新页面后重新发送。', 409);
            } else if (!existing || canonical(existing.cwd) !== canonical(cwd)) await bridge.bind(chatId, cwd);
          }
          const messageId = body.messageId === undefined ? crypto.randomUUID() : required(body.messageId, '消息 ID');
          if (!/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) throw new UserError('消息 ID 无效');
          await bridge.submit({ id: `management:${messageId}`, chatId, actorId: existing?.actorId || 'local', text, localOnly: true, expectedRevision });
          return json(response, { accepted: true, messageId }, 202);
        }
        if (request.method === 'POST' && url.pathname === '/api/shutdown') {
          if (bridge.hasActiveWork()) throw new UserError('仍有任务正在处理，请先完成或停止后再退出。', 409);
          json(response, { ok: true });
          setTimeout(() => { void close().finally(() => { if (isMain()) process.exit(0); }); }, 100);
          return;
        }
        throw new UserError('没有这个接口', 404);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new UserError('不支持的请求方法', 405);
      const staticDir = options.staticDir || process.env.FEISHU_CODEX_UI_DIR || defaultStaticDir();
      const asset = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      if (!asset || asset.includes('\\') || asset.split('/').some((part) => part === '..' || part.startsWith('.')) || !/\.(html|js|css|svg|png|ico|woff2)$/.test(asset)) throw new UserError('页面不存在', 404);
      const file = path.resolve(staticDir, asset);
      if (!file.startsWith(path.resolve(staticDir) + path.sep)) throw new UserError('页面不存在', 404);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UserError('页面资源尚未准备好', 404);
      const contentTypes: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8' };
      response.setHeader('Content-Type', contentTypes[path.extname(asset)]!);
      response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(file));
    } catch (error) {
      if (!response.headersSent) json(response, { error: safeText(errorText(error)) }, error instanceof UserError || error instanceof GroupConsultError || error instanceof MessageSendError ? error.status : 500);
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { releaseLock(); throw error; }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  mcpPort = actualPort;
  bridge.setConsultationPort(actualPort);
  store.log('info', `管理页已启动：http://127.0.0.1:${actualPort}`);
  store.log('info', runtime.mode === 'shared' ? 'Codex 使用共享会话服务' : 'Codex 使用每轮独立进程');
  void checkCodex();
  // Warm/recover only when a Hermes bot exists. No gateway or event receiver is started.
  void checkHermes();
  const hermesHeartbeat = setInterval(() => { if (!closing) void checkHermes(); }, 15_000);
  hermesHeartbeat.unref();
  const startup = (async () => {
    for (const bot of store.bots()) {
      if (closing) break;
      if (bot.enabled) await setConnection(true, bot.id, true).catch((error) => store.log('error', `${bot.name}连接失败：${errorText(error)}`));
    }
  })();
  const close = async () => {
    if (closing) return;
    closing = true;
    unsubscribeBridge();
    clearInterval(heartbeat);
    clearInterval(hostHeartbeat);
    clearInterval(hermesHeartbeat);
    for (const subscriber of subscribers) subscriber.end();
    subscribers.clear();
    await startup;
    const closeErrors: unknown[] = [];
    await messageSender.close();
    try { await bridge.close(); } catch (error) { closeErrors.push(error); }
    try { await managedHermes?.close(); } catch (error) { closeErrors.push(error); }
    await router.close().catch(error => store.log('warn', `飞书连接关闭失败：${errorText(error)}`));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Browsers may keep speculative sockets open without sending an HTTP request.
      // All model work is stopped above, so no management connection must outlive shutdown.
      server.closeAllConnections();
    });
    releaseLock();
    if (closeErrors.length) throw new AggregateError(closeErrors, '部分对话服务未能正常退出。');
  };
  return { server, store, bridge, port: actualPort, close };
}

function readHermesConnection(dataDir: string, warn: (text: string) => void): { baseUrl?: string } | undefined {
  const file = path.join(dataDir, 'hermes-runtime.json');
  // Default: own a headless runtime. Explicit loopback URLs remain externally managed.
  if (!fs.existsSync(file)) return {};
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (config.type !== 'desktop' || config.apiKey !== undefined) throw new Error('invalid');
    if (config.baseUrl === undefined) return {};
    if (typeof config.baseUrl !== 'string') throw new Error('invalid');
    return { baseUrl: normalizeHermesDashboardUrl(config.baseUrl) };
  } catch {
    warn('Hermes 本机接口配置无效，Hermes 机器人暂不可用；Codex 机器人不受影响。');
    return;
  }
}

function defaultStaticDir(): string {
  const parent = fileURLToPath(new URL('../', import.meta.url));
  const candidates = [path.join(parent, 'ui'), path.join(parent, 'build', 'ui'), path.join(parent, 'public'), path.join(parent, '..', 'public')];
  return candidates.find((directory) => fs.existsSync(path.join(directory, 'index.html')) && (fs.existsSync(path.join(directory, 'assets')) || fs.existsSync(path.join(directory, 'app.js')))) || candidates[0]!;
}

function productVersion(): string {
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));
      if (manifest.name === 'feishu-codex' && typeof manifest.version === 'string') return manifest.version;
    } catch { /* Source and packaged server modules have different parent paths. */ }
  }
  return 'unknown';
}

function revision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new UserError('任务绑定版本无效');
  return Number(value);
}

function validateConfig(body: Record<string, unknown>): Partial<BridgeConfig> {
  const result: Partial<BridgeConfig> = {};
  for (const name of ['appId', 'appSecret', 'defaultWorkspace', 'model', 'effort'] as const) {
    if (body[name] === undefined) continue;
    if (typeof body[name] !== 'string' || body[name].length > 1500) throw new UserError(`设置 ${name} 无效`);
    const value = body[name].trim();
    if (name === 'appSecret' && !value) continue;
    result[name] = value;
  }
  if (result.appId && !/^cli_[a-zA-Z0-9]+$/.test(result.appId)) throw new UserError('App ID 应为 cli_ 开头的应用标识。');
  if (result.defaultWorkspace !== undefined && (!path.isAbsolute(result.defaultWorkspace) || !fs.existsSync(result.defaultWorkspace) || !fs.statSync(result.defaultWorkspace).isDirectory())) throw new UserError('请选择存在的本机项目目录。');
  if (body.progress !== undefined) {
    if (typeof body.progress !== 'boolean') throw new UserError('进度设置无效');
    result.progress = body.progress;
  }
  if (body.autoNotifyDesktop !== undefined) {
    if (typeof body.autoNotifyDesktop !== 'boolean') throw new UserError('桌面任务通知设置无效');
    result.autoNotifyDesktop = body.autoNotifyDesktop;
  }
  if (body.desktopNotificationMode !== undefined) {
    if (body.desktopNotificationMode !== 'all' && body.desktopNotificationMode !== 'long') throw new UserError('桌面通知范围无效');
    result.desktopNotificationMode = body.desktopNotificationMode;
  }
  if (body.desktopNotificationMinMinutes !== undefined) {
    if (typeof body.desktopNotificationMinMinutes !== 'number' || !Number.isInteger(body.desktopNotificationMinMinutes)
      || body.desktopNotificationMinMinutes < 1 || body.desktopNotificationMinMinutes > 1440) throw new UserError('通知时长应为 1–1440 的整数分钟');
    result.desktopNotificationMinMinutes = body.desktopNotificationMinMinutes;
  }
  if (body.allowedActors !== undefined) {
    if (!Array.isArray(body.allowedActors) || body.allowedActors.length > 100 || body.allowedActors.some((id) => typeof id !== 'string' || !/^ou_[\w-]+$/.test(id))) throw new UserError('授权名单应为飞书 open_id 列表。');
    result.allowedActors = [...new Set(body.allowedActors as string[])];
  }
  if (body.allowedGroups !== undefined) result.allowedGroups = validateIdList(body.allowedGroups, /^oc_[\w-]+$/, '授权群名单应为飞书 chat_id 列表。');
  if (body.botName !== undefined) result.botName = validateString(body.botName, '机器人名称', 80, true);
  if (body.roleInstructions !== undefined) result.roleInstructions = validateString(body.roleInstructions, '群聊角色说明', 12_000);
  if (body.privateRoleInstructions !== undefined) result.privateRoleInstructions = validateString(body.privateRoleInstructions, '私聊角色说明', 12_000);
  if (body.includeGroupContext !== undefined) result.includeGroupContext = validateGroupContextSetting(body.includeGroupContext);
  if (body.desktopNotificationTarget !== undefined) {
    const value = body.desktopNotificationTarget;
    if (value === null) result.desktopNotificationTarget = null;
    else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('默认通知接收位置格式无效');
      const target = value as Record<string, unknown>;
      if (Object.keys(target).length !== 3 || typeof target.chatId !== 'string' || target.chatId.length > 500
        || typeof target.actorId !== 'string' || !/^ou_[\w-]{1,180}$/.test(target.actorId)
        || typeof target.botAppId !== 'string' || !/^cli_[a-zA-Z0-9]{1,180}$/.test(target.botAppId)) throw new UserError('默认通知接收位置格式无效');
      let route: ReturnType<typeof parseRoute>;
      try { route = parseRoute(target.chatId); } catch { throw new UserError('默认通知接收位置格式无效'); }
      if (!/^oc_[\w-]{1,180}$/.test(route.id)) throw new UserError('默认通知接收位置必须是飞书私聊');
      result.desktopNotificationTarget = { chatId: target.chatId, actorId: target.actorId, botAppId: target.botAppId };
    }
  }
  return result;
}
function validateString(value: unknown, label: string, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) throw new UserError(`${label}无效`);
  return value.trim();
}
function validateIdList(value: unknown, pattern: RegExp, error: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !pattern.test(id))) throw new UserError(error);
  return [...new Set(value as string[])];
}
function assertBotEngineUnchanged(bot: BotProfile, patch: Partial<BotProfile>): void {
  if (patch.engine !== undefined && patch.engine !== (bot.engine ?? 'codex')) {
    throw new UserError('机器人创建后不能更换处理对话的 AI，请删除后重新添加。', 409);
  }
}

function validateBot(body: Record<string, unknown>): Partial<BotProfile> {
  const patch: Partial<BotProfile> = {};
  if (body.engine !== undefined) {
    if (body.engine !== 'codex' && body.engine !== 'hermes') throw new UserError('不支持的机器人执行端');
    patch.engine = body.engine;
  }
  for (const name of ['name', 'appId', 'appSecret', 'roleInstructions', 'privateRoleInstructions', 'model', 'effort'] as const) {
    if (body[name] === undefined) continue;
    const max = name === 'roleInstructions' || name === 'privateRoleInstructions' ? 12_000 : name === 'name' ? 80 : 1500;
    const label = name === 'privateRoleInstructions' ? '私聊角色说明' : name === 'roleInstructions' ? '群聊角色说明' : name;
    const value = validateString(body[name], label, max, name === 'name');
    if (name === 'appSecret' && !value) continue;
    patch[name] = value;
  }
  if (patch.appId !== undefined && !/^cli_[\da-f]{16}$/i.test(patch.appId)) throw new UserError('请填写有效的飞书 App ID。');
  if (body.allowedActors !== undefined) patch.allowedActors = validateIdList(body.allowedActors, /^ou_[\w-]+$/, '授权名单应为飞书 open_id 列表。');
  if (body.allowedGroups !== undefined) patch.allowedGroups = validateIdList(body.allowedGroups, /^oc_[\w-]+$/, '授权群名单应为飞书 chat_id 列表。');
  if (body.includeGroupContext !== undefined) patch.includeGroupContext = validateGroupContextSetting(body.includeGroupContext);
  return patch;
}
function validateGroupContextSetting(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new UserError('补充群聊背景设置无效');
  return value;
}
function validateAnswers(value: unknown): Record<string, { answers: string[] }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('回答格式无效');
  const entries = Object.entries(value);
  if (entries.length > 30) throw new UserError('问题数量超出限制');
  for (const [, item] of entries) if (!item || !Array.isArray(item.answers) || item.answers.some((answer: unknown) => typeof answer !== 'string' || answer.length > 5000)) throw new UserError('回答格式无效');
  return value as Record<string, { answers: string[] }>;
}
function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 50_000) throw new UserError(`缺少或无效的${label}`);
  return value.trim();
}
function optional(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function canonical(value: string): string { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function json(response: http.ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new UserError('请求内容过大', 413);
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new UserError('请求不是有效的 JSON'); }
}
function acquireLock(dir: string): () => void {
  const file = path.join(dir, 'service.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch {} }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (checkError) { alive = (checkError as NodeJS.ErrnoException).code === 'EPERM'; } }
      if (alive) throw new Error(`服务已运行（PID ${pid}）。请使用现有管理页。`);
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得本地服务锁');
}

function isMain(): boolean { return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)); }
if (isMain()) {
  startServer().then((app) => {
    const stop = () => { void app.close().finally(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((error) => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
}
