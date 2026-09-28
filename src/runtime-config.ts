import fs from 'node:fs';
import path from 'node:path';

export type RuntimeConfig = { mode: 'per-turn' | 'shared'; websocketUrl?: string };

export function readRuntimeConfig(dataDir: string, override = process.env.FEISHU_CODEX_WS_URL): RuntimeConfig {
  if (override !== undefined) return { mode: 'shared', websocketUrl: validateSharedUrl(override) };
  const file = path.join(dataDir, 'runtime.json');
  if (!fs.existsSync(file)) return { mode: 'per-turn' };
  let config: unknown;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('runtime.json 无法读取，请修复运行配置后启动；不会自动退回独立进程。'); }
  if (!config || typeof config !== 'object') throw new Error('runtime.json 运行配置无效');
  const saved = config as Record<string, unknown>;
  if (saved.mode === 'per-turn') return { mode: 'per-turn' };
  if (saved.mode !== 'shared') throw new Error('runtime.json mode 必须是 per-turn 或 shared');
  return { mode: 'shared', websocketUrl: validateSharedUrl(saved.wsUrl) };
}

function validateSharedUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('本机 Codex 服务缺少连接地址');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('本机 Codex 服务地址无效'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1'
    || url.username || url.password || url.search || url.hash || url.pathname !== '/' || Number(url.port) < 1024) {
    throw new Error('本机 Codex 服务必须使用本机回环 WebSocket 地址和明确端口');
  }
  return url.toString();
}
