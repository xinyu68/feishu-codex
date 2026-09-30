import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverHermesDashboard, type HermesDashboardEndpoint } from './hermes-discovery.js';

export type HermesInstallation = { root: string; home: string; python: string; webDist: string };
type Options = {
  resolveInstallation?: () => HermesInstallation;
  launcher?: string;
  startTimeoutMs?: number;
  retryDelayMs?: number;
  inspect?: typeof discoverHermesDashboard;
  launch?: typeof spawn;
  log?: (level: 'info' | 'warn', text: string) => void;
};
type Worker = { process: ChildProcessWithoutNullStreams; exited: Promise<void>; ended?: boolean; stop?: Promise<void>; endpoint?: HermesDashboardEndpoint };

/** A single bridge-owned backend, shared by its Hermes bots and consultation clients. */
export class ManagedHermesRuntime {
  private worker?: Worker;
  private pending?: Promise<HermesDashboardEndpoint>;
  private closed = false;
  private failures = 0;
  private retryAt = 0;
  private lastError = '';
  private stopping = new AbortController();

  constructor(private options: Options = {}) {}

  ensure(): Promise<HermesDashboardEndpoint> {
    if (this.closed) return Promise.reject(new Error('Hermes 服务正在退出。'));
    if (this.pending) return this.pending;
    if (Date.now() < this.retryAt) return Promise.reject(new Error(this.lastError));
    this.pending = this.ensureWorker().then(endpoint => {
      this.failures = 0;
      return endpoint;
    }).catch(error => {
      this.lastError = error instanceof Error ? error.message : 'Hermes 服务启动失败。';
      this.retryAt = Date.now() + Math.min(60_000, (this.options.retryDelayMs ?? 5_000) * 2 ** Math.min(this.failures++, 4));
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    if (this.worker) await this.stop(this.worker);
    await this.pending?.catch(() => undefined);
  }

  private async ensureWorker(): Promise<HermesDashboardEndpoint> {
    if (this.worker) {
      const worker = this.worker;
      if (worker.endpoint && running(worker.process)) {
        try {
          const endpoint = await this.inspect(worker.endpoint.baseUrl);
          if (endpoint.token !== worker.endpoint.token || endpoint.hermesHome !== worker.endpoint.hermesHome) throw new Error('identity mismatch');
          return endpoint;
        }
        catch {
          // An unresponsive live service might still be executing work. Never
          // kill/restart it because one HTTP health request timed out.
          if (running(worker.process)) throw new Error('Hermes 服务暂时未响应，请稍后重试；已提交的任务不会自动重发。');
        }
      }
      await this.stop(worker);
    }
    if (this.closed) throw new Error('Hermes 服务正在退出。');
    const installation = (this.options.resolveInstallation ?? findHermesInstallation)();
    const launcher = this.options.launcher ?? findLauncher();
    const token = randomBytes(32).toString('hex');
    const child = (this.options.launch ?? spawn)(installation.python, ['-u', launcher, installation.root], {
      cwd: installation.root, windowsHide: true,
      env: hermesEnvironment(process.env, installation, token), stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let port: number | undefined;
    let output = '';
    let failed = false;
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { /* Closing a child that already exited is harmless. */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      output = (output + text).slice(-4096);
      const match = /(?:^|\n)HERMES_DASHBOARD_READY port=(\d+)(?:\r?\n)/.exec(output);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) port = Number(match[1]);
      // Native logs can contain provider details; never expose them in UI errors.
    });
    child.stderr.resume();
    const worker: Worker = { process: child, exited: new Promise(resolve => {
      child.once('close', () => { worker.ended = true; resolve(); });
    }) };
    this.worker = worker;
    this.options.log?.('info', '正在启动 Hermes 服务，无需打开 Hermes 桌面。');
    try {
      const deadline = Date.now() + (this.options.startTimeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        if (this.closed) throw new Error('Hermes 服务正在退出。');
        if (failed || !running(child)) throw new Error('Hermes 服务启动失败，请确认已安装完整的 Hermes 并配置好模型；可查看 Hermes 本机日志。');
        if (port) {
          const endpoint = await this.inspect(`http://127.0.0.1:${port}`).catch(() => undefined);
          if (endpoint) {
            if (endpoint.token !== token || canonical(endpoint.hermesHome || '') !== canonical(installation.home)) {
              throw new Error('Hermes 服务身份或配置目录不匹配，已停止本次启动。');
            }
            if (this.closed || !running(child)) throw new Error('Hermes 服务已退出，请稍后重试。');
            worker.endpoint = endpoint;
            this.options.log?.('info', 'Hermes 服务已就绪，由本应用独立管理。');
            child.once('exit', () => {
              if (!worker.stop && !this.closed) this.options.log?.('warn', 'Hermes 服务已退出，将在下次检查时重启；已提交的任务不会自动重发。');
            });
            return endpoint;
          }
        }
        await delay(150, undefined, { signal: this.stopping.signal });
      }
      throw new Error('Hermes 服务启动超时，请检查本机 Hermes 安装及模型配置，稍后重试。');
    } catch (error) {
      await this.stop(worker);
      throw error;
    }
  }

  private inspect(baseUrl: string): Promise<HermesDashboardEndpoint> {
    return (this.options.inspect ?? discoverHermesDashboard)({ baseUrl, timeoutMs: 2_000 });
  }

  private stop(worker: Worker): Promise<void> {
    worker.stop ??= (async () => {
      // EOF also arrives if the bridge crashes. The Python launcher owns a
      // Windows kill-on-close Job, including the backend's tool subprocesses.
      worker.process.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([worker.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 6_000); })]);
        if (!worker.ended && running(worker.process)) {
          worker.process.kill();
          throw new Error('Hermes 服务尚未确认退出，请查看本机进程状态。');
        }
      } finally {
        clearTimeout(timer);
        if (this.worker === worker) this.worker = undefined;
      }
    })();
    return worker.stop;
  }
}

function running(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}
function canonical(value: string): string { return path.resolve(value).toLowerCase(); }
function file(value: string): boolean { try { return fs.statSync(value).isFile(); } catch { return false; } }

export function findHermesInstallation(env = process.env, userHome = os.homedir()): HermesInstallation {
  if (process.platform !== 'win32') throw new Error('自动启动 Hermes 目前支持 Windows；其他系统请配置本机服务地址。');
  const localHome = path.join(env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'), 'hermes');
  let home = path.resolve(env.HERMES_HOME || (file(path.join(localHome, 'config.yaml')) ? localHome : path.join(userHome, '.hermes')));
  const rootHome = path.basename(path.dirname(home)) === 'profiles' ? path.resolve(home, '../..') : home;
  if (home === rootHome) {
    let profile = '';
    try { profile = fs.readFileSync(path.join(rootHome, 'active_profile'), 'utf8').trim(); } catch { /* default profile */ }
    if (profile && profile !== 'default') {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Hermes 当前配置名称无效，请在 Hermes 中重新选择配置。');
      home = path.join(rootHome, 'profiles', profile);
    }
  }
  const roots = [env.HERMES_DESKTOP_HERMES_ROOT, path.join(rootHome, 'hermes-agent'), path.join(localHome, 'hermes-agent'), path.join(userHome, '.hermes', 'hermes-agent')].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    if (!file(path.join(root, 'hermes_cli', 'main.py'))) continue;
    const python = ['venv', '.venv'].map(name => path.join(root, name, 'Scripts', 'python.exe')).find(file);
    const webDist = ['apps/desktop/dist', 'hermes_cli/web_dist'].map(name => path.join(root, name)).find(dir => file(path.join(dir, 'index.html')));
    if (!python || !webDist) continue;
    if (!file(path.join(home, 'config.yaml'))) throw new Error('Hermes 尚未完成配置，请先在 Hermes 中设置模型，再回来连接。');
    return { root: path.resolve(root), home, python, webDist };
  }
  throw new Error('未找到完整的本机 Hermes 安装，请先安装 Hermes 并配置模型；配置后无需保持桌面窗口打开。');
}

export function hermesEnvironment(source: NodeJS.ProcessEnv, installation: HermesInstallation, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const names = new Set<string>();
  const omitted = new Set(['HERMES_DESKTOP', 'HERMES_DESKTOP_READY_FILE', 'HERMES_DESKTOP_REMOTE_URL', 'HERMES_DESKTOP_REMOTE_TOKEN', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH', 'PYTHONHOME']);
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (names.has(name) || omitted.has(name) || value === undefined) continue;
    names.add(name); env[name] = value;
  }
  return { ...env, HERMES_HOME: installation.home, HERMES_WEB_DIST: installation.webDist, HERMES_DASHBOARD_SESSION_TOKEN: token, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function findLauncher(): string {
  for (const relative of ['../scripts/hermes-runtime.py', '../../scripts/hermes-runtime.py']) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url));
    if (file(candidate)) return candidate;
  }
  throw new Error('应用缺少 Hermes 启动组件，请重新安装 Feishu Codex。');
}
