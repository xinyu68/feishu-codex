import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHermesDashboardUrl, type HermesDashboardEndpoint } from './hermes-discovery.js';
import { GROUP_CONSULT_MCP_TIMEOUT_SECONDS } from './group-consult-request.js';

export interface HermesMcpOptions {
  endpoint: HermesDashboardEndpoint;
  command?: string;
  scriptPath?: string;
  profile?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  bridgePort?: number;
}

export interface HermesMcpResult {
  changed: boolean;
  status: 'installed' | 'updated' | 'unchanged';
}

export class HermesMcpError extends Error {
  constructor(public readonly code: 'invalid-runtime' | 'conflict' | 'modified' | 'request' | 'invalid-response', message: string) {
    super(message);
    this.name = 'HermesMcpError';
  }
}

const serverName = 'feishu_completion';
const ownerKey = 'FEISHU_CODEX_MANAGED_MCP';
const modeKey = 'FEISHU_CODEX_MCP_MODE';
const hashKey = 'FEISHU_CODEX_MANAGED_MCP_SHA256';
const installations = new Map<string, Promise<HermesMcpResult>>();
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fingerprint(entry: Json): string {
  const env = { ...(record(entry.env) ? entry.env : {}) };
  delete env[hashKey];
  return createHash('sha256').update(canonical({ ...entry, env })).digest('hex');
}

async function runtimeFile(value: string, node: boolean): Promise<string> {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)
      || (node ? !/^node(?:\.exe)?$/i.test(path.basename(value)) : path.extname(value).toLowerCase() !== '.js')) {
    throw new HermesMcpError('invalid-runtime', node ? 'Hermes MCP 需要现有 Node 可执行文件的绝对路径' : 'Hermes MCP 缺少已安装的 notify-mcp.js 绝对路径');
  }
  const normalized = path.resolve(value);
  if (!(await stat(normalized).catch(() => undefined))?.isFile()) {
    throw new HermesMcpError('invalid-runtime', node ? 'Hermes MCP 的 Node 运行文件不存在，请检查应用安装' : 'Hermes MCP 的构建文件不存在，请先构建或重新安装应用');
  }
  return normalized;
}

async function desiredEntry(options: HermesMcpOptions): Promise<Json> {
  const command = await runtimeFile(options.command ?? (process.env.CODEX_MCP_NODE_PATH || process.execPath), true);
  // The Bridge runs under Node in resources/product/build/server in a packaged
  // install. Source development still targets the compiled server, never .ts.
  const defaultScript = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../build/server/notify-mcp.js' : './notify-mcp.js', import.meta.url));
  const script = await runtimeFile(options.scriptPath ?? defaultScript, false);
  const bridgePort = options.bridgePort ?? Number(process.env.FEISHU_CODEX_PORT || 8790);
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) throw new HermesMcpError('invalid-runtime', '飞书桥接端口无效');
  const env: Json = { [ownerKey]: 'hermes-v1', [modeKey]: 'hermes', FEISHU_CODEX_PORT: String(bridgePort) };
  const entry = { command, args: [script], env, timeout: GROUP_CONSULT_MCP_TIMEOUT_SECONDS };
  env[hashKey] = fingerprint(entry);
  return entry;
}

function assertOwned(entry: Json): void {
  const env = record(entry.env) ? entry.env : {};
  if (env[ownerKey] !== 'hermes-v1') {
    throw new HermesMcpError('conflict', 'Hermes 已有非本应用管理的 feishu_completion MCP，已保留原配置，请先在 Hermes 处理同名冲突');
  }
  if (typeof env[hashKey] !== 'string' || env[hashKey] !== fingerprint(entry)) {
    throw new HermesMcpError('modified', 'Hermes 的 feishu_completion MCP 已被修改或缺少管理摘要，已保留原配置，请先在 Hermes 核对');
  }
}

async function install(options: HermesMcpOptions, baseUrl: string): Promise<HermesMcpResult> {
  const desired = await desiredEntry(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  const suffix = options.profile ? `?profile=${encodeURIComponent(options.profile)}` : '';
  const request = async (route: string, method = 'GET', body?: Json): Promise<Response> => {
    try {
      return await fetcher(`${baseUrl}${route}${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        headers: { 'X-Hermes-Session-Token': options.endpoint.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // Fetch errors can contain URLs, credentials, or another server's config.
      throw new HermesMcpError('request', '无法连接 Hermes 以安装 MCP，请检查 Hermes 桌面服务');
    }
  };
  const json = async (response: Response): Promise<Json> => {
    if (!response.ok) throw new HermesMcpError('request', `Hermes MCP 配置请求失败（HTTP ${response.status}），未继续修改`);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new HermesMcpError('invalid-response', 'Hermes MCP 配置响应无效，未继续修改'); }
    if (!record(value)) throw new HermesMcpError('invalid-response', 'Hermes MCP 配置响应无效，未继续修改');
    return value;
  };
  const list = await json(await request('/api/mcp/servers'));
  if (!Array.isArray(list.servers) || list.servers.some(server => !record(server) || typeof server.name !== 'string')) {
    throw new HermesMcpError('invalid-response', 'Hermes MCP 列表无效，未继续修改');
  }
  const existing = list.servers.filter(server => (server as Json).name === serverName);
  if (existing.length > 1) throw new HermesMcpError('invalid-response', 'Hermes MCP 存在重复条目，未继续修改');
  if (!existing.length) {
    // The dedicated creation endpoint rejects an existing name. A config PUT
    // here would silently adopt a user entry created between the read and write.
    const created = await request('/api/mcp/servers', 'POST', { name: serverName, ...desired });
    if (created.status !== 409) {
      const summary = await json(created);
      if (summary.name !== serverName) throw new HermesMcpError('invalid-response', 'Hermes 未确认 MCP 安装结果，请在 Hermes 核对');
      return { changed: true, status: 'installed' };
    }
  }

  // web_server.py masks every env value in /api/mcp/servers, including our
  // non-secret markers. Only inspect this target from /api/config in memory;
  // never return/log the response or copy its other configuration into a PUT.
  const currentEntry = async (): Promise<Json> => {
    const config = await json(await request('/api/config'));
    const current = record(config.mcp_servers) ? config.mcp_servers[serverName] : undefined;
    if (!record(current)) throw new HermesMcpError('conflict', 'Hermes MCP 配置已变化，请稍后重试');
    assertOwned(current);
    return current;
  };
  const current = await currentEntry();
  if (canonical(current) === canonical(desired)) return { changed: false, status: 'unchanged' };
  // Dashboard has no conditional-write endpoint. Recheck immediately before
  // the narrow merge to catch intervening edits; never delete/recreate entries.
  if (canonical(await currentEntry()) !== canonical(current)) {
    throw new HermesMcpError('conflict', 'Hermes MCP 配置正在变化，已保留现有内容，请稍后重试');
  }
  // PUT /api/config deep-merges config. Sending only our entry preserves all
  // sibling MCP servers and unrelated settings (web_server.py:4400-4413).
  const updated = await json(await request('/api/config', 'PUT', { config: { mcp_servers: { [serverName]: desired } } }));
  if (updated.ok !== true) throw new HermesMcpError('invalid-response', 'Hermes 未确认 MCP 更新结果，请在 Hermes 核对');
  return { changed: true, status: 'updated' };
}

/** Install/update only this Bridge's MCP entry; the caller owns idle-time reload. */
export async function ensureHermesMcp(options: HermesMcpOptions): Promise<HermesMcpResult> {
  const baseUrl = normalizeHermesDashboardUrl(options.endpoint.baseUrl);
  if (!options.endpoint.token || /[\r\n]/.test(options.endpoint.token)) {
    throw new HermesMcpError('request', 'Hermes 连接凭据无效，请重新连接 Hermes');
  }
  const key = `${baseUrl}/${options.profile || ''}`;
  const previous = installations.get(key);
  const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => install(options, baseUrl));
  installations.set(key, operation);
  try { return await operation; }
  finally { if (installations.get(key) === operation) installations.delete(key); }
}
