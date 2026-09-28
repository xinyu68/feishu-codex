import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaunchCoordinator, LaunchPreferences, validatePreferences } from '../desktop/launch-coordinator.mjs';
import { changeLoginStartup, loginStartupEnabled } from '../desktop/login-startup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const enabled = { openCodexOnLaunch: true };
const ready = (mode = 'closed', canWrite = true) => ({ state: 'ready', canWrite, desktop: { mode } });
const drain = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(options = {}) {
  let calls = 0, time = 0;
  const changes = [];
  const coordinator = new LaunchCoordinator({
    openCodex: async () => { calls++; return { ok: true }; },
    prepareSwitch: async () => ({ desktop: { pid: 1, exe: 'codex', startedAt: 'start' } }),
    confirmSwitch: async () => false, restartCodex: async () => { calls++; return { ok: true }; },
    onChange: state => changes.push(state), now: () => time, ...options,
  });
  return { coordinator, changes, calls: () => calls, advance: value => { time += value; } };
}

test('startup waits for service readiness and opens exactly once', async () => {
  const f = fixture();
  f.coordinator.start(enabled);
  assert.equal(f.coordinator.getState().state, 'opening');
  f.coordinator.update(ready('closed', false));
  await drain(); assert.equal(f.calls(), 0);
  f.coordinator.update(ready());
  await drain(); assert.equal(f.calls(), 1);
  assert.equal(f.coordinator.getState().state, 'idle');
  f.coordinator.update(ready('shared'));
  f.coordinator.update(ready());
  f.coordinator.start(enabled);
  await drain(); assert.equal(f.calls(), 1, 'closing Codex does not automatically reopen it');
});

test('an already shared Codex satisfies startup without opening or focusing', async () => {
  const f = fixture(); f.coordinator.update(ready('shared')); f.coordinator.start(enabled);
  await drain(); assert.equal(f.calls(), 0); assert.equal(f.coordinator.getState().state, 'idle');
});

test('an independent Codex is left untouched and requires an explicit switch', async () => {
  const f = fixture(); f.coordinator.update(ready('independent', false)); f.coordinator.start(enabled);
  assert.equal(f.coordinator.getState().state, 'error');
  assert.match(f.coordinator.getState().message, /连接飞书/);
  f.coordinator.update(ready()); await drain(); assert.equal(f.calls(), 0);
  await assert.rejects(async () => { f.coordinator.update(ready('independent', false)); await f.coordinator.openCodex(); }, /尚未连接飞书/);
  assert.equal(f.calls(), 0);
});

test('confirmed switch restarts immediately, without waiting for manual exit or idle', async () => {
  const f = fixture({ confirmSwitch: async () => true }); f.coordinator.update(ready('independent', false));
  await f.coordinator.switchToShared();
  assert.equal(f.calls(), 1);
  assert.ok(f.changes.some(state => state.state === 'confirming'));
  assert.ok(f.changes.some(state => state.state === 'switching'));
  f.coordinator.update(ready()); await drain(); assert.equal(f.calls(), 1);
});

test('cancelled switch cannot subsequently open Codex', async () => {
  const f = fixture(); f.coordinator.update(ready('independent', false));
  assert.deepEqual(await f.coordinator.switchToShared(), { ok: false, cancelled: true });
  f.coordinator.update(ready());
  await drain(); assert.equal(f.calls(), 0); assert.equal(f.coordinator.getState().state, 'idle');
});

test('latest shared/closed desktop uses ordinary open without a restart confirmation', async () => {
  const f = fixture({ prepareSwitch: async () => ({ desktop: null }), confirmSwitch: async () => { throw new Error('unexpected confirmation'); } });
  f.coordinator.update(ready('independent', false)); await f.coordinator.switchToShared();
  assert.equal(f.calls(), 1); assert.equal(f.coordinator.getState().state, 'idle');
});

test('startup times out without retries or process effects', async () => {
  const f = fixture({ readyTimeoutMs: 10 });
  f.coordinator.start(enabled); f.coordinator.update({ state: 'starting', canWrite: false }); f.advance(11); f.coordinator.update(ready());
  assert.equal(f.coordinator.getState().state, 'error');
  f.coordinator.update(ready()); await drain(); assert.equal(f.calls(), 0);
});

test('double click shares one confirmation and carries the originally confirmed identity', async () => {
  let confirm, confirmations = 0, restarts = 0;
  const expected = { pid: 73, exe: 'original', startedAt: 'before-popup' };
  const f = fixture({ prepareSwitch: async () => ({ desktop: expected }),
    confirmSwitch: () => { confirmations++; return new Promise(resolve => { confirm = resolve; }); },
    restartCodex: async identity => { assert.deepEqual(identity, expected); restarts++; return { ok: true }; } });
  f.coordinator.update(ready('independent', false));
  const first = f.coordinator.switchToShared(), second = f.coordinator.switchToShared();
  assert.equal(first, second); await drain(); assert.equal(confirmations, 1); assert.equal(restarts, 0);
  confirm(true); await first; assert.equal(restarts, 1);
});

test('failed restart is surfaced and never repeats from polling', async () => {
  let restarts = 0;
  const f = fixture({ confirmSwitch: async () => true, restartCodex: async () => { restarts++; throw new Error('desktop changed'); } });
  f.coordinator.update(ready('independent', false));
  await assert.rejects(f.coordinator.switchToShared(), /desktop changed/);
  f.coordinator.update(ready('independent', false)); await drain();
  assert.equal(restarts, 1); assert.equal(f.coordinator.getState().state, 'error');
});

test('initial migration time does not consume the automatic launch readiness timeout', async () => {
  const f = fixture({ readyTimeoutMs: 10 }); f.coordinator.start(enabled);
  f.coordinator.update({ state: 'setup', canWrite: false }); f.advance(1000);
  f.coordinator.update({ state: 'setup', canWrite: false });
  assert.equal(f.coordinator.getState().state, 'opening');
  f.coordinator.update({ state: 'starting', canWrite: false }); f.advance(5);
  f.coordinator.update(ready()); await drain(); assert.equal(f.calls(), 1);
});

test('background-only preference and hidden tests suppress automatic opening', async () => {
  for (const options of [{ hidden: true }, {}]) {
    const f = fixture(options); f.coordinator.update(ready());
    const pref = options.hidden ? enabled : { openCodexOnLaunch: false };
    f.coordinator.start(pref); f.coordinator.requestAutoOpen(pref);
    await drain(); assert.equal(f.calls(), 0);
    if (options.hidden) { f.coordinator.switchToShared(); await drain(); assert.equal(f.calls(), 0); }
  }
});

test('second-instance intent follows latest preference and never becomes a polling loop', async () => {
  const f = fixture(); f.coordinator.update(ready()); f.coordinator.start({ openCodexOnLaunch: false });
  f.coordinator.requestAutoOpen(enabled); await drain(); assert.equal(f.calls(), 1);
  f.coordinator.update(ready()); await drain(); assert.equal(f.calls(), 1);
  f.coordinator.requestAutoOpen({ openCodexOnLaunch: false }); await drain(); assert.equal(f.calls(), 1);
  f.coordinator.requestAutoOpen(enabled); await drain(); assert.equal(f.calls(), 2);
  f.coordinator.update(ready('shared')); f.coordinator.requestAutoOpen(enabled);
  await drain(); assert.equal(f.calls(), 2);
});

test('automatic, manual, repeated-icon and switch actions share one launch in flight', async () => {
  let resolve, count = 0;
  const f = fixture({ openCodex: () => { count++; return new Promise(done => { resolve = done; }); } });
  f.coordinator.update(ready()); f.coordinator.start(enabled);
  const first = f.coordinator.openCodex(), second = f.coordinator.openCodex();
  f.coordinator.requestAutoOpen(enabled); f.coordinator.switchToShared();
  await drain(); assert.equal(count, 1); assert.equal(first, second);
  resolve({ ok: true }); await first; assert.equal(f.coordinator.getState().state, 'idle');
});

test('launch errors are surfaced once, and explicit manual retry remains available', async () => {
  let calls = 0;
  const f = fixture({ openCodex: async () => { calls++; throw new Error('测试启动失败'); } });
  f.coordinator.update(ready()); f.coordinator.start(enabled); await drain();
  assert.deepEqual(f.coordinator.getState(), { state: 'error', message: '测试启动失败' });
  f.coordinator.update(ready()); await drain(); assert.equal(calls, 1);
  await assert.rejects(f.coordinator.openCodex(), /测试启动失败/); assert.equal(calls, 2);
});

test('confirmed shared mode clears a stale launch error without opening or overriding an in-flight launch', async () => {
  let complete, calls = 0;
  const f = fixture({ openCodex: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  f.coordinator.update(ready('independent', false)); f.coordinator.start(enabled);
  assert.equal(f.coordinator.getState().state, 'error');
  f.coordinator.update(ready('shared'));
  assert.deepEqual(f.coordinator.getState(), { state: 'idle' }); assert.equal(calls, 0);
  f.coordinator.update(ready()); const opening = f.coordinator.openCodex(); await drain();
  f.coordinator.update(ready('shared'));
  assert.equal(f.coordinator.getState().state, 'opening'); assert.equal(calls, 1);
  complete({ ok: true }); await opening;
  assert.equal(f.coordinator.getState().state, 'idle'); assert.equal(calls, 1);
});

test('manual open can focus an existing shared Codex, but never acts on unknown state', async () => {
  const f = fixture(); f.coordinator.update(ready('unknown', false));
  await assert.rejects(f.coordinator.openCodex(), /尚未准备好/); assert.equal(f.calls(), 0);
  f.coordinator.update(ready('shared')); await f.coordinator.openCodex(); assert.equal(f.calls(), 1);
});

test('quitting cancels pending startup without closing any process', async () => {
  const f = fixture(); f.coordinator.start(enabled); f.coordinator.cancelPending(); f.coordinator.update(ready());
  await drain(); assert.equal(f.calls(), 0);
});

test('preferences keep existing startup choice and default window close to tray', async () => {
  for (const stored of [null, {}, { openCodexOnLaunch: 'true' }, { openCodexOnLaunch: true, extra: true }]) {
    const prefs = new LaunchPreferences({ read: async () => stored, write: async () => {} });
    assert.deepEqual(await prefs.load(), { ...enabled, closeWindowAction: 'tray' });
  }
  const legacy = new LaunchPreferences({ read: async () => ({ openCodexOnLaunch: false }), write: async () => {} });
  assert.deepEqual(await legacy.load(), { openCodexOnLaunch: false, closeWindowAction: 'tray' });
  assert.deepEqual(validatePreferences({ openCodexOnLaunch: true, closeWindowAction: 'quit' }), { openCodexOnLaunch: true, closeWindowAction: 'quit' });
  for (const value of [null, [], {}, true, { openCodexOnLaunch: 1 }, { openCodexOnLaunch: false, extra: true }, { openCodexOnLaunch: true, closeWindowAction: 'delete' }]) assert.throws(() => validatePreferences(value), /启动设置/);
});

test('preferences persist in order and only become visible after successful atomic writing', async () => {
  const writes = [];
  const prefs = new LaunchPreferences({ read: async () => ({ openCodexOnLaunch: false }), write: async value => { writes.push(value); } });
  assert.deepEqual(await prefs.load(), { openCodexOnLaunch: false, closeWindowAction: 'tray' });
  await Promise.all([prefs.set({ ...enabled, closeWindowAction: 'quit' }), prefs.set({ openCodexOnLaunch: false, closeWindowAction: 'tray' })]);
  assert.deepEqual(writes, [{ ...enabled, closeWindowAction: 'quit' }, { openCodexOnLaunch: false, closeWindowAction: 'tray' }]);
  assert.deepEqual(prefs.get(), { openCodexOnLaunch: false, closeWindowAction: 'tray' });
  const copy = prefs.get(); copy.openCodexOnLaunch = true;
  assert.deepEqual(prefs.get(), { openCodexOnLaunch: false, closeWindowAction: 'tray' });
  prefs.write = async () => { throw new Error('write failed'); };
  await assert.rejects(prefs.set(enabled), /write failed/);
  assert.deepEqual(prefs.get(), { openCodexOnLaunch: false, closeWindowAction: 'tray' });
});

test('Windows login startup reflects the enabled state and verifies changes', () => {
  let settings = { openAtLogin: false, executableWillLaunchAtLogin: false };
  const writes = [];
  const get = () => settings;
  const set = value => { writes.push(value); settings = { openAtLogin: value.openAtLogin, executableWillLaunchAtLogin: false }; };
  assert.equal(loginStartupEnabled(settings), false);
  assert.equal(changeLoginStartup({ get, set, path: 'C:\\Feishu Codex.exe', enabled: true }), true);
  assert.equal(loginStartupEnabled(settings), true);
  assert.equal(changeLoginStartup({ get, set, path: 'C:\\Feishu Codex.exe', enabled: true }), false);
  assert.equal(changeLoginStartup({ get, set, path: 'C:\\Feishu Codex.exe', enabled: false }), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, 'C:\\Feishu Codex.exe');
  assert.deepEqual(writes[0].args, []);
  assert.equal(Object.hasOwn(writes[0], 'name'), false, 'Electron must use the same default startup entry name for reading and writing');
});

test('production packaged launcher uses a windowless script host and preserves the default Codex profile', async () => {
  const powershell = await fs.readFile(path.join(root, 'scripts', 'launch-packaged-shared.ps1'), 'utf8');
  const vbs = await fs.readFile(path.join(root, 'scripts', 'launch-packaged-shared.vbs'), 'utf8');
  assert.match(powershell, /System32\\wscript\.exe/);
  assert.match(powershell, /\/\/B \/\/NoLogo/);
  assert.doesNotMatch(powershell, /powershell\.exe/i);
  assert.match(vbs, /CODEX_APP_SERVER_WS_URL/);
  assert.match(vbs, /shell\.Exec\(command\)/i);
  assert.doesNotMatch(vbs, /CODEX_HOME/);
  assert.doesNotMatch(vbs, /--user-data-dir/i);
});

test('normal desktop startup uses the windowless task host instead of PowerShell', async () => {
  const main = await fs.readFile(path.join(root, 'desktop', 'main.mjs'), 'utf8');
  const register = await fs.readFile(path.join(root, 'scripts', 'desktop-register.ps1'), 'utf8');
  const taskHost = await fs.readFile(path.join(root, 'scripts', 'desktop-host.vbs'), 'utf8');
  assert.match(main, /runWindowlessScript\(path\.join\(productRoot, 'scripts', 'desktop-start\.vbs'\)/);
  assert.doesNotMatch(main, /runPowerShell\(path\.join\(productRoot, 'scripts', 'desktop-start\.ps1'\)/);
  assert.match(register, /System32\\wscript\.exe/);
  assert.doesNotMatch(register, /WindowsPowerShell/i);
  assert.match(taskHost, /shell\.Run\(command, 0, True\)/i);
});
