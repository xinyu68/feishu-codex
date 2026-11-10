import { samePath, sameProcess } from './lifecycle.mjs';

function storeVersion(exe) {
  const match = typeof exe === 'string' && /[\\/]WindowsApps[\\/]OpenAI\.Codex_(\d+(?:\.\d+){3})_x64__2p2nqsd0c76g0[\\/]app[\\/](?:ChatGPT|Codex)\.exe$/i.exec(exe);
  return match ? match[1].split('.').map(Number) : null;
}

function newerPackage(previous, current) {
  const a = storeVersion(previous), b = storeVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

// Only a package upgrade following an observed shared desktop grants recovery
// intent. Ordinary window closes and independently opened desktops do not.
export class CodexUpdateRecovery {
  constructor({ now = Date.now, timeoutMs = 300_000, retryMs = 5_000 } = {}) {
    this.now = now; this.timeoutMs = timeoutMs; this.retryMs = retryMs;
    this.previous = null; this.lastSharedAt = 0; this.pending = null; this.finishedPackage = null;
  }
  observe(snapshot, mode, launched) {
    const roots = snapshot.desktopRoots || [];
    const own = roots.length === 1 && mode.mode === 'shared' ? roots[0] : roots.find(root => sameProcess(root, launched));
    if (mode.mode === 'shared' && own && !this.pending) { this.previous = { ...own }; this.lastSharedAt = this.now(); }
    const exe = snapshot.desktopPackagePath;
    if (!this.pending && this.previous && this.now() - this.lastSharedAt <= this.timeoutMs && newerPackage(this.previous.exe, exe)
      && !samePath(this.finishedPackage, exe)
      && !snapshot.processes.some(process => sameProcess(process, this.previous))) {
      this.pending = { exe, detectedAt: this.now(), deadlineAt: this.now() + this.timeoutMs, nextAt: 0, failures: 0 };
    }
    if (!this.pending) return null;
    if (mode.mode === 'shared' && roots.length === 1 && samePath(roots[0].exe, this.pending.exe)) {
      this.finish(); return null;
    }
    if (this.now() > this.pending.deadlineAt) return { state: 'expired', message: 'Codex 更新后的自动连接未完成，请点击“重试连接”。' };
    return { state: 'recovering', message: this.pending.waiting ? 'Codex 已更新，等待进行中的任务结束后自动恢复连接。' : '检测到 Codex 已更新，正在恢复飞书连接。' };
  }
  action(snapshot, mode) {
    const pending = this.pending;
    if (!pending || this.now() < pending.nextAt || this.now() > pending.deadlineAt) return null;
    if (snapshot.unknownDesktop || (snapshot.desktopRoots || []).length > 1) return null;
    if (mode.mode === 'closed') return { kind: 'open' };
    const root = snapshot.desktopRoots?.[0];
    // An update relaunch is accepted only during the recovery window and only
    // for the registered new package. Never adopt a much older independent app.
    const started = Date.parse(root?.startedAt);
    if (mode.mode === 'independent' && samePath(root?.exe, pending.exe) && Number.isFinite(started)
      && started >= pending.detectedAt - 90_000 && started <= Math.min(this.now(), pending.detectedAt + 90_000)) return { kind: 'reconnect', desktop: { ...root } };
    return null;
  }
  retry() { if (this.pending) { this.pending.deadlineAt = this.now() + this.timeoutMs; this.pending.nextAt = 0; this.pending.failures = 0; } }
  waitForTasks() { if (this.pending) { this.pending.deadlineAt = this.now() + this.timeoutMs; this.pending.waiting = true; } }
  resume() { if (this.pending) this.pending.waiting = false; }
  failed() { if (this.pending) { this.pending.failures++; this.pending.nextAt = this.now() + Math.min(30_000, this.retryMs * 2 ** (this.pending.failures - 1)); } }
  finish() { if (this.pending) this.finishedPackage = this.pending.exe; this.pending = null; }
}
