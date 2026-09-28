import path from 'node:path';

export function canonicalEnvironment(source, overrides = {}) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith('=')) continue;
    const normalized = key.toUpperCase();
    if (!(normalized in result) || key === normalized) result[normalized] = String(value);
  }
  delete result.ELECTRON_RUN_AS_NODE;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete result[key.toUpperCase()];
    else result[key.toUpperCase()] = String(value);
  }
  return result;
}

export function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

export function sameProcess(expected, actual) {
  return Boolean(expected && actual && Number(expected.pid) === Number(actual.pid)
    && expected.startedAt === actual.startedAt && samePath(expected.exe, actual.exe));
}

export function recordedProcessState(expected, processes) {
  if (!expected?.pid || !expected.startedAt || !expected.exe) return 'unknown';
  const actual = processes.find(item => item.pid === expected.pid);
  if (!actual) return 'dead';
  if (!actual.startedAt) return 'unknown';
  if (actual.startedAt !== expected.startedAt) return 'dead';
  return sameProcess(expected, actual) ? 'alive' : 'unknown';
}

export function canRetireReusedIdentity(expected, actual, entry, listeners, runtimeUrl) {
  if (!expected || !actual || expected.pid !== actual.pid || !actual.startedAt || actual.startedAt === expected.startedAt || listeners.length) return false;
  if (actual.exe && !samePath(expected.exe, actual.exe)) return true;
  if (!actual.commandLine) return false;
  if (entry) return !matchesEntry(actual, entry);
  return runtimeUrl ? !(/\bapp-server\b/.test(actual.commandLine) && actual.commandLine.includes(runtimeUrl)) : false;
}

export function matchesEntry(process, entry) {
  if (!process?.commandLine || !entry) return false;
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)"?${escaped}(?:"|\\s|$)`, 'i').test(process.commandLine);
}

export function desktopMode(snapshot, sharedPort, launched) {
  const roots = snapshot.desktopRoots ?? [];
  if (snapshot.unknownDesktop) return { mode: 'unknown', pids: [], reason: '无法确认正在运行的 Codex 身份，已暂停发送。' };
  if (!roots.length) return { mode: 'closed', pids: [], reason: '' };
  let shared = 0;
  for (const root of roots) {
    const tree = new Set([root.pid]);
    let changed;
    do {
      changed = false;
      for (const item of snapshot.processes) {
        if (tree.has(item.parentPid) && !tree.has(item.pid)) { tree.add(item.pid); changed = true; }
      }
    } while (changed);
    const independent = snapshot.processes.some(item => tree.has(item.pid)
      && /(?:^|[\\/])codex\.exe$/i.test(item.exe ?? '') && /\bapp-server\b/.test(item.commandLine ?? ''));
    if (independent) return { mode: 'independent', pids: roots.map(item => item.pid), reason: 'Codex 尚未连接飞书。请点击“连接飞书”，确认后将自动重启。' };
    const connected = snapshot.connections?.some(item => tree.has(item.pid) && item.remotePort === sharedPort && item.remoteAddress === '127.0.0.1');
    if (connected || sameProcess(launched, root)) shared++;
  }
  if (shared === roots.length && roots.length === 1) return { mode: 'shared', pids: roots.map(item => item.pid), reason: '' };
  return { mode: 'unknown', pids: roots.map(item => item.pid), reason: 'Codex 的连接方式尚未确认，暂时停止发送。' };
}

export class RestartBudget {
  failures = [];
  nextAt = 0;
  constructor({ maxFailures = 5, windowMs = 300_000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.now = now;
  }
  failed() {
    const now = this.now();
    this.failures = this.failures.filter(at => now - at < this.windowMs);
    this.failures.push(now);
    this.nextAt = now + Math.min(30_000, 1_000 * 2 ** (this.failures.length - 1));
  }
  get blocked() { return this.failures.length >= this.maxFailures; }
  get ready() { return !this.blocked && this.now() >= this.nextAt; }
  reset() { this.failures = []; this.nextAt = 0; }
  stable() { this.failures = this.failures.filter(at => this.now() - at < this.windowMs); }
}

export function writePermission({ runtime, bridge, desktop, stopping = false }) {
  if (stopping) return { canWrite: false, reason: '后台正在退出。' };
  if (['independent', 'unknown'].includes(desktop.mode)) return { canWrite: false, reason: desktop.reason };
  if (runtime.state !== 'ready') return { canWrite: false, reason: runtime.error || 'Codex 服务尚未就绪，消息不会自动重发。' };
  if (bridge.state !== 'ready') return { canWrite: false, reason: bridge.error || '飞书服务尚未就绪。' };
  return { canWrite: true, reason: '' };
}
