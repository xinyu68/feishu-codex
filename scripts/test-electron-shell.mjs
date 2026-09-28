import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-shell-test-'));
const executablePath = process.argv[2] || path.join(root, 'node_modules/electron/dist/electron.exe');
const lease = net.createServer();
await new Promise(resolve => lease.listen(0, '127.0.0.1', resolve));
const port = lease.address().port;
await new Promise(resolve => lease.close(resolve));
const args = ['--inspect=0', `--remote-debugging-port=${port}`, ...(process.argv[2] ? [] : [root])];
const env = canonicalEnvironment(process.env, { FEISHU_CODEX_DATA_DIR: dataDir, FEISHU_CODEX_TEST_HIDDEN: '1', ELECTRON_RUN_AS_NODE: null, CODEX_APP_SERVER_WS_URL: null });
const result = { startedAt: new Date().toISOString(), executablePath, passed: false };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, stderr = '', stdout = '';
const processEvents = [];
const pageEvents = [];
async function mainEvaluate(expression) {
  const endpoint = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr)?.[1];
  if (!endpoint) throw new Error('没有发现隔离桌面的主进程诊断端口。');
  const socket = new WebSocket(endpoint);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('主进程诊断超时')); }, 5000);
    let response;
    socket.once('error', error => { clearTimeout(timer); socket.terminate(); reject(error); });
    socket.once('close', () => {
      clearTimeout(timer);
      if (!response) reject(new Error('主进程诊断连接提前关闭。'));
      else if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else resolve(response.result?.result?.value);
    });
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    socket.on('message', raw => {
      const incoming = JSON.parse(raw.toString());
      if (incoming.id !== 1) return;
      response = incoming;
      // Node may keep an exiting app alive while its inspector is attached.
      // Finish this test resource's close handshake before requesting app.quit.
      socket.close();
    });
  });
}
try {
  await fs.access(executablePath);
  child = spawn(executablePath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-6000); });
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-6000); });
  child.on('exit', (code, signal) => processEvents.push({ event: 'exit', code, signal, at: new Date().toISOString() }));
  child.on('close', (code, signal) => processEvents.push({ event: 'close', code, signal, at: new Date().toISOString() }));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const deadline = Date.now() + 30_000;
  let endpoint;
  while (Date.now() < deadline && child.exitCode === null) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json()).webSocketDebuggerUrl; if (endpoint) break; } catch {}
    await wait(200);
  }
  if (!endpoint) throw new Error(`桌面调试窗口未就绪。${stderr}`);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  let page;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages())[0];
    if (page) break;
    await wait(200);
  }
  if (!page) throw new Error(`桌面窗口未创建。${stderr}`);
  page.on('pageerror', error => pageEvents.push({ event: 'pageerror', message: error.message }));
  page.on('crash', () => pageEvents.push({ event: 'crash' }));
  page.on('close', () => pageEvents.push({ event: 'close', at: new Date().toISOString() }));
  await expect.poll(async () => (await page.evaluate(() => window.feishuCodex?.getStatus()))?.state, { timeout: 15_000 }).toBe('setup');
  assert.equal(await page.locator('#fresh').isVisible(), true);
  assert.equal(await page.locator('#migrate').count(), 0);
  assert.equal((await page.evaluate(() => window.feishuCodex.getStatus())).setupMode, 'fresh');
  assert.equal(await page.locator('#error').textContent(), '');
  const capabilities = await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, methods: Object.keys(window.feishuCodex).sort() }));
  assert.equal(capabilities.node, 'undefined'); assert.equal(capabilities.process, 'undefined');
  assert.deepEqual(capabilities.methods, ['getStatus', 'getPreferences', 'setPreferences', 'chooseWorkspace', 'switchToShared', 'migrate', 'setupFresh', 'restoreExisting', 'onStatus', 'openCodex', 'openLogs', 'quit', 'retry', 'showWindow'].sort());
  const chosenWorkspace = path.join(dataDir, 'chosen-workspace');
  await fs.mkdir(chosenWorkspace);
  await mainEvaluate(`(() => { const {dialog} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); globalThis.__originalFolderDialog = dialog.showOpenDialog; dialog.showOpenDialog = async (_window, options) => { globalThis.__folderDialogOptions = options; return {canceled: false, filePaths: [${JSON.stringify(chosenWorkspace)}]}; }; return true; })()`);
  assert.equal(await page.evaluate(() => window.feishuCodex.chooseWorkspace()), chosenWorkspace);
  assert.deepEqual((await mainEvaluate('globalThis.__folderDialogOptions')).properties, ['openDirectory']);
  await mainEvaluate(`(() => { const {dialog} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); dialog.showOpenDialog = async () => ({canceled: true, filePaths: []}); return true; })()`);
  assert.equal(await page.evaluate(() => window.feishuCodex.chooseWorkspace()), null);
  await mainEvaluate(`(() => { const {dialog} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); dialog.showOpenDialog = globalThis.__originalFolderDialog; delete globalThis.__originalFolderDialog; delete globalThis.__folderDialogOptions; return true; })()`);
  result.folderPickerPassed = true;
  if (process.env.FEISHU_CODEX_TEST_LOGIN_STARTUP === '1') {
    await mainEvaluate(`(() => { process.env.FEISHU_CODEX_TEST_HIDDEN = '0'; return true; })()`);
    try {
      const enabled = await page.evaluate(() => window.feishuCodex.setPreferences({ openCodexOnLaunch: true, closeWindowAction: 'tray', openAtLogin: true }));
      assert.equal(enabled.openAtLogin, true);
      const observed = await mainEvaluate(`(() => { const {app} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); return app.getLoginItemSettings({path: process.execPath, args: []}); })()`);
      assert.equal(observed.openAtLogin, true);
      const disabled = await page.evaluate(() => window.feishuCodex.setPreferences({ openCodexOnLaunch: true, closeWindowAction: 'tray', openAtLogin: false }));
      assert.equal(disabled.openAtLogin, false);
      result.loginProbe = { enabled, observed, disabled };
    } finally {
      await mainEvaluate(`(() => { const {app} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); app.setLoginItemSettings({path: process.execPath, args: [], openAtLogin: false, enabled: true}); process.env.FEISHU_CODEX_TEST_HIDDEN = '1'; return app.getLoginItemSettings({path: process.execPath, args: []}); })()`);
    }
  }
  assert.deepEqual(await page.evaluate(() => window.feishuCodex.getPreferences()), { openCodexOnLaunch: true, closeWindowAction: 'tray', openAtLogin: false });
  assert.deepEqual(await page.evaluate(() => window.feishuCodex.setPreferences({ openCodexOnLaunch: false, closeWindowAction: 'quit', openAtLogin: false })), { openCodexOnLaunch: false, closeWindowAction: 'quit', openAtLogin: false });
  const savedPreferences = JSON.parse(await fs.readFile(path.join(dataDir, 'desktop', 'preferences.json'), 'utf8'));
  assert.equal(savedPreferences.openCodexOnLaunch, false);
  assert.equal(savedPreferences.closeWindowAction, 'quit');
  assert.equal(await page.evaluate(async () => {
    try { await window.feishuCodex.setPreferences({ openCodexOnLaunch: 'false' }); return false; } catch { return true; }
  }), true, '偏好 IPC 必须校验实际参数');
  await page.reload();
  assert.deepEqual(await page.evaluate(() => window.feishuCodex.getPreferences()), { openCodexOnLaunch: false, closeWindowAction: 'quit', openAtLogin: false });
  await page.evaluate(() => window.feishuCodex.setPreferences({ openCodexOnLaunch: false, closeWindowAction: 'tray', openAtLogin: false }));
  result.preferencesPersisted = true;
  result.beforeQuit = await page.evaluate(() => window.feishuCodex.getStatus());
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts', process.argv[2] ? 'desktop-packaged-bootstrap.png' : 'desktop-bootstrap.png') });
  const closeState = await mainEvaluate(`(() => { const {BrowserWindow} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); const window = BrowserWindow.getAllWindows()[0]; window.close(); return {destroyed: window.isDestroyed(), visible: window.isVisible()}; })()`);
  assert.deepEqual(closeState, { destroyed: false, visible: false }, '关闭应隐藏到托盘，而不是销毁工作台');
  result.mainInspectorDetached = true;
  assert.equal(await fs.access(path.join(dataDir, 'desktop', 'deployment.json')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(dataDir, 'service.lock')).then(() => true, () => false), false);
  await page.evaluate(() => window.feishuCodex.setPreferences({ openCodexOnLaunch: false, closeWindowAction: 'quit', openAtLogin: false }));
  result.quitRequestedAt = new Date().toISOString();
  await mainEvaluate(`(() => { const {BrowserWindow} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 100); return true; })()`);
  const quitDeadline = Date.now() + 10_000;
  while (Date.now() < quitDeadline && child.exitCode === null) await wait(100);
  if (child.exitCode !== 0) {
    result.beforeForcedCleanup = { exitCode: child.exitCode, signalCode: child.signalCode, connected: child.connected, killed: child.killed, pageClosed: page.isClosed() };
    try { result.afterQuitStatus = await page.evaluate(() => window.feishuCodex.getStatus()); }
    catch (error) { result.afterQuitStatusError = error.message; }
    try { result.mainAfterQuit = await mainEvaluate(`(() => { const {BrowserWindow, app} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); return {ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({id: window.id, destroyed: window.isDestroyed(), visible: window.isVisible(), url: window.webContents.getURL()})), resources: process.getActiveResourcesInfo()}; })()`); }
    catch (error) { result.mainAfterQuitError = error.message; }
  }
  assert.equal(child.exitCode, 0, '没有后台时应用应完整退出');
  result.passed = true;
  Object.assign(result, { isolated: true, setupWithoutHost: true, restrictedPreload: true, closeHidesToTray: true, closeQuitsWhenSelected: true, cleanQuit: true });
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  if (child?.exitCode === null) child.kill();
  await browser?.close().catch(() => {});
  if (path.dirname(dataDir) !== os.tmpdir() || !path.basename(dataDir).startsWith('feishu-codex-shell-test-')) throw new Error('Unsafe cleanup path');
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(error => { result.cleanupError = error.code; });
  result.finishedAt = new Date().toISOString();
  Object.assign(result, { stdout, stderr, processEvents, pageEvents });
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts', process.argv[2] ? 'desktop-packaged-shell-test.json' : 'desktop-shell-test.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
