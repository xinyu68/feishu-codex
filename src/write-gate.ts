import fs from 'node:fs';
import path from 'node:path';

export type DesktopRuntimeStatus = {
  version?: number;
  pid?: number;
  state: string;
  canWrite: boolean;
  reason?: string;
  runtime?: { state: string; pid?: number };
  bridge?: { state: string; pid?: number };
  desktop?: { mode: string; pids: number[] };
  updatedAt?: string;
};

const STALE_AFTER_MS = 15_000;

/** A missing heartbeat must never silently switch a managed bridge to its own writer. */
export function readDesktopRuntimeStatus(file = process.env.FEISHU_CODEX_WRITE_GATE_FILE, now = Date.now()): DesktopRuntimeStatus {
  if (!file) return { state: 'standalone', canWrite: true, desktop: { mode: 'unknown', pids: [] } };
  const unavailable = (reason: string): DesktopRuntimeStatus => ({ state: 'unavailable', canWrite: false, reason });
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!saved || typeof saved !== 'object') return unavailable('后台状态无效，请在应用中重试连接。');
    const at = Date.parse(saved.updatedAt);
    if (!Number.isFinite(at) || now - at > STALE_AFTER_MS || at - now > 5000) return unavailable('后台连接已中断，恢复后可继续发送；已经提交的指令不会自动重发。');
    const component = (value: unknown) => {
      if (!value || typeof value !== 'object') return undefined;
      const item = value as Record<string, unknown>;
      return { state: typeof item.state === 'string' ? item.state : 'unknown', ...(Number.isSafeInteger(item.pid) && Number(item.pid) > 0 ? { pid: Number(item.pid) } : {}) };
    };
    return {
      version: Number(saved.version) || 1,
      ...(Number.isSafeInteger(saved.pid) && saved.pid > 0 ? { pid: saved.pid } : {}),
      state: typeof saved.state === 'string' ? saved.state : 'unknown',
      canWrite: saved.canWrite === true,
      ...(typeof saved.reason === 'string' ? { reason: saved.reason.slice(0, 1000) } : {}),
      runtime: component(saved.runtime), bridge: component(saved.bridge),
      desktop: { mode: typeof saved.desktop?.mode === 'string' ? saved.desktop.mode : 'unknown', pids: Array.isArray(saved.desktop?.pids) ? saved.desktop.pids.filter((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0) : [] },
      updatedAt: new Date(at).toISOString(),
    };
  } catch { return unavailable('Codex 服务尚未就绪，请在应用中查看连接状态。'); }
}

export async function assertWriteAllowed(file = process.env.FEISHU_CODEX_WRITE_GATE_FILE): Promise<void> {
  const status = readDesktopRuntimeStatus(file);
  if (!status.canWrite) throw new Error(status.reason || '当前暂时不能发送消息，请先恢复连接。');
  if (!file) return;
  let control: { port: number; token: string; pid: number };
  try { control = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'host-control.json'), 'utf8')); }
  catch { throw new Error('无法确认后台连接，消息尚未提交，请在应用中重试。'); }
  if (!control || typeof control !== 'object' || !Number.isInteger(control.port) || control.port < 1024 || control.port > 65535 || typeof control.token !== 'string' || control.token.length < 32 || control.pid !== status.pid) throw new Error('后台身份已变化，请恢复连接后重试。');
  let result: { canWrite: boolean; reason?: string };
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/control`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Host-Token': control.token },
      body: JSON.stringify({ action: 'checkWrite' }), signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error();
    result = await response.json() as typeof result;
  } catch { throw new Error('后台暂时无法确认桌面状态，消息尚未提交，请稍后重试。'); }
  if (!result || typeof result !== 'object') throw new Error('后台返回了无效状态，消息尚未提交。');
  if (result.canWrite !== true) throw new Error(typeof result.reason === 'string' ? result.reason : '当前 Codex 未接入飞书，请在 Feishu Codex 中点击“连接飞书”。');
}
