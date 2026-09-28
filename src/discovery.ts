import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project, ThreadSummary } from './types.js';

type Row = Record<string, unknown>;
type IndexedThread = ThreadSummary & { source: string };
const cache = new Map<string, { until: number; threads: ThreadSummary[] }>();

export function codexHomeDirectory(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Resolve existing directory casing and Windows extended paths before comparison. */
export function normalizeWorkspace(cwd: string): string {
  let normalized = cwd.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  if (/^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\')) normalized = path.win32.normalize(normalized);
  else normalized = path.resolve(normalized);
  try { normalized = realpathSync.native(normalized); } catch { /* Missing historic workspaces remain discoverable. */ }
  return normalized.replace(/([\\/])$/, (separator) => /^[A-Za-z]:[\\/]$/.test(normalized) || normalized === '/' ? separator : '');
}

function workspaceKey(cwd: string): string {
  const normalized = normalizeWorkspace(cwd);
  return process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\')
    ? normalized.toLowerCase() : normalized;
}

export async function discoverProjects(codexHome = codexHomeDirectory()): Promise<Project[]> {
  const projects = new Map<string, Project>();
  for (const thread of await discoverAll(codexHome)) {
    const key = workspaceKey(thread.cwd);
    const project = projects.get(key);
    if (project) {
      project.threadCount++;
      if (thread.updatedAt > project.lastActiveAt) project.lastActiveAt = thread.updatedAt;
    } else {
      const pathApi = /^[A-Za-z]:[\\/]/.test(thread.cwd) || thread.cwd.startsWith('\\\\') ? path.win32 : path;
      projects.set(key, { path: thread.cwd, name: pathApi.basename(thread.cwd) || thread.cwd, threadCount: 1, lastActiveAt: thread.updatedAt });
    }
  }
  return [...projects.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

export async function discoverThreads(cwd: string, codexHome = codexHomeDirectory()): Promise<ThreadSummary[]> {
  const key = workspaceKey(cwd);
  return (await discoverAll(codexHome)).filter(thread => workspaceKey(thread.cwd) === key);
}

async function discoverAll(codexHome: string): Promise<ThreadSummary[]> {
  const cached = cache.get(codexHome);
  if (cached && cached.until > Date.now()) return cached.threads;
  let threads = await readDatabase(codexHome);
  // The app-server database includes desktop paginated histories whose JSONL files do not
  // contain all messages. Only fall back on JSONL for installations without a readable index.
  if (threads === undefined) threads = await readRollouts(codexHome);
  const deduplicated = new Map<string, ThreadSummary>();
  for (const thread of threads) {
    if (!thread.id || !thread.cwd || /subagent|thread_spawn/i.test(thread.source)) continue;
    const existing = deduplicated.get(thread.id);
    if (!existing || existing.updatedAt < thread.updatedAt) {
      const { source: _source, ...summary } = thread;
      deduplicated.set(thread.id, summary);
    }
  }
  const result = [...deduplicated.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  cache.set(codexHome, { until: Date.now() + 5_000, threads: result });
  return result;
}

async function readDatabase(codexHome: string): Promise<IndexedThread[] | undefined> {
  let files: string[];
  try { files = (await fs.readdir(codexHome)).filter(file => /^state_\d+\.sqlite$/.test(file)); }
  catch { return undefined; }
  files.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
  for (const file of files) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path.join(codexHome, file), { readOnly: true });
      const columns = new Set((database.prepare('PRAGMA table_info(threads)').all() as Row[]).map(row => row.name));
      if (!columns.has('id') || !columns.has('cwd')) continue;
      // Select only fixed known identifiers: never interpolate file content into SQL.
      const fields = ['id', 'cwd', 'title', 'name', 'preview', 'first_user_message', 'rollout_path', 'updated_at', 'updated_at_ms', 'recency_at_ms', 'source', 'thread_source', 'agent_path'];
      const selected = fields.filter(field => columns.has(field));
      const rows = (database.prepare(`SELECT ${selected.join(', ')} FROM threads`).all() as Row[]).filter(row => text(row.id) && text(row.cwd));
      const results: IndexedThread[] = [];
      for (let offset = 0; offset < rows.length; offset += 16) {
        results.push(...await Promise.all(rows.slice(offset, offset + 16).map(async row => {
          const source = [text(row.source), text(row.thread_source), text(row.agent_path) && text(row.agent_path) !== '/root' ? 'subagent' : ''].join(' ');
          const title = cleanBridgeText(text(row.name)) || cleanBridgeText(text(row.title)) || cleanBridgeText(text(row.first_user_message));
          const summary = cleanBridgeText(text(row.preview)) || cleanBridgeText(text(row.first_user_message));
          const polluted = [row.name, row.title, row.preview, row.first_user_message].some(value => isBridgePreamble(text(value).trim()));
          // Indexed titles can be truncated before the real question. Read only the bounded
          // header/tail of that specific rollout when no useful indexed text remains.
          const recovered = polluted && (!title || !summary) && !/subagent|thread_spawn/i.test(source)
            ? await readRolloutText(text(row.rollout_path)) : [];
          return {
            id: text(row.id), cwd: normalizeWorkspace(text(row.cwd)),
            title: preview(title || recovered[0] || '') || `会话 ${text(row.id).slice(0, 8)}`,
            preview: preview(summary || recovered.at(-1) || ''),
            updatedAt: timestamp(row.recency_at_ms || row.updated_at_ms || Number(row.updated_at) * 1_000), source,
          };
        })));
      }
      return results;
    } catch { /* A migrating or older index can be read from the rollout fallback. */ }
    finally { database?.close(); }
  }
  return undefined;
}

async function readRollouts(codexHome: string): Promise<IndexedThread[]> {
  const names = new Map<string, { title: string; updatedAt: string }>();
  try {
    for (const line of (await fs.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8')).split('\n')) {
      try {
        const row = JSON.parse(line) as Row;
        if (text(row.id)) names.set(text(row.id), { title: text(row.thread_name), updatedAt: timestamp(row.updated_at) });
      } catch { /* An interrupted final line is harmless. */ }
    }
  } catch { /* The index is optional. */ }
  const files: string[] = [];
  const directories = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  while (directories.length) {
    const directory = directories.pop()!;
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(directory, entry.name));
      }
    } catch { /* Missing or unreadable directories are skipped individually. */ }
  }
  const results: IndexedThread[] = [];
  // Limit open file handles without excluding older projects from discovery.
  for (let offset = 0; offset < files.length; offset += 16) {
    const batch = await Promise.all(files.slice(offset, offset + 16).map(async file => {
      const descriptor = await fs.open(file, 'r').catch(() => undefined);
      if (!descriptor) return undefined;
      try {
        const stats = await descriptor.stat();
        const header = Buffer.alloc(Math.min(stats.size, 1024 * 1024));
        await descriptor.read(header, 0, header.length, 0);
        const event = JSON.parse(header.toString('utf8').split('\n')[0]!) as Row;
        const meta = asRecord(event.payload);
        if (event.type !== 'session_meta' || !text(meta.cwd)) return undefined;
        const id = text(meta.id) || text(meta.session_id);
        const source = [text(meta.thread_source), JSON.stringify(meta.source), text(meta.parent_thread_id) && 'subagent'].join(' ');
        if (/subagent|thread_spawn/i.test(source)) return undefined;
        const tail = Buffer.alloc(Math.min(stats.size, 256 * 1024));
        await descriptor.read(tail, 0, tail.length, Math.max(0, stats.size - tail.length));
        const userTexts = [...extractUserTexts(header.toString('utf8')), ...extractUserTexts(tail.toString('utf8'))];
        const firstText = userTexts[0] || '';
        const lastText = userTexts.at(-1) || '';
        const indexed = names.get(id);
        return { id, cwd: normalizeWorkspace(text(meta.cwd)), source,
          title: preview(cleanBridgeText(indexed?.title || '') || firstText) || `会话 ${id.slice(0, 8)}`,
          preview: preview(lastText), updatedAt: indexed && indexed.updatedAt > stats.mtime.toISOString() ? indexed.updatedAt : stats.mtime.toISOString() };
      } catch { return undefined; }
      finally { await descriptor.close(); }
    }));
    for (const thread of batch) if (thread) results.push(thread);
  }
  return results;
}

function timestamp(value: unknown): string {
  const date = new Date(typeof value === 'number' || typeof value === 'string' ? value : 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function asRecord(value: unknown): Row { return value && typeof value === 'object' ? value as Row : {}; }
function preview(value: string): string { return value.replace(/\s+/g, ' ').trim().slice(0, 180); }

/** Presentation only: never rewrite the original Codex rollout or its database. */
export function cleanBridgeText(input: string): string {
  let value = input.trim();
  if (/^(?:【(?:飞书消息|本地预览)】|This message (?:arrived through Feishu \(Lark\)\.|is a local preview of a Feishu conversation\.))/.test(value)) {
    const separator = /\r?\n\s*\r?\n/.exec(value);
    value = separator ? value.slice(separator.index + separator[0].length).trim() : '';
  } else if (isBridgePreamble(value)) {
    const example = /```codex-(?:channel-bridge|weixin(?:-server)?)-actions\s*\r?\n[\s\S]*?\r?\n```/.exec(value);
    value = example ? value.slice(example.index + example[0].length).trim() : '';
  }
  if (value.startsWith('[codex-weixin-private-knowledge]')) {
    const end = '[/codex-weixin-private-knowledge]';
    const index = value.indexOf(end);
    value = index < 0 ? '' : value.slice(index + end.length).trim();
  }
  return value.replace(
    /^\[(WeChat|WeCom|Feishu|Web) (file|image|video|audio): (.+) saved to .+]\r?\nInspect the saved local attachment before answering\.$/gm,
    (_match, _source, kind: string, name: string) => `${({ file: '文件', image: '图片', video: '视频', audio: '音频' } as Record<string, string>)[kind]}：${name}`,
  ).trim();
}

function isBridgePreamble(value: string): boolean {
  return /^(?:【(?:飞书消息|本地预览)】|This message arrived through (?:Feishu \(Lark\)|WeChat|WeCom|Web)|This message is a local preview of a Feishu conversation|WeChat bridge rule:|\[codex-weixin-private-knowledge\])/.test(value);
}

function extractUserTexts(content: string): string[] {
  const result: string[] = [];
  for (const line of content.split('\n')) {
    try {
      const event = JSON.parse(line) as Row;
      const payload = asRecord(event.payload);
      let userText = '';
      if (event.type === 'event_msg' && payload.type === 'user_message') userText = text(payload.message);
      else if (event.type === 'response_item' && payload.role === 'user' && Array.isArray(payload.content)) {
        const kinds = asRecord(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
        if (Array.isArray(kinds)) userText = payload.content.map((item, index) => kinds[index] === 'user.text' ? text(asRecord(item).text) : '').filter(Boolean).join('\n');
        else {
          const candidate = payload.content.map(item => text(asRecord(item).text)).filter(Boolean).join('\n');
          if (isBridgePreamble(candidate.trim())) userText = candidate;
        }
      }
      const cleaned = cleanBridgeText(userText);
      if (cleaned) result.push(cleaned);
    } catch { /* The buffer may start or end in the middle of a line. */ }
  }
  return result;
}

async function readRolloutText(file: string): Promise<string[]> {
  if (!file) return [];
  const descriptor = await fs.open(file, 'r').catch(() => undefined);
  if (!descriptor) return [];
  try {
    const { size } = await descriptor.stat();
    const header = Buffer.alloc(Math.min(size, 1024 * 1024));
    await descriptor.read(header, 0, header.length, 0);
    if (size <= header.length) return extractUserTexts(header.toString('utf8'));
    const tail = Buffer.alloc(Math.min(size, 256 * 1024));
    await descriptor.read(tail, 0, tail.length, size - tail.length);
    return [...extractUserTexts(header.toString('utf8')), ...extractUserTexts(tail.toString('utf8'))];
  } catch { return []; }
  finally { await descriptor.close(); }
}
