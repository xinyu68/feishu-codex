import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { atomicJson, captureProcessTree, closeWindowVerified, inspectWindows, readJson, runPowerShell, stopVerified } from './windows.mjs';
import { canonicalEnvironment, canRetireReusedIdentity, desktopMode, matchesEntry, RestartBudget, samePath, sameProcess, writePermission } from './lifecycle.mjs';
import { checkIdleServices, closeSharedDesktop, sharedDesktopToClose, waitForChildExit } from './shutdown.mjs';
import { independentDesktop, stopIndependentDesktop } from './switch-desktop.mjs';
import { defaultCodexHome, installBundledSkill, managedSkillOwner } from './bundled-skill.mjs';
import { waitForLaunchAccount } from './launch-account.mjs';

export async function runtimeProbe(url, { idle = false, account = false, timeout = 5_000 } = {}) {
  const socket = new WebSocket(url, { handshakeTimeout: timeout, maxPayload: 2 * 1024 * 1024 });
  const pending = new Map();
  let seq = 0;
  let timer;
  let rejectOpen;
  let stage = 'WebSocket';
  const fail = error => { rejectOpen?.(error); for (const request of pending.values()) request.reject(error); pending.clear(); };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    stage = method;
    const id = ++seq; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) { pending.delete(id); reject(error); } });
  });
  socket.on('error', fail);
  socket.on('close', () => fail(Object.assign(new Error('Codex 连接已断开。'), { code: 'RUNTIME_CONNECTION_CLOSED', stage })));
  socket.on('message', data => {
    try {
      const value = JSON.parse(data.toString()); const request = pending.get(value.id);
      if (!request || value.method) return;
      pending.delete(value.id);
      if (value.error || !Object.hasOwn(value, 'result')) request.reject(new Error('Codex 暂时无法确认连接状态。'));
      else request.resolve(value.result);
    } catch { fail(new Error('Codex 连接状态异常。')); }
  });
  try {
    return await Promise.race([(async () => {
      await new Promise((resolve, reject) => { rejectOpen = reject; socket.once('open', resolve); }); rejectOpen = undefined;
      await rpc('initialize', { clientInfo: { name: 'feishu_codex_desktop_host', version: '0.2.10' }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      if (account) {
        const result = await rpc('account/read', { refreshToken: false });
        const authenticated = Boolean(result?.account) || result?.requiresOpenaiAuth === false;
        if (!idle) return { ready: true, authenticated, accountType: result?.account?.type || null };
      } else if (!idle) return { ready: true };
      const ids = new Set(), seen = new Set(); let cursor;
      do {
        const page = await rpc('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data) || page.data.some(id => typeof id !== 'string') || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('无法确认运行中的任务。');
        page.data.forEach(id => ids.add(id)); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('任务列表分页异常。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      let active = 0;
      for (const threadId of ids) {
        const result = await rpc('thread/read', { threadId, includeTurns: false });
        const status = result?.thread?.status?.type;
        if (result?.thread?.id !== threadId || !['active', 'idle', 'notLoaded'].includes(status)) throw new Error('无法确认任务是否已结束。');
        if (status === 'active') { active++; continue; }
        if (result.thread.ephemeral === true) {
          // Ephemeral threads reject both history APIs. Recheck their live
          // status instead of treating the lack of persisted turns as failure.
          const current = await rpc('thread/read', { threadId, includeTurns: false });
          const currentStatus = current?.thread?.status?.type;
          if (current?.thread?.id !== threadId || current.thread.ephemeral !== true || !['active', 'idle', 'notLoaded'].includes(currentStatus)) throw new Error('无法确认临时任务是否已结束。');
          if (currentStatus === 'active') active++;
          continue;
        }
        // Native turn/start may return before the summary status becomes active.
        // Inspect the latest accepted turn as well as the summary before shutdown.
        let latest;
        if (result.thread.historyMode === 'paginated') {
          const page = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
          if (!Array.isArray(page?.data)) throw new Error('无法确认最近任务是否结束。');
          latest = page.data[0];
        } else {
          const full = await rpc('thread/read', { threadId, includeTurns: true });
          if (full?.thread?.id !== threadId || !Array.isArray(full.thread.turns)) throw new Error('无法读取最近任务状态。');
          latest = full.thread.turns.at(-1);
        }
        if (latest && !['inProgress', 'completed', 'failed', 'interrupted'].includes(latest.status)) throw new Error('最近任务状态无法确认。');
        if (latest?.status === 'inProgress') {
          // Persisted history can retain an in-progress turn after the live
          // thread has become idle. Keep a grace period for newly accepted
          // turns, whose summary may briefly lag behind the turn record.
          const startedAt = latest.startedAt;
          if (!Number.isSafeInteger(startedAt) || startedAt > Date.now() / 1000 - 60) {
            active++;
            continue;
          }
          const refreshed = await rpc('thread/read', { threadId, includeTurns: false });
          const refreshedStatus = refreshed?.thread?.status?.type;
          if (refreshed?.thread?.id !== threadId || !['active', 'idle', 'notLoaded'].includes(refreshedStatus)) throw new Error('无法再次确认任务是否已经结束。');
          if (refreshedStatus === 'active') active++;
        }
      }
      return { ready: true, active };
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(
      stage === 'account/read' ? 'Codex 登录状态读取超时，请稍后重试。' : `Codex 未及时响应（${stage}）。`
    ), { code: 'RUNTIME_PROBE_TIMEOUT', stage })), timeout); })]);
  } finally { clearTimeout(timer); fail(new Error('状态查询结束。')); socket.terminate(); }
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root', '--data-dir', '--port', '--bridge-port', '--ws-url'].includes(args[i]) || !args[i + 1]) throw new Error('后台启动参数无效。');
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}

async function pipeReady(pipe) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipe);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export async function startHost(options = {}) {
  if (process.platform !== 'win32') throw new Error('当前版本仅支持 Windows。');
  const root = path.resolve(options.root || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const dataDir = path.resolve(options.dataDir || process.env.FEISHU_CODEX_DATA_DIR || path.join(process.env.USERPROFILE, '.feishu-codex'));
  const directory = path.join(dataDir, 'desktop');
  const codexHome = path.resolve(options.codexHome || defaultCodexHome());
  const probe = options.runtimeProbe || runtimeProbe;
  const port = Number(options.port || 18792), bridgePort = Number(options.bridgePort || 8790);
  const savedRuntime = await readJson(path.join(dataDir, 'runtime.json')) || {};
  const accessible = async value => typeof value === 'string' && value && Boolean(await fs.stat(value).catch(() => null));
  const customCodex = savedRuntime.codexPath && !/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]/i.test(savedRuntime.codexPath) && await accessible(savedRuntime.codexPath) ? savedRuntime.codexPath : null;
  const customMcpNode = savedRuntime.mcpNodePath && !/[\\/]OpenAI[\\/]Codex[\\/]runtimes[\\/]cua_node[\\/]/i.test(savedRuntime.mcpNodePath) && await accessible(savedRuntime.mcpNodePath) ? savedRuntime.mcpNodePath : null;
  const wsUrl = options.wsUrl || savedRuntime.wsUrl || 'ws://127.0.0.1:18791';
  const ws = new URL(wsUrl);
  if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || ws.username || ws.password || ws.pathname !== '/' || ws.search || ws.hash || Number(ws.port) < 1024) throw new Error('Codex 连接地址必须是本机地址。');
  if (![port, bridgePort].every(value => Number.isInteger(value) && value >= 1024 && value < 65536) || new Set([port, bridgePort, Number(ws.port)]).size !== 3) throw new Error('后台端口配置无效。');
  const deployment = await readJson(path.join(directory, 'deployment.json'));
  if (!deployment || deployment.state !== 'active' || !samePath(deployment.productRoot, root)) throw new Error('尚未完成桌面版设置。请打开 Feishu Codex，按提示继续。');
  await fs.mkdir(directory, { recursive: true });
  const log = async text => { await fs.appendFile(path.join(directory, 'host.log'), `${new Date().toISOString()} ${text}\n`).catch(() => {}); };
  const ports = [port, bridgePort, Number(ws.port)];
  const inspector = options.inspector || inspectWindows;
  const trackedPids = new Set([process.pid]);
  for (const name of ['host', 'relay', 'runtime', 'bridge']) {
    const saved = await readJson(path.join(directory, `${name}-identity.json`));
    if (Number.isInteger(saved?.pid)) trackedPids.add(saved.pid);
  }
  let snapshot = await inspector(root, ports, [...trackedPids]);
  let inspectedAt = Date.now(), inspection;
  async function inspectFresh(maxAge = 0) {
    if (maxAge > 0 && Date.now() - inspectedAt <= maxAge) return snapshot;
    if (!inspection) inspection = inspector(root, ports, [...trackedPids]).then(value => { snapshot = value; inspectedAt = Date.now(); return value; }).finally(() => { inspection = null; });
    return inspection;
  }
  const ownIdentity = snapshot.processes.find(item => item.pid === process.pid);
  if (!ownIdentity?.startedAt || !ownIdentity?.exe) throw new Error('无法确认后台进程身份。');
  const oldHost = await readJson(path.join(directory, 'host-identity.json'));
  if (oldHost && sameProcess(oldHost, snapshot.processes.find(item => item.pid === oldHost.pid))) throw new Error('桌面后台已经运行。');
  if (snapshot.connections.some(item => item.state === 'Listen' && item.localPort === port)) throw new Error('桌面后台端口被其他程序占用。');
  try {
    const skill = await installBundledSkill({ root, codexHome });
    if (skill.status !== 'unchanged') await log(`内置 Skill：${skill.status} · ${skill.path}${['conflict', 'modified'].includes(skill.status) ? '（保留现有文件）' : ''}`);
    if (['installed', 'updated', 'unchanged'].includes(skill.status)) {
      await atomicJson(path.join(directory, 'managed-skill-home.json'), { schema: 1, owner: managedSkillOwner, codexHome });
    }
  } catch (error) { await log(`内置 Skill 暂未安装：${error.code || error.message}；共享服务继续运行。`); }
  const token = randomBytes(32).toString('hex');
  const stablePipe = savedRuntime.desktopToolsPipe || '\\\\.\\pipe\\feishu-codex-desktop-tools';
  const components = Object.fromEntries(['relay', 'runtime', 'bridge'].map(name => [name, { name, state: 'stopped', budget: new RestartBudget(), identity: null, child: null, error: '', stableAt: 0 }]));
  let stopping = false, busy = null, launchedDesktop = await readJson(path.join(directory, 'desktop-identity.json'));
  let desktop = desktopMode(snapshot, Number(ws.port), launchedDesktop);
  let publicState;

  let lastPersistenceErrorAt = 0;
  async function persistState(value) {
    try { await atomicJson(path.join(directory, 'host-state.json'), value); }
    catch (error) {
      // The file is a heartbeat for readers, not the live permission decision.
      // Readers still fail closed if it remains stale. Never crash the host or
      // stop healthy components because a Windows reader briefly locks it.
      if (Date.now() - lastPersistenceErrorAt > 30_000) {
        lastPersistenceErrorAt = Date.now();
        await log(`后台状态文件暂时无法更新（${error.code || 'WRITE_FAILED'}），将在下轮重试。`);
      }
    }
  }

  async function publish({ persist = true } = {}) {
    const plain = item => ({ state: item.state, pid: item.identity?.pid || null, error: item.error || null, failures: item.budget.failures.length, nextRetryAt: item.budget.nextAt || null });
    const gate = writePermission({ runtime: components.runtime, bridge: components.bridge, desktop, stopping });
    publicState = { version: 1, appVersion: '0.2.10', pid: process.pid, state: stopping ? 'stopping' : gate.canWrite ? 'ready' : 'paused', ...gate,
      runtime: plain(components.runtime), bridge: plain(components.bridge), relay: plain(components.relay), desktop,
      bridgeUrl: `http://127.0.0.1:${bridgePort}`, updatedAt: new Date().toISOString() };
    if (persist) await persistState(publicState);
    return publicState;
  }

  function definition(name) {
    if (name === 'runtime') {
      const exe = customCodex || snapshot.nativeCodexPath;
      if (!exe) throw new Error('未找到已安装的 Codex 后台，请先安装并打开官方 Codex 一次。');
      const notifyServer = path.join(root, 'build', 'server', 'notify-mcp.js');
      const notifyCommand = customMcpNode || process.execPath;
      // Keep every override after the subcommand. Mixing root and app-server
      // -c options makes Codex discard the root overrides, including this MCP.
      return { exe, args: ['app-server', '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'features.code_mode_host=true',
        '-c', `mcp_servers.feishu_completion.command=${JSON.stringify(notifyCommand)}`,
        '-c', `mcp_servers.feishu_completion.args=${JSON.stringify([notifyServer])}`,
        '--listen', wsUrl, '--analytics-default-enabled', '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'], port: Number(ws.port), entry: null };
    }
    const entry = path.join(root, 'build', 'server', name === 'bridge' ? 'server.js' : 'desktop-tools-relay.js');
    return { exe: process.execPath, args: [entry, ...(name === 'relay' ? ['--pipe', stablePipe] : [])], entry, port: name === 'bridge' ? bridgePort : 0 };
  }

  async function ensure(name) {
    const item = components[name];
    const spec = definition(name);
    if (!item.identity) item.identity = await readJson(path.join(directory, `${name}-identity.json`));
    if (!item.identity && item.child) {
      if (item.child.exitCode !== null || item.child.signalCode !== null) {
        item.child = null; item.budget.failed(); item.state = 'backoff';
      } else {
        const candidate = snapshot.processes.find(process => process.pid === item.child.pid);
        if (candidate && candidate.parentPid === process.pid && samePath(candidate.exe, spec.exe) && (!spec.entry || matchesEntry(candidate, spec.entry))) {
          item.identity = { pid: candidate.pid, exe: candidate.exe, startedAt: candidate.startedAt };
          await atomicJson(path.join(directory, `${name}-identity.json`), item.identity);
        } else {
          item.state = 'unhealthy'; item.error = '进程已启动，正在等待 Windows 确认身份；不会重复启动或强制停止。'; return;
        }
      }
    }
    let live = item.identity && snapshot.processes.find(candidate => candidate.pid === item.identity.pid);
    const listeners = spec.port ? snapshot.connections.filter(connection => connection.state === 'Listen' && connection.localPort === spec.port) : [];
    if (canRetireReusedIdentity(item.identity, live, spec.entry, listeners, name === 'runtime' ? wsUrl : undefined)) {
      if (name === 'bridge') {
        const lock = path.join(dataDir, 'service.lock');
        const value = (await fs.readFile(lock, 'utf8').catch(() => '')).trim();
        if (value === String(item.identity.pid)) await fs.unlink(lock);
      }
      await fs.unlink(path.join(directory, `${name}-identity.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await log(`${name} 原进程已退出，编号被其他程序复用；仅清除旧记录，未停止其他进程。`);
      item.identity = null; item.child = null; live = null; item.budget.failed(); item.state = 'backoff';
    }
    if (live && (!sameProcess(item.identity, live) || (spec.entry && (!samePath(live.exe, spec.exe) || !matchesEntry(live, spec.entry))))) {
      item.state = 'blocked'; item.error = '服务身份已变化。请先查看日志，不会停止或接管其他程序。'; return;
    }
    if (listeners.some(connection => !live || connection.pid !== live.pid || connection.localAddress !== '127.0.0.1')) {
      item.state = 'blocked'; item.error = `端口 ${spec.port} 被其他服务占用，未启动重复服务。`; return;
    }
    if (!live) {
      if (item.identity && item.state !== 'backoff' && item.state !== 'blocked') { item.budget.failed(); item.identity = null; await fs.unlink(path.join(directory, `${name}-identity.json`)).catch(() => {}); }
      if (item.budget.blocked) { item.state = 'blocked'; item.error = '5 分钟内连续退出 5 次，已停止重试。修复后点击“重试连接”。'; return; }
      if (!item.budget.ready) { item.state = 'backoff'; return; }
      item.state = 'starting'; item.error = '';
      const env = canonicalEnvironment(process.env, { CODEX_HOME: codexHome, FEISHU_CODEX_DATA_DIR: dataDir, FEISHU_CODEX_PORT: bridgePort,
        FEISHU_CODEX_WS_URL: wsUrl, FEISHU_CODEX_DESKTOP_HOST: '1', FEISHU_CODEX_WRITE_GATE_FILE: path.join(directory, 'host-state.json'),
        FEISHU_CODEX_UI_DIR: path.join(root, 'build', 'ui'), CODEX_APP_TOOLS_PIPE_PATH: stablePipe,
        CODEX_MCP_NODE_PATH: customMcpNode || snapshot.mcpNodePath, CODEX_APP_SERVER_WS_URL: null, CODEX_APP_SERVER_FORCE_CLI: null });
      const output = await fs.open(path.join(directory, `${name}.stdout.log`), 'a');
      const error = await fs.open(path.join(directory, `${name}.stderr.log`), 'a');
      try {
        const child = spawn(spec.exe, spec.args, { cwd: dataDir, env, windowsHide: true, stdio: ['ignore', output.fd, error.fd] });
        item.child = child;
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        trackedPids.add(child.pid);
        child.on('error', failure => { void log(`${name}: ${failure.message}`); });
        let identity;
        for (let attempt = 0; attempt < 5; attempt++) {
          snapshot = await inspectFresh();
          identity = snapshot.processes.find(candidate => candidate.pid === child.pid);
          if (identity && identity.parentPid === process.pid && samePath(identity.exe, spec.exe) && (!spec.entry || matchesEntry(identity, spec.entry))) break;
          identity = null;
          if (child.exitCode !== null || child.signalCode !== null) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!identity) throw new Error('进程身份暂未确认，保留进程句柄继续检查。');
        item.identity = { pid: identity.pid, exe: identity.exe, startedAt: identity.startedAt };
        await atomicJson(path.join(directory, `${name}-identity.json`), item.identity);
        await log(`${name} 已启动（PID ${identity.pid}）。`);
      } catch (failure) {
        item.error = failure.message;
        if (item.child?.pid && item.child.exitCode === null && item.child.signalCode === null) item.state = 'unhealthy';
        else { item.state = 'backoff'; item.budget.failed(); item.child = null; }
      } finally { await output.close(); await error.close(); }
      return;
    }
    let ready = false;
    try {
      if (name === 'runtime') ready = listeners.length > 0 && (await probe(wsUrl)).ready;
      else if (name === 'bridge') {
        if (listeners.length) { const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(2_000) }); const health = await response.json(); ready = response.ok && health.name === 'feishu-codex' && health.pid === live.pid; }
      } else ready = await pipeReady(stablePipe);
    } catch { ready = false; }
    item.state = ready ? 'ready' : 'unhealthy';
    item.error = ready ? '' : '进程仍在运行，但暂未就绪。已暂停发送，不会强行结束正在进行的任务。';
    if (ready) item.budget.stable();
  }

  async function tick() {
    if (stopping) return publish();
    snapshot = await inspectFresh();
    desktop = desktopMode(snapshot, Number(ws.port), launchedDesktop);
    // Publish topology changes before starting/checking a component.
    await publish();
    for (const name of ['relay', 'runtime', 'bridge']) {
      try { await ensure(name); } catch (error) { components[name].state = 'blocked'; components[name].error = error.message; }
      await publish();
    }
    return publicState;
  }
  function serialized(operation) {
    const next = (busy || Promise.resolve()).catch(() => {}).then(operation);
    busy = next;
    void next.finally(() => { if (busy === next) busy = null; }).catch(() => {});
    return next;
  }

  async function checkWrite() {
    snapshot = await inspectFresh(500);
    desktop = desktopMode(snapshot, Number(ws.port), launchedDesktop);
    // Always check fresh topology and component readiness. Persisting its
    // display snapshot is left to tick so a file lock cannot reject a message.
    const current = await publish({ persist: false });
    return { canWrite: current.canWrite, reason: current.reason };
  }

  async function openCodex({ accountVerified = false } = {}) {
    await checkWrite();
    if (desktop.mode === 'shared') {
      await runPowerShell(path.join(root, 'scripts', 'desktop-focus.ps1'), ['-ProcessId', desktop.pids[0]]);
      return { ok: true, message: '已连接飞书和 Codex。' };
    }
    if (desktop.mode !== 'closed') throw new Error(desktop.reason);
    if (!publicState.canWrite) throw new Error(publicState.reason);
    if (!accountVerified) {
      await waitForLaunchAccount(probe, wsUrl, { log });
    }
    // The user may open the original shortcut while account readiness is
    // pending. Revalidate topology before requesting any desktop launch.
    await checkWrite();
    if (desktop.mode === 'shared') return openCodex({ accountVerified: true });
    if (desktop.mode !== 'closed') throw new Error(desktop.reason);
    if (!publicState.canWrite) throw new Error(publicState.reason);
    const resultFile = path.join(directory, 'desktop-launch-result.json');
    await runPowerShell(path.join(root, 'scripts', 'launch-packaged-shared.ps1'), ['-WsUrl', wsUrl, '-ResultPath', resultFile], { timeout: 45_000 });
    const result = await readJson(resultFile);
    if (!result?.started || result.error) throw new Error(result?.error || 'Codex 启动结果尚未确认。');
    let identity;
    for (let attempt = 0; attempt < 20; attempt++) {
      snapshot = await inspectFresh();
      identity = snapshot.processes.find(candidate => candidate.pid === result.pid);
      if (identity && samePath(identity.exe, result.exe) && identity.startedAt) break;
      identity = null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!identity) throw new Error('Codex 已请求启动，但进程身份尚未确认。请查看日志后再重试。');
    launchedDesktop = { pid: identity.pid, exe: identity.exe, startedAt: identity.startedAt };
    await atomicJson(path.join(directory, 'desktop-identity.json'), launchedDesktop);
    desktop = desktopMode(snapshot, Number(ws.port), launchedDesktop);
    await publish();
    return { ok: true, message: 'Codex 已启动，桌面正在连接飞书。' };
  }

  async function prepareSwitch() {
    await checkWrite();
    return { desktop: independentDesktop(snapshot, Number(ws.port), launchedDesktop) };
  }

  async function switchToShared(expectedDesktop, confirmed) {
    if (confirmed !== true || !expectedDesktop?.pid || !expectedDesktop.exe || !expectedDesktop.startedAt) throw new Error('请先确认重启 Codex 并连接飞书。');
    await checkWrite();
    if (!sameProcess(expectedDesktop, independentDesktop(snapshot, Number(ws.port), launchedDesktop))) throw new Error('Codex 状态已变化，请重新点击“连接飞书”并确认。');
    if (['runtime', 'bridge', 'relay'].some(name => components[name].state !== 'ready')) throw new Error('连接服务尚未就绪，请先重试连接；当前 Codex 保持原状。');
    await waitForLaunchAccount(probe, wsUrl, { log });
    stopping = true; await publish();
    try {
      await stopIndependentDesktop({ inspect: () => inspectFresh(), expected: expectedDesktop, sharedPort: Number(ws.port), launched: launchedDesktop,
        requestClose: identity => closeWindowVerified(root, dataDir, identity), terminate: identity => stopVerified(root, dataDir, identity) });
      await log('用户确认后已关闭独立 Codex 及其任务后台，正在连接飞书。');
      stopping = false;
      return await openCodex({ accountVerified: true });
    } finally { stopping = false; await checkWrite(); await publish(); }
  }

  async function shutdown({ closeDesktop = false, uninstall = false } = {}) {
    const started = performance.now();
    const timings = {};
    const timed = async (name, operation) => {
      const start = performance.now();
      try { return await operation(); } finally { timings[name] = Math.round(performance.now() - start); }
    };
    snapshot = await timed('inspect', () => inspectFresh());
    desktop = desktopMode(snapshot, Number(ws.port), launchedDesktop);
    if (Object.values(components).some(item => item.child?.pid && item.child.exitCode === null && !item.identity)) throw new Error('仍在确认刚启动的服务身份，请稍后退出。');
    const independent = uninstall && desktopMode(snapshot, Number(ws.port), launchedDesktop).mode === 'independent';
    const preservedDesktop = independent ? snapshot.desktopRoots?.[0] : null;
    const desktopIdentity = independent ? null : sharedDesktopToClose(snapshot, Number(ws.port), launchedDesktop);
    if (desktopIdentity && !closeDesktop) throw Object.assign(new Error('本应用打开的 Codex 仍在运行，可以与 Feishu Codex 一起退出。'), { code: 'SHARED_CODEX_RUNNING' });
    // Pause bridge submissions before inspecting tasks or closing the desktop.
    stopping = true; await publish();
    try {
      const assertIdle = async current => {
        const runtimeExists = components.runtime.identity && current.processes.some(candidate => sameProcess(components.runtime.identity, candidate));
        const bridgeExists = components.bridge.identity && current.processes.some(candidate => sameProcess(components.bridge.identity, candidate));
        if (!runtimeExists && desktopIdentity) throw new Error('无法确认 Codex 的任务状态，请恢复连接后再退出。');
        return checkIdleServices({
          runtime: runtimeExists ? () => probe(wsUrl, { idle: true, timeout: 20_000 }) : undefined,
          bridge: bridgeExists ? async () => {
            const response = await fetch(`http://127.0.0.1:${bridgePort}/api/state`, { signal: AbortSignal.timeout(5_000) });
            if (!response.ok) throw new Error('无法确认飞书任务状态，请稍后重试退出。');
            return response.json();
          } : undefined,
        });
      };
      let current = snapshot;
      if (desktopIdentity) {
        current = await timed('closeDesktop', () => closeSharedDesktop({ inspect: () => inspectFresh(), initialSnapshot: current, sharedPort: Number(ws.port), launched: desktopIdentity, assertIdle,
          captureTree: identity => captureProcessTree(root, dataDir, identity),
          requestClose: identity => closeWindowVerified(root, dataDir, identity), terminate: identity => stopVerified(root, dataDir, identity) }));
        await log('已关闭本应用打开的共享 Codex。');
      }
      // Recheck live work after the close request, then use that same fresh
      // inspection to reject a newly opened desktop before stopping services.
      const state = await timed('checkTasks', () => assertIdle(current));
      const assertDesktopClosed = current => {
        desktop = desktopMode(current, Number(ws.port), launchedDesktop);
        if (desktop.mode !== 'closed' && !(independent && desktop.mode === 'independent' && sameProcess(preservedDesktop, current.desktopRoots?.[0]))) throw new Error('检测到新打开的 Codex，已保留连接服务。请稍后重试退出。');
      };
      assertDesktopClosed(current);
      const bridge = components.bridge;
      if (state) await timed('closeBridge', async () => {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': state.csrfToken }, body: '{}', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('飞书服务暂时无法安全退出，请稍后重试。');
        const deadline = performance.now() + 15_000;
        if (bridge.child?.pid === bridge.identity.pid) await waitForChildExit(bridge.child);
        let exited = false;
        while (performance.now() < deadline) {
          current = await inspectFresh();
          if (!current.processes.some(candidate => sameProcess(bridge.identity, candidate)) && !current.connections.some(connection => connection.state === 'Listen' && connection.localPort === bridgePort)) { exited = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!exited) throw new Error('飞书服务尚未完成退出，未强行终止。');
      });
      else current = await inspectFresh();
      assertDesktopClosed(current);
      if (components.runtime.identity && current.processes.some(candidate => sameProcess(components.runtime.identity, candidate))) {
        // The bridge is now stopped, so no accepted Feishu/UI submission can
        // cross this final idle barrier before the runtime is stopped.
        const final = await timed('finalTaskCheck', () => probe(wsUrl, { idle: true, timeout: 20_000 }));
        if (final.active) throw new Error('检测到刚刚开始的任务，已保留连接服务，请稍后重试退出。');
      }
      // Both processes have independent verified identities. Neither accepts
      // new work after the bridge stops, so they can release in parallel.
      const releases = await timed('closeServices', () => Promise.allSettled(['runtime', 'relay'].map(name => components[name].identity
        ? stopVerified(root, dataDir, components[name].identity, definition(name).port) : Promise.resolve())));
      const failure = releases.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      clearInterval(interval);
      for (const component of Object.values(components)) component.state = 'stopped';
      await publish(); await log(`桌面后台已安全退出。耗时 ${Math.round(performance.now() - started)}ms；分步 ${JSON.stringify(timings)}`);
      setTimeout(() => { server.close(); server.closeAllConnections(); (options.exit || process.exit)(0); }, 150);
      return { ok: true, closedDesktop: desktopIdentity };
    } catch (error) { stopping = false; await publish(); throw error; }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    const reply = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin) { reply(403, { error: '仅允许本机桌面应用连接。' }); return; }
    if (request.method === 'GET' && request.url === '/status') { reply(200, publicState); return; }
    if (request.method !== 'POST' || request.url !== '/control' || request.headers['x-host-token'] !== token) { reply(403, { error: '桌面控制授权无效。' }); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error('请求过大。'); }
      const { action, expectedDesktop, confirmed, uninstall } = JSON.parse(body);
      // A read-only freshness check need not wait behind slow component health
      // probes. The shared inspection coalesces simultaneous bridge checks.
      if (action === 'checkWrite') { reply(200, await checkWrite()); return; }
      const result = await serialized(async () => {
        if (action === 'openCodex') return openCodex();
        if (action === 'prepareSwitch') return prepareSwitch();
        if (action === 'switchToShared') return switchToShared(expectedDesktop, confirmed);
        if (action === 'retry') { for (const item of Object.values(components)) item.budget.reset(); return tick(); }
        if (action === 'shutdown') return shutdown();
        if (action === 'shutdownAll') return shutdown({ closeDesktop: true, uninstall: uninstall === true });
        throw new Error('未知桌面操作。');
      });
      reply(200, result);
    } catch (error) { await log(`桌面控制检查失败：${error.message}`); reply(409, { error: error.message, ...(error.code === 'SHARED_CODEX_RUNNING' ? { code: error.code } : {}) }); }
  });
  await publish();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await atomicJson(path.join(directory, 'host-identity.json'), { pid: ownIdentity.pid, exe: ownIdentity.exe, startedAt: ownIdentity.startedAt });
  await atomicJson(path.join(directory, 'host-control.json'), { port, token, pid: process.pid, root, dataDir });
  await log('桌面后台已启动；不会在 Windows 登录时自动启动。');
  const interval = setInterval(() => {
    if (!busy && !stopping) void serialized(tick).catch(async error => {
      publicState = { ...publicState, state: 'paused', canWrite: false, reason: '无法读取系统状态，已暂停发送。', updatedAt: new Date().toISOString() };
      await persistState(publicState);
      await log(error.message);
    }).catch(() => {});
  }, options.pollMs || 5_000);
  void serialized(tick).catch(error => log(error.message));
  return { server, root, dataDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  startHost({ root: args.root, dataDir: args['data-dir'], port: args.port, bridgePort: args['bridge-port'], wsUrl: args['ws-url'] })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
