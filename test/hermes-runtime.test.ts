import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ManagedHermesRuntime, findHermesInstallation, hermesEnvironment } from '../src/hermes-runtime.js';
import { discoverHermesDashboard } from '../src/hermes-discovery.js';

const installation = { root: process.cwd(), home: process.cwd(), python: process.execPath, webDist: process.cwd() };
function harness(extra: ConstructorParameters<typeof ManagedHermesRuntime>[0] = {}, neverReady = false) {
  const children: ReturnType<typeof spawn>[] = [];
  const runtime = new ManagedHermesRuntime({
    resolveInstallation: () => installation, launcher: 'unused', startTimeoutMs: 4000, retryDelayMs: 0,
    launch: ((command: string, _args: string[], options: Parameters<typeof spawn>[2]) => {
      assert.equal(options?.windowsHide, true);
      assert.equal(options?.env?.HERMES_DESKTOP, undefined);
      const child = spawn(process.execPath, [path.resolve('test/fixtures/hermes-managed-backend.mjs'), ...(neverReady ? ['--never-ready'] : [])], options);
      children.push(child);
      return child;
    }) as typeof spawn,
    ...extra,
  });
  return { runtime, children };
}

test('managed Hermes cold start is shared by bots and remains alive between client discoveries', async t => {
  const { runtime, children } = harness();
  t.after(() => runtime.close());
  const [first, second] = await Promise.all([runtime.ensure(), runtime.ensure()]);
  assert.equal(children.length, 1);
  assert.equal(first.baseUrl, second.baseUrl);
  assert.equal((await runtime.ensure()).baseUrl, first.baseUrl);
  await runtime.close();
  assert.notEqual(children[0]?.exitCode, null);
  await assert.rejects(runtime.ensure(), /退出/);
  await assert.rejects(fetch(`${first.baseUrl}/api/status`));
});

test('managed Hermes restarts an exited worker without submitting or replaying a prompt', async t => {
  const { runtime, children } = harness();
  t.after(() => runtime.close());
  await runtime.ensure();
  const exited = once(children[0]!, 'close');
  children[0]!.kill();
  await exited;
  await runtime.ensure();
  assert.equal(children.length, 2);
});

test('a slow live Hermes service is reported unavailable without killing active work', async t => {
  let fail = false;
  const { runtime, children } = harness({ inspect: options => {
    if (fail) return Promise.reject(new Error('slow'));
    return discoverHermesDashboard(options);
  } });
  t.after(() => runtime.close());
  await runtime.ensure();
  fail = true;
  await assert.rejects(runtime.ensure(), /不会自动重发/);
  assert.equal(children.length, 1);
  assert.equal(children[0]!.exitCode, null);
  fail = false;
  await runtime.ensure();
  assert.equal(children.length, 1);
});

test('closing during cold start cancels readiness and stops the exact worker', async () => {
  const { runtime, children } = harness({}, true);
  const starting = runtime.ensure();
  const rejected = assert.rejects(starting);
  await runtime.close();
  await rejected;
  assert.equal(children.length, 1);
  assert.notEqual(children[0]!.exitCode, null);
});

test('startup timeout stops owned worker and respects failure backoff', async () => {
  const { runtime, children } = harness({ startTimeoutMs: 350, retryDelayMs: 5000 }, true);
  await assert.rejects(runtime.ensure(), /超时/);
  await assert.rejects(runtime.ensure(), /超时/);
  assert.equal(children.length, 1);
  assert.notEqual(children[0]!.exitCode, null);
  await runtime.close();
});

test('a foreign endpoint is rejected even when its port was reported by the child', async () => {
  const { runtime, children } = harness({ inspect: async options => ({
    baseUrl: options!.baseUrl!, token: 'wrong-token', hermesHome: installation.home,
  }) });
  await assert.rejects(runtime.ensure(), /不匹配/);
  assert.notEqual(children[0]!.exitCode, null);
  await runtime.close();
});

test('missing install never launches a process or falls back to desktop discovery', async () => {
  const { runtime, children } = harness({ resolveInstallation: () => { throw new Error('未安装'); } });
  await assert.rejects(runtime.ensure(), /未安装/);
  assert.equal(children.length, 0);
  await runtime.close();
});

test('a missing interpreter reports a controlled startup error and closes cleanly', async () => {
  const runtime = new ManagedHermesRuntime({ resolveInstallation: () => ({ ...installation, python: path.join(os.tmpdir(), 'nonexistent-hermes-python.exe') }), launcher: 'unused' });
  await assert.rejects(runtime.ensure(), /启动失败/);
  await runtime.close();
});

test('child environment is isolated from desktop routing and Windows duplicate variable names', () => {
  const source = { Path: 'first', PATH: 'second', HERMES_HOME: 'original', HERMES_DESKTOP: '1',
    HERMES_DESKTOP_READY_FILE: 'desktop.json', HERMES_DESKTOP_REMOTE_URL: 'http://remote',
    HERMES_DESKTOP_REMOTE_TOKEN: 'secret', PYTHONPATH: 'other', HERMES_DASHBOARD_SESSION_TOKEN: 'old' };
  const result = hermesEnvironment(source, installation, 'new');
  assert.equal(result.PATH, 'first');
  assert.equal(result.Path, undefined);
  assert.equal(result.HERMES_HOME, installation.home);
  assert.equal(result.HERMES_DASHBOARD_SESSION_TOKEN, 'new');
  for (const name of ['HERMES_DESKTOP', 'HERMES_DESKTOP_READY_FILE', 'HERMES_DESKTOP_REMOTE_URL', 'HERMES_DESKTOP_REMOTE_TOKEN', 'PYTHONPATH']) assert.equal(result[name], undefined);
  assert.equal(source.HERMES_HOME, 'original');
});

test('installation discovery honors a named profile and detects incomplete configuration', { skip: process.platform !== 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-hermes-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hermes-agent');
  for (const file of ['hermes_cli/main.py', 'venv/Scripts/python.exe', 'apps/desktop/dist/index.html']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  const env = { HERMES_HOME: home, HERMES_DESKTOP_HERMES_ROOT: root };
  assert.throws(() => findHermesInstallation(env, home), /尚未完成配置/);
  fs.mkdirSync(path.join(home, 'profiles/work'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles/work/config.yaml'), 'model: {}');
  fs.writeFileSync(path.join(home, 'active_profile'), 'work');
  const result = findHermesInstallation(env, home);
  assert.equal(result.home, path.join(home, 'profiles/work'));
  assert.equal(result.root, root);
});
