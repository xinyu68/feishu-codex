import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { canonicalEnvironment } from './lifecycle.mjs';
import { powershell, readJson } from './windows.mjs';

const ACTIVE = new Set(['starting', 'waiting_for_elevation', 'waiting_for_codex', 'running', 'migrating']);
export const migrationActive = state => ACTIVE.has(state?.status);

export class MigrationRunner {
  constructor({ productRoot, dataDir, onChange = () => {} }) {
    this.productRoot = productRoot;
    this.dataDir = dataDir;
    this.statusFile = path.join(dataDir, 'desktop', 'migration-status.json');
    this.logFile = path.join(dataDir, 'desktop', 'migration.log');
    this.onChange = onChange;
    this.child = null;
    this.state = null;
    this.starting = false;
  }

  async refresh() {
    const saved = await readJson(this.statusFile).catch(() => null);
    if (saved && (!this.state?.runId || saved.runId === this.state.runId)) {
      // A local process exit result must not be overwritten by its last heartbeat.
      if (!this.state?.finishedAt || !migrationActive(saved)) this.state = saved;
    }
    if (!this.child && migrationActive(this.state)) {
      const age = Date.now() - Date.parse(this.state.updatedAt);
      let processExists = false;
      if (Number.isInteger(this.state.pid) && this.state.pid > 0) {
        try { process.kill(this.state.pid, 0); processExists = true; } catch (error) { processExists = error.code !== 'ESRCH'; }
      }
      if (!processExists && (!Number.isFinite(age) || age > 15_000)) {
        this.state = { ...this.state, status: 'failed', finishedAt: new Date().toISOString(),
          message: '上次接管已中断。请查看接管日志，确认状态后重试。' };
      }
    }
    return this.state;
  }

  async start(nodePath) {
    if (this.starting || this.child) return { ok: true, migration: this.state };
    this.starting = true;
    try {
      if (migrationActive(await this.refresh())) throw new Error('已有接管正在进行，请等待当前步骤完成。');
      const script = path.join(this.productRoot, 'scripts', 'desktop-migration-launch.ps1');
      await fs.access(script); await fs.access(nodePath);
      await fs.mkdir(path.dirname(this.statusFile), { recursive: true });
      const now = new Date().toISOString();
      this.state = { runId: randomUUID(), status: 'starting', phase: 'launch', startedAt: now, updatedAt: now,
        message: '正在启动接管检查，进度会显示在这里。' };
      await fs.writeFile(this.statusFile, JSON.stringify(this.state, null, 2));
      await fs.appendFile(this.logFile, `\n[${now}] 开始接管 ${this.state.runId}\n`);
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-ProductRoot', this.productRoot, '-NodePath', nodePath, '-DataDir', this.dataDir,
        '-NonInteractive', '-WaitForDesktopExit', '-StatusFile', this.statusFile, '-RunId', this.state.runId], {
        windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      let tail = '';
      let logQueue = Promise.resolve();
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const capture = chunk => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-4000);
        logQueue = logQueue.then(() => fs.appendFile(this.logFile, text)).catch(() => {});
      };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.once('close', async code => {
        await logQueue;
        await this.refresh();
        if (this.state?.status !== 'succeeded' && this.state?.status !== 'failed') {
          this.state = { ...this.state, status: 'failed', exitCode: code, finishedAt: new Date().toISOString(),
            message: `接管程序已退出（${code ?? '未知'}），尚未完成。${tail.trim() ? `\n${tail.trim().slice(-1200)}` : '请查看接管日志后重试。'}` };
        }
        if (this.child === child) this.child = null;
        this.onChange();
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      this.onChange();
      return { ok: true, migration: this.state };
    } catch (error) {
      this.state = { ...this.state, status: 'failed', finishedAt: new Date().toISOString(), message: `无法启动接管：${error.message}` };
      if (!this.child?.pid) this.child = null;
      this.onChange();
      throw error;
    } finally { this.starting = false; }
  }
}
