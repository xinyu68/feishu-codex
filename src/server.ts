import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, localDay } from './store.js';
import { Bridge, UserError, errorText } from './bridge.js';
import { CodexClient } from './codex.js';
import { readRuntimeConfig } from './runtime-config.js';
import { discoverProjects, discoverThreads } from './discovery.js';
import { FeishuClient, FeishuCredentialVerificationError, verifyFeishuCredentials } from './feishu.js';
import { assertWriteAllowed, readDesktopRuntimeStatus } from './write-gate.js';
import type { BridgeConfig, BridgeEvent, CodexRuntime, ConnectionStatus, FeishuOptions, FeishuTransport, Project, ThreadSummary } from './types.js';

export async function startServer(options: { port?: number; dataDir?: string; codex?: CodexRuntime; staticDir?: string; writeGateFile?: string; discovery?: { projects: () => Promise<Project[]>; threads: (cwd: string) => Promise<ThreadSummary[]> }; feishu?: { verifyCredentials?: (appId: string, appSecret: string) => Promise<void>; createTransport?: (options: FeishuOptions) => FeishuTransport } } = {}) {
  const store = new Store(options.dataDir);
  const port = options.port ?? Number(process.env.FEISHU_CODEX_PORT || 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效的服务端口');
  const runtime = readRuntimeConfig(store.dir);
  const gateFile = options.writeGateFile ?? process.env.FEISHU_CODEX_WRITE_GATE_FILE;
  const checkWrite = async () => { try { await assertWriteAllowed(gateFile); } catch (error) { throw new UserError(errorText(error), 503); } };
  const codex = options.codex ?? new CodexClient({ websocketUrl: runtime.websocketUrl,
    canWatch: async () => { try { await checkWrite(); return true; } catch { return false; } },
  });
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
  const bridge = new Bridge(store, codex, { projects, threads, assertCanWrite: checkWrite });
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
  let connection: { status: ConnectionStatus; detail?: string } = { status: 'stopped' };
  let transport: FeishuTransport | undefined;
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
  const closeTransport = async () => {
    const previous = transport;
    transport = undefined;
    bridge.transport = undefined;
    await previous?.close();
  };
  const startTransport = async (credentials: Pick<BridgeConfig, 'appId' | 'appSecret'>) => {
    let settleReady!: (status: ConnectionStatus) => void;
    const ready = new Promise<ConnectionStatus>((resolve) => { settleReady = resolve; });
    let candidate!: FeishuTransport;
    candidate = (options.feishu?.createTransport ?? ((value) => new FeishuClient(value)))({
      appId: credentials.appId, appSecret: credentials.appSecret,
      attachmentDir: path.join(store.dir, 'attachments'),
      allowAttachments: (actorId) => store.config.allowedActors.includes(actorId),
      onMessage: (message) => bridge.receive(message),
      onStatus: (status, detail) => {
        if (transport !== candidate) return;
        connection = { status, ...(detail ? { detail } : {}) };
        store.log(status === 'error' ? 'error' : 'info', `飞书连接：${status}${detail ? ' · ' + detail : ''}`);
        publish({ type: 'state' });
        if (status === 'connected' || status === 'error') settleReady(status);
      },
      log: (level, text) => store.log(level, text)
    });
    transport = candidate;
    bridge.transport = candidate;
    connection = { status: 'connecting', detail: '正在建立飞书长连接' };
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
  const setConnection = async (enabled: boolean) => {
    if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
    if (bridge.hasActiveWork()) throw new UserError('请先停止正在执行的对话，再调整连接。', 409);
    if (enabled && (!store.config.appId || !store.config.appSecret)) throw new UserError('请先填写飞书 App ID 和 App Secret。');
    changingConnection = true;
    try {
      await closeTransport();
      connection = { status: 'stopped' };
      store.saveConfig({ enabled });
      if (enabled) {
        await startTransport(store.config);
        deliverPending();
      }
    } catch (error) {
      connection = { status: 'error', detail: errorText(error) };
      await closeTransport().catch(() => {});
      throw error;
    } finally { changingConnection = false; publish({ type: 'state' }); }
  };

  const activateCredentials = async (appId: string, appSecret: string) => {
    if (changingConnection) throw new UserError('连接状态正在更新，请稍后重试。', 409);
    if (bridge.hasActiveWork()) throw new UserError('请等当前对话完成后再更换应用凭据。', 409);
    if (!/^cli_[\da-f]{16}$/i.test(appId) || !appSecret) throw new UserError('请填写有效的飞书 App ID 和 App Secret。');
    changingConnection = true;
    const previous = { appId: store.config.appId, appSecret: store.config.appSecret, enabled: store.config.enabled };
    let swapped = false;
    try {
      try { await (options.feishu?.verifyCredentials ?? verifyFeishuCredentials)(appId, appSecret); }
      catch (error) {
        if (error instanceof FeishuCredentialVerificationError) throw new UserError(error.message, error.invalid ? 400 : 503);
        throw new UserError('暂时无法向飞书验证应用凭据，请检查网络后重试。', 503);
      }
      swapped = true;
      await closeTransport();
      connection = { status: 'stopped' };
      store.saveConfig({ appId, appSecret, enabled: true });
      const { ready } = await startTransport(store.config);
      await waitForConnected(ready);
      deliverPending();
      return { config: store.publicConfig(), connection };
    } catch (error) {
      if (swapped) {
        await closeTransport().catch(() => {});
        store.saveConfig(previous);
        connection = { status: 'stopped' };
        if (previous.enabled) {
          try { const { ready } = await startTransport(previous); await waitForConnected(ready); deliverPending(); }
          catch { store.log('error', '原飞书连接恢复失败，请手动重试连接。'); }
        }
      }
      throw error;
    } finally { changingConnection = false; publish({ type: 'state' }); }
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
      if (url.pathname === '/health' && request.method === 'GET') return json(response, { status: 'ok', name: 'feishu-codex', version: '0.2.4', pid: process.pid });
      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET') {
          if (request.headers['x-bridge-token'] !== csrfToken) throw new UserError('页面连接已更新，请刷新后重试。', 403);
          if (!request.headers['content-type']?.includes('application/json')) throw new UserError('请使用 JSON 请求。', 415);
        }
        if (request.method === 'GET' && url.pathname === '/api/state') {
          void checkCodex();
          return json(response, {
            csrfToken, service: { name: 'Feishu Codex', version: '0.2.4', startedAt, uptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000) },
            config: store.publicConfig(), connection, codex: { ...codexStatus, mode: runtime.mode },
            runtime: readDesktopRuntimeStatus(gateFile),
            stats: { messagesToday: store.state.dailyMessages[localDay()] ?? 0, totalTurns: store.state.totalTurns },
            conversations: bridge.conversations(), pendingActors: store.state.pendingActors,
            activeWork: bridge.hasActiveWork(),
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
        if (request.method === 'GET' && url.pathname === '/api/sessions') return json(response, { sessions: await threads(required(url.searchParams.get('cwd'), '项目目录')) });
        if (request.method === 'GET' && url.pathname === '/api/models') return json(response, { models: await codex.models() });
        if (request.method === 'GET' && url.pathname === '/api/history') {
          const chatId = required(url.searchParams.get('chatId'), '对话 ID');
          void bridge.watch(chatId).catch((error) => store.log('warn', errorText(error)));
          return json(response, await bridge.history(chatId));
        }
        const body = await readBody(request);
        if (request.method === 'POST' && url.pathname === '/api/credentials') {
          const credentials = validateConfig(body);
          if (!credentials.appId || !credentials.appSecret) throw new UserError('请填写 App ID 和 App Secret。');
          return json(response, await activateCredentials(credentials.appId, credentials.appSecret));
        }
        if (request.method === 'PUT' && url.pathname === '/api/config') {
          const patch = validateConfig(body);
          const credentialsChanged = (patch.appId !== undefined && patch.appId !== store.config.appId) || Boolean(patch.appSecret && patch.appSecret !== store.config.appSecret);
          if (credentialsChanged && bridge.hasActiveWork()) throw new UserError('请等当前对话完成后再更换应用凭据。', 409);
          if (credentialsChanged && store.config.enabled) await setConnection(false);
          store.saveConfig(patch);
          if (patch.allowedActors) {
            for (const actorId of new Set(bridge.conversations().filter(item => item.chatId !== 'local-preview' && !patch.allowedActors!.includes(item.actorId)).map(item => item.actorId))) await bridge.stopActor(actorId);
          }
          store.log('info', '已保存连接设置');
          return json(response, { config: store.publicConfig() });
        }
        if (request.method === 'POST' && url.pathname === '/api/connection') {
          if (typeof body.enabled !== 'boolean') throw new UserError('缺少连接开关');
          await setConnection(body.enabled);
          return json(response, { connection });
        }
        if (request.method === 'POST' && url.pathname === '/api/actors') {
          const actorId = required(body.actorId, '账号 ID');
          if (typeof body.allow !== 'boolean' || !/^ou_[\w-]+$/.test(actorId)) throw new UserError('飞书账号 ID 或授权操作无效。');
          store.authorize(actorId, body.allow);
          if (!body.allow) await bridge.stopActor(actorId);
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
            if (!store.config.allowedActors.includes(existing.actorId)) throw new UserError('这条飞书对话的账号尚未授权。', 403);
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
      if (!response.headersSent) json(response, { error: errorText(error) }, error instanceof UserError ? error.status : 500);
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
  store.log('info', `管理页已启动：http://127.0.0.1:${actualPort}`);
  store.log('info', runtime.mode === 'shared' ? 'Codex 使用共享会话服务' : 'Codex 使用每轮独立进程');
  void checkCodex();
  if (store.config.enabled) void setConnection(true).catch((error) => store.log('error', `连接失败：${errorText(error)}`));
  const close = async () => {
    if (closing) return;
    closing = true;
    unsubscribeBridge();
    clearInterval(heartbeat);
    clearInterval(hostHeartbeat);
    for (const subscriber of subscribers) subscriber.end();
    subscribers.clear();
    await bridge.close();
    await transport?.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Browsers may keep speculative sockets open without sending an HTTP request.
      // All model work is stopped above, so no management connection must outlive shutdown.
      server.closeAllConnections();
    });
    releaseLock();
  };
  return { server, store, bridge, port: actualPort, close };
}

function defaultStaticDir(): string {
  const parent = fileURLToPath(new URL('../', import.meta.url));
  const candidates = [path.join(parent, 'ui'), path.join(parent, 'build', 'ui'), path.join(parent, 'public'), path.join(parent, '..', 'public')];
  return candidates.find((directory) => fs.existsSync(path.join(directory, 'index.html')) && (fs.existsSync(path.join(directory, 'assets')) || fs.existsSync(path.join(directory, 'app.js')))) || candidates[0]!;
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
  return result;
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
