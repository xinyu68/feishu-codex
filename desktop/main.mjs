import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordedProcessState, samePath } from './lifecycle.mjs';
import { atomicJson, inspectWindows, readJson, runPowerShell, runWindowlessScript } from './windows.mjs';
import { MigrationRunner, migrationActive } from './migration.mjs';
import { LaunchCoordinator, LaunchPreferences, validatePreferences } from './launch-coordinator.mjs';
import { changeLoginStartup, loginStartupEnabled } from './login-startup.mjs';
import { restoreInstallation } from './installation.mjs';
import { UpdateCoordinator } from './update-coordinator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const productRoot = app.isPackaged ? path.join(process.resourcesPath, 'product') : path.dirname(here);
const nodePath = app.isPackaged ? path.join(process.resourcesPath, 'node', 'node.exe') : process.env.FEISHU_CODEX_NODE_PATH;
const dataDir = path.resolve(process.env.FEISHU_CODEX_DATA_DIR || path.join(app.getPath('home'), '.feishu-codex'));
if (process.env.FEISHU_CODEX_TEST_HIDDEN === '1') app.setPath('userData', path.join(dataDir, 'electron-profile'));
const bootstrapUrl = pathToFileURL(path.join(here, 'bootstrap.html')).toString();
const bridgeOrigin = 'http://127.0.0.1:8790';
let window, tray, quitting = false, hostStarted = false, lastStatus = { state: 'starting', canWrite: false, reason: '正在检查本机服务…' };
let pollBusy = false, retryRequired = false, hostStartRequestedAt = 0;
let quitPromise;
let updates;
let freshSetupBusy = false, freshSetupJustCompleted = false;
let restorePromise, restoreAttempted = false, restoreError = '';
const migration = new MigrationRunner({ productRoot, dataDir, onChange: () => { void poll(); } });
const preferencesPath = path.join(dataDir, 'desktop', 'preferences.json');
const preferences = new LaunchPreferences({ read: () => readJson(preferencesPath), write: value => atomicJson(preferencesPath, value) });
const loginStartupOptions = { path: process.execPath, args: [] };
function canConfigureLoginStartup() { return process.platform === 'win32' && app.isPackaged && process.env.FEISHU_CODEX_TEST_HIDDEN !== '1'; }
function readLoginStartup() { return canConfigureLoginStartup() && loginStartupEnabled(app.getLoginItemSettings(loginStartupOptions)); }
function currentPreferences() { return { ...preferences.get(), openAtLogin: readLoginStartup() }; }
async function savePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || Object.keys(value).some(key => !['openCodexOnLaunch', 'openAtLogin', 'closeWindowAction'].includes(key))
    || typeof value.openAtLogin !== 'boolean') throw new TypeError('桌面设置无效。');
  const next = validatePreferences({ openCodexOnLaunch: value.openCodexOnLaunch, closeWindowAction: value.closeWindowAction });
  const previousLogin = readLoginStartup();
  if (value.openAtLogin && !canConfigureLoginStartup()) throw new Error('开机自启仅支持已安装的 Windows 桌面应用。');
  if (value.openAtLogin !== previousLogin) changeLoginStartup({ get: options => app.getLoginItemSettings(options), set: options => app.setLoginItemSettings(options), path: process.execPath, enabled: value.openAtLogin });
  try { await preferences.set(next); }
  catch (error) {
    if (value.openAtLogin !== previousLogin) {
      try { changeLoginStartup({ get: options => app.getLoginItemSettings(options), set: options => app.setLoginItemSettings(options), path: process.execPath, enabled: previousLogin }); }
      catch { throw new Error(`桌面设置未保存，开机自启回退也未成功：${error.message}`); }
    }
    throw error;
  }
  return currentPreferences();
}
const launch = new LaunchCoordinator({ openCodex: () => control('openCodex', 150_000),
  prepareSwitch: () => control('prepareSwitch'),
  confirmSwitch: async () => {
    const answer = await dialog.showMessageBox(window, { type: 'warning', title: '连接飞书',
      message: '重新打开 Codex 并连接飞书？', detail: 'Codex 将关闭并重新打开，正在运行的任务会被终止。已保存的会话记录会保留。',
      buttons: ['重启并连接', '取消'], defaultId: 1, cancelId: 1, noLink: true });
    return answer.response === 0;
  },
  restartCodex: expectedDesktop => control('switchToShared', 180_000, { expectedDesktop, confirmed: true }),
  onChange: publishStatus, hidden: process.env.FEISHU_CODEX_TEST_HIDDEN === '1' });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { showWindow(); if (window) launch.requestAutoOpen(preferences.get()); });
  app.whenReady().then(start).catch(error => { lastStatus = { state: 'error', reason: error.message, canWrite: false }; publishStatus(); });
}

function showWindow() { if (!window || process.env.FEISHU_CODEX_TEST_HIDDEN === '1') return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
function currentStatus() { return { ...lastStatus, shellVersion: app.getVersion(), launch: launch.getState(), update: updates?.getState() ?? { phase: 'unavailable' } }; }
function publishStatus() { if (window && !window.isDestroyed()) window.webContents.send('desktop:status', currentStatus()); }

async function control(action, timeout = 35_000, params = {}) {
  const saved = await readJson(path.join(dataDir, 'desktop', 'host-control.json'));
  if (!saved || !samePath(saved.root, productRoot) || !samePath(saved.dataDir, dataDir) || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) throw new Error('本机服务尚未就绪。');
  const response = await fetch(`http://127.0.0.1:${saved.port}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Host-Token': saved.token }, body: JSON.stringify({ action, ...params }), signal: AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '桌面操作暂未成功。'), { code: result.code });
  return result;
}

function assertCaller(event) {
  const url = event.senderFrame?.url;
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || !(url === bootstrapUrl || url?.startsWith(`${bridgeOrigin}/`))) throw new Error('无效的桌面操作来源。');
}

async function resolveNode() {
  if (nodePath) { await fs.access(nodePath); return nodePath; }
  return runPowerShell(path.join(productRoot, 'scripts', 'desktop-node-path.ps1'));
}

async function startHost() {
  if (hostStarted) return;
  const deployment = await readJson(path.join(dataDir, 'desktop', 'deployment.json'));
  if (!deployment || deployment.state !== 'active' || !samePath(deployment.productRoot, productRoot)) {
    lastStatus = { state: 'setup', canWrite: false, reason: '请先完成本机设置。' }; return;
  }
  const node = await resolveNode();
  try { await runWindowlessScript(path.join(productRoot, 'scripts', 'desktop-start.vbs'), [productRoot, node, dataDir]); }
  catch (error) {
    // The uninstaller removes the launch task while optionally retaining data.
    // Recreate it after a same-directory reinstall as well as a moved install.
    await restoreInstallation({ productRoot, nodePath: node, dataDir });
    await runWindowlessScript(path.join(productRoot, 'scripts', 'desktop-start.vbs'), [productRoot, node, dataDir]);
  }
  hostStarted = true; hostStartRequestedAt = Date.now();
}

async function restoreExisting() {
  if (!restorePromise) {
    restoreAttempted = true; restoreError = '';
    lastStatus = { state: 'setup', setupMode: 'restore', setupInstalling: true, canWrite: false, reason: '正在恢复已有配置和本机连接…' };
    publishStatus();
    restorePromise = (async () => {
      if (migrationActive(await migration.refresh())) throw new Error('本机设置仍在进行，请等待完成。');
      await restoreInstallation({ productRoot, nodePath: await resolveNode(), dataDir });
      hostStarted = false; retryRequired = false;
      return { ok: true };
    })().catch(error => { restoreError = error.message; throw error; }).finally(() => { restorePromise = null; });
  }
  return restorePromise;
}

async function hasLegacySetup() {
  for (const name of ['config.json', 'state.json', 'runtime.json', 'desktop-baseline']) {
    try { await fs.access(path.join(dataDir, name)); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

async function setupFresh() {
  if (freshSetupBusy) throw new Error('正在准备本机服务，请稍候。');
  if (migrationActive(await migration.refresh())) throw new Error('旧版接管正在进行，请等待完成。');
  freshSetupBusy = true;
  try {
    await runPowerShell(path.join(productRoot, 'scripts', 'desktop-fresh-setup.ps1'),
      ['-ProductRoot', productRoot, '-NodePath', await resolveNode(), '-DataDir', dataDir], { timeout: 60_000 });
    await atomicJson(path.join(dataDir, 'desktop', 'deployment.json'),
      { version: 1, state: 'active', productRoot, installedAt: new Date().toISOString(), setup: 'fresh' });
    freshSetupJustCompleted = true;
    await poll();
    return { ok: true };
  } finally { freshSetupBusy = false; }
}

async function ownedHostPresence() {
  const directory = path.join(dataDir, 'desktop');
  const saved = await readJson(path.join(directory, 'host-control.json'));
  if (saved && (!samePath(saved.root, productRoot) || !samePath(saved.dataDir, dataDir))) return { host: 'dead', children: 'dead' };
  const identity = await readJson(path.join(directory, 'host-identity.json'));
  const records = await Promise.all(['runtime', 'bridge', 'relay'].map(name => readJson(path.join(directory, `${name}-identity.json`))));
  const snapshot = await inspectWindows(productRoot, [8790, 18791, 18792], [identity, ...records].filter(Boolean).map(record => record.pid));
  const host = identity ? recordedProcessState(identity, snapshot.processes)
    : snapshot.connections.some(item => item.state === 'Listen' && item.localPort === 18792) ? 'unknown' : 'dead';
  const childStates = records.filter(Boolean).map(record => recordedProcessState(record, snapshot.processes));
  return { host, children: childStates.includes('alive') ? 'alive' : childStates.includes('unknown') ? 'unknown' : 'dead' };
}

async function poll() {
  if (pollBusy || quitting) return; pollBusy = true;
  try {
    let deployment = await readJson(path.join(dataDir, 'desktop', 'deployment.json'));
    const migrationState = await migration.refresh();
    if (!migrationActive(migrationState) && deployment?.state === 'active' && !samePath(deployment.productRoot, productRoot) && !restoreAttempted) {
      await restoreExisting().catch(() => {});
      deployment = await readJson(path.join(dataDir, 'desktop', 'deployment.json'));
    }
    if (migrationActive(migrationState) || !deployment || deployment.state !== 'active' || !samePath(deployment.productRoot, productRoot)) {
      hostStarted = false; retryRequired = false;
      const setupMode = deployment || await hasLegacySetup() ? 'restore' : 'fresh';
      lastStatus = { state: 'setup', canWrite: false, migration: migrationState,
        setupMode, setupInstalling: freshSetupBusy || Boolean(restorePromise),
        reason: freshSetupBusy ? '正在准备本机服务…' : migrationActive(migrationState) ? migrationState.message : restoreError || (setupMode === 'fresh' ? '首次使用，先启动本机服务，然后在工作台连接飞书机器人。' : '原有飞书配置和偏好已保留，恢复连接后即可继续使用。') };
      if (window.webContents.getURL() !== bootstrapUrl) await window.loadURL(bootstrapUrl);
      return;
    }
    if (retryRequired) throw new Error('本机服务已停止。点击“重试连接”恢复。');
    await startHost();
    if (hostStarted) {
      const saved = await readJson(path.join(dataDir, 'desktop', 'host-control.json'));
      if (!saved || !samePath(saved.root, productRoot) || !samePath(saved.dataDir, dataDir)) throw new Error('正在连接本机服务…');
      const response = await fetch(`http://127.0.0.1:${saved.port}/status`, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error('本机服务暂未响应。');
      const status = await response.json();
      if (status.pid !== saved.pid || !status.updatedAt || Date.now() - Date.parse(status.updatedAt) > 20_000) throw new Error('连接状态尚未更新。');
      lastStatus = status;
      if (status.bridge?.state === 'ready' && window.webContents.getURL() === bootstrapUrl) {
        await window.loadURL(`${bridgeOrigin}/${freshSetupJustCompleted ? '?setup=feishu' : ''}`);
        freshSetupJustCompleted = false;
      }
    }
  } catch (error) {
    if (hostStarted && Date.now() - hostStartRequestedAt > 15_000) {
      try { if ((await ownedHostPresence()).host === 'dead') { hostStarted = false; retryRequired = true; } } catch { }
    }
    lastStatus = { state: 'error', canWrite: false, reason: error.message === 'fetch failed' ? '连接暂未恢复，可重试或查看日志。' : error.message };
  }
  finally { pollBusy = false; launch.update(lastStatus); publishStatus(); }
}

function quitAll() {
  if (!quitPromise) quitPromise = performQuit().finally(() => { quitPromise = null; });
  return quitPromise;
}

async function performQuit({ forUpdate = false } = {}) {
  try {
    launch.cancelPending();
    if (launch.inFlight) throw new Error('Codex 正在打开或切换连接，请等操作完成后再退出。');
    if (migrationActive(await migration.refresh())) throw new Error('首次接管正在进行。可以关闭窗口收起到托盘，请等接管完成后再退出应用。');
    const deployment = await readJson(path.join(dataDir, 'desktop', 'deployment.json'));
    if (hostStarted || (deployment?.state === 'active' && samePath(deployment.productRoot, productRoot))) {
      try {
        try { await control('shutdown', 90_000); }
        catch (error) {
          if (error.code !== 'SHARED_CODEX_RUNNING') throw error;
          const answer = await dialog.showMessageBox(window, { type: 'question', title: '退出 Feishu Codex',
            message: '同时退出 Codex？', detail: '将关闭本应用打开的 Codex，并停止飞书消息服务。若仍有任务正在运行，会保留服务并提示你。',
            buttons: ['退出应用和 Codex', '取消'], defaultId: 1, cancelId: 1, noLink: true });
          if (answer.response !== 0) return { ok: false, cancelled: true };
          await control('shutdownAll', 120_000);
        }
      }
      catch (error) {
        const presence = await ownedHostPresence();
        if (presence.host !== 'dead') throw error;
        if (hostStarted && Date.now() - hostStartRequestedAt < 8_000) throw new Error('本机服务正在启动，请等待就绪后再退出。');
        if (presence.children !== 'dead') throw new Error('本机服务连接已中断，但 Codex 或飞书仍在运行。请先重试连接，再安全退出；不会强行终止可能正在运行的任务。');
      }
    }
    quitting = true;
    if (!forUpdate) app.quit();
    return { ok: true };
  } catch (error) { showWindow(); lastStatus = { ...lastStatus, actionError: error.message }; publishStatus(); if (!forUpdate && process.env.FEISHU_CODEX_TEST_HIDDEN !== '1') await dialog.showMessageBox(window, { type: 'info', title: '暂时不能退出', message: error.message, buttons: ['知道了'] }); throw error; }
}

async function migrate() {
  const result = await migration.start(await resolveNode());
  await poll();
  return result;
}

async function start() {
  await preferences.load();
  if (app.isPackaged && process.env.FEISHU_CODEX_TEST_HIDDEN !== '1') {
    const requireProduct = createRequire(path.join(productRoot, 'package.json'));
    const { autoUpdater } = requireProduct('electron-updater');
    updates = new UpdateCoordinator({ updater: autoUpdater, onChange: publishStatus,
      currentVersion: app.getVersion(),
      latestReleaseTag: async () => {
        const response = await fetch('https://api.github.com/repos/xinyu68/feishu-codex/releases/latest', {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Feishu-Codex' }, signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`GitHub Release 查询失败：${response.status}`);
        const result = await response.json();
        if (typeof result.tag_name !== 'string') throw new Error('GitHub Release 版本无效');
        return result.tag_name;
      },
      beforeInstall: () => performQuit({ forUpdate: true }) });
  }
  app.setAppUserModelId('local.feishu-codex.desktop');
  const area = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width: Math.min(1240, area.width), height: Math.min(800, area.height), minWidth: Math.min(900, area.width), minHeight: Math.min(620, area.height),
    title: 'Feishu Codex', backgroundColor: '#f5f7fb', icon: path.join(here, 'assets', 'icon.ico'), show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.removeMenu();
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (preferences.get().closeWindowAction === 'quit') void quitAll().catch(() => {});
    else window.hide();
  });
  window.once('ready-to-show', showWindow);
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url) && !url.startsWith('http://127.0.0.1')) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!(url === bootstrapUrl || url.startsWith(`${bridgeOrigin}/`))) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (process.env.FEISHU_CODEX_TEST_HIDDEN !== '1') {
    tray = new Tray(nativeImage.createFromPath(path.join(here, 'assets', 'icon.png')));
    tray.setToolTip('Feishu Codex · 飞书与桌面，接续任务');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Feishu Codex', click: showWindow },
      { label: '打开 Codex（连接飞书）', click: () => { void launch.openCodex().catch(error => { showWindow(); if (process.env.FEISHU_CODEX_TEST_HIDDEN !== '1') void dialog.showMessageBox(window, { type: 'info', title: '暂时无法打开 Codex', message: error.message, buttons: ['知道了'] }); }); } },
      { type: 'separator' }, { label: '退出全部服务', click: () => { void quitAll().catch(() => {}); } },
    ]));
    tray.on('double-click', showWindow);
  }
  const actions = {
    getStatus: async () => currentStatus(),
    getPreferences: async () => currentPreferences(),
    setPreferences: savePreferences,
    chooseWorkspace: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择本机项目目录',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] || null;
    },
    openCodex: () => launch.openCodex(),
    switchToShared: () => launch.switchToShared(),
    retry: async () => { hostStarted = false; retryRequired = false; await startHost(); if (hostStarted) await control('retry'); await poll(); return currentStatus(); },
    openLogs: async () => { const directory = path.join(dataDir, 'desktop'); await fs.mkdir(directory, { recursive: true }); const error = await shell.openPath(directory); if (error) throw new Error(error); return { ok: true }; },
    checkForUpdates: async () => updates ? updates.check() : { phase: 'unavailable' },
    downloadUpdate: async () => { if (!updates) throw new Error('请先安装正式版应用。'); return updates.download(); },
    installUpdate: async () => {
      if (!updates) throw new Error('请先安装正式版应用。');
      try { return await updates.install(); }
      catch (error) {
        if (quitting) { quitting = false; hostStarted = false; retryRequired = false; void poll(); }
        throw error;
      }
    },
    quit: quitAll,
    migrate,
    setupFresh,
    restoreExisting: async () => { const result = await restoreExisting(); await poll(); return result; },
    showWindow: async () => { showWindow(); return { ok: true }; },
  };
  for (const [name, handler] of Object.entries(actions)) ipcMain.handle(`desktop:${name}`, async (event, ...args) => { assertCaller(event); try { if (args.length !== (name === 'setPreferences' ? 1 : 0)) throw new Error('无效的桌面操作参数。'); return await handler(...args); } catch (error) { throw new Error(error.message); } });
  await window.loadURL(bootstrapUrl);
  launch.start(preferences.get());
  setInterval(() => { void poll(); }, 2_000).unref();
  if (updates) {
    setTimeout(() => { void updates.check(); }, 15_000).unref();
    setInterval(() => { void updates.check(); }, 6 * 60 * 60 * 1000).unref();
  }
  await poll();
}

app.on('window-all-closed', () => {});
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quitAll().catch(() => {}); } });
app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
});
