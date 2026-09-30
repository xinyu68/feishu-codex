import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { canonicalEnvironment } from './lifecycle.mjs';

export const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

export function runWindowlessScript(script, args = [], { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(wscript, ['//B', '//NoLogo', script, ...args.map(String)], {
      windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore',
    });
    let settled = false;
    const finish = operation => { if (settled) return; settled = true; clearTimeout(timer); operation(); };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Windows 无窗口操作超时。')));
    }, timeout);
    child.once('error', error => finish(() => reject(error)));
    child.once('exit', code => finish(() => code === 0 ? resolve() : reject(new Error(`Windows 无窗口操作失败（${code ?? 'unknown'}）。`))));
  });
}

export function runPowerShell(script, args = [], { timeout = 30_000, interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', ...(interactive ? [] : ['-NonInteractive', '-WindowStyle', 'Hidden']), '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], {
      windowsHide: !interactive, env: canonicalEnvironment(process.env), stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    // PowerShell helpers emit UTF-8. Decode across chunk boundaries so a split
    // Chinese character is not replaced before the next buffer arrives.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', value => { stdout += value; if (stdout.length > 8_000_000) child.kill(); });
    child.stderr?.on('data', value => { stderr += value; if (stderr.length > 1_000_000) child.kill(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows 操作超时；未终止 Codex 或服务。')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Windows 操作失败（${code}）`));
    });
  });
}

const inspectorWorkers = new Map();
let inspectorRequestId = 0;

class InspectorWorker {
  constructor(script) {
    this.script = script;
    this.pending = new Map();
    this.stderr = '';
    this.failed = false;
    this.child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-Server'], {
      windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.unref();
    this.child.stdin.unref?.(); this.child.stdout.unref?.(); this.child.stderr.unref?.();
    this.ready = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.onLine(line));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-64_000); });
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', code => this.fail(new Error(this.stderr.trim() || `Windows 检查进程已退出（${code ?? 'unknown'}）`)));
  }

  onLine(line) {
    let response;
    try { response = JSON.parse(line); }
    catch { this.fail(new Error('Windows 检查进程返回了无效数据。')); return; }
    const request = this.pending.get(String(response.id));
    if (!request) return;
    this.pending.delete(String(response.id)); clearTimeout(request.timer);
    if (response.ok && response.result) request.resolve(response.result);
    else request.reject(new Error(response.error || 'Windows 检查失败。'));
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    if (inspectorWorkers.get(this.script) === this) inspectorWorkers.delete(this.script);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.lines.close();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  async request(ports, processIds, timeout = 20_000) {
    await this.ready;
    if (this.failed) throw new Error('Windows 检查进程不可用。');
    const id = String(++inspectorRequestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Windows 检查超时。')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ports: ports.join(','), processIds: processIds.join(',') })}\n`, error => {
        if (error) this.fail(error);
      });
    });
  }

  close() { this.fail(new Error('Windows 检查进程已关闭。')); }
}

export async function inspectWindows(root, ports, processIds = []) {
  const ids = processIds.filter(value => Number.isInteger(value) && value > 0);
  const script = path.join(root, 'scripts', 'desktop-inspect.ps1');
  let worker = inspectorWorkers.get(script);
  if (!worker || worker.failed) { worker = new InspectorWorker(script); inspectorWorkers.set(script, worker); }
  return worker.request(ports, ids);
}

export function closeWindowsInspectors() {
  for (const worker of inspectorWorkers.values()) worker.close();
  inspectorWorkers.clear();
}

process.once('exit', closeWindowsInspectors);

const jsonWrites = new Map();
const transientRenameErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function atomicJson(file, value) {
  // Capture the caller's value before waiting for an earlier publication.
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const destination = path.resolve(file);
  const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
  const previous = jsonWrites.get(key) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, { mode: 0o600 });
      const deadline = performance.now() + 1_500;
      let delay = 25;
      for (;;) {
        try { await fs.rename(temporary, destination); break; }
        catch (error) {
          const remaining = deadline - performance.now();
          if (!transientRenameErrors.has(error.code) || remaining <= 0) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)));
          delay = Math.min(delay * 2, 200);
        }
      }
    } finally {
      // Never remove the destination: a failed replacement retains its last
      // complete value, including while Windows readers temporarily deny delete.
      await fs.unlink(temporary).catch(() => {});
    }
  });
  jsonWrites.set(key, write);
  try { await write; }
  finally { if (jsonWrites.get(key) === write) jsonWrites.delete(key); }
}

export async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function stopVerified(root, dataDir, identity, port = 0) {
  const file = path.join(dataDir, 'desktop', `stop-${randomUUID()}.json`);
  await atomicJson(file, identity);
  try { await runPowerShell(path.join(root, 'scripts', 'desktop-stop-owned.ps1'), ['-IdentityFile', file, '-Port', port], { timeout: 30_000 }); }
  finally { await fs.unlink(file).catch(() => {}); }
}

export async function closeWindowVerified(root, dataDir, identity) {
  const file = path.join(dataDir, 'desktop', `close-${randomUUID()}.json`);
  await atomicJson(file, identity);
  try { await runPowerShell(path.join(root, 'scripts', 'desktop-close-window.ps1'), ['-IdentityFile', file], { timeout: 15_000 }); }
  finally { await fs.unlink(file).catch(() => {}); }
}

export async function captureProcessTree(root, dataDir, identity) {
  const file = path.join(dataDir, 'desktop', `tree-${randomUUID()}.json`);
  await atomicJson(file, identity);
  try {
    const tree = JSON.parse(await runPowerShell(path.join(root, 'scripts', 'desktop-capture-tree.ps1'), ['-IdentityFile', file]));
    return { ...identity, tree };
  } finally { await fs.unlink(file).catch(() => {}); }
}
