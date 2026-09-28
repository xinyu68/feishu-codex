import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const PIPE_DIRECTORY = '\\\\.\\pipe\\';
const APP_PIPE_PATTERN = /^codex-browser-use-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DesktopToolsRelayOptions {
  preferredPipePath?: string;
  probeTimeoutMs?: number;
  connectTimeoutMs?: number;
  discoverPipePaths?: () => Promise<string[]>;
  onDiagnostic?: (message: string) => void;
}

export interface DesktopToolsRelay {
  path: string;
  close(): Promise<void>;
}

/** Keep the daemon's endpoint stable while each Desktop launch creates its own pipe. */
export async function startDesktopToolsRelay(stablePath: string, options: DesktopToolsRelayOptions = {}): Promise<DesktopToolsRelay> {
  if (!stablePath) throw new Error('Desktop tools relay requires a pipe path');
  const probeTimeout = boundedTimeout(options.probeTimeoutMs, 400);
  const connectTimeout = boundedTimeout(options.connectTimeoutMs, 500);
  const preferred = options.preferredPipePath ?? process.env.CODEX_APP_TOOLS_PIPE_PATH;
  const sockets = new Set<net.Socket>();
  const lifetime = new AbortController();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let discovery: Promise<string> | undefined;
  const log = (message: string) => { try { options.onDiagnostic?.(message); } catch {} };

  const discover = async (): Promise<string> => {
    if (preferred && !samePipe(preferred, stablePath) && await probeDesktopPipe(preferred, probeTimeout, lifetime.signal)) return preferred;
    const candidates = [...new Set(await (options.discoverPipePaths ?? discoverDesktopPipes)())]
      .filter(candidate => candidate && !samePipe(candidate, stablePath) && !samePipe(candidate, preferred));
    if (candidates.length > 64) throw new Error('Too many Desktop pipe candidates; refusing ambiguous discovery');
    const matched: string[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (!lifetime.signal.aborted) {
        const candidate = candidates[next++];
        if (candidate === undefined) break;
        if (await probeDesktopPipe(candidate, probeTimeout, lifetime.signal)) matched.push(candidate);
      }
    }));
    if (matched.length === 0) throw new Error('No verified Codex Desktop tools pipe is available; open Codex Desktop and reconnect');
    if (matched.length > 1) throw new Error('Multiple Codex Desktop tools pipes are available; refusing to choose an arbitrary Desktop instance');
    return matched[0]!;
  };
  const target = (): Promise<string> => {
    if (!discovery) discovery = discover().finally(() => { discovery = undefined; });
    return discovery;
  };

  const server = net.createServer(client => {
    client.pause();
    if (closed || sockets.size >= 64) { client.destroy(); return; }
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.once('close', () => sockets.delete(client));
    void target().then(pipe => {
      if (closed || client.destroyed) return;
      const upstream = net.createConnection(pipe);
      sockets.add(upstream);
      let timer: NodeJS.Timeout | undefined = setTimeout(() => upstream.destroy(new Error('Desktop tools upstream connection timed out')), connectTimeout);
      const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => { clearTimer(); sockets.delete(upstream); client.destroy(); });
      upstream.on('error', () => { clearTimer(); log('Desktop tools upstream disconnected; the next connection will rediscover Desktop'); client.destroy(); });
      upstream.once('connect', () => {
        clearTimer();
        if (closed || client.destroyed) { upstream.destroy(); return; }
        // Keep the product's framing, request IDs, namespaces, cancellation and backpressure intact.
        client.pipe(upstream);
        upstream.pipe(client);
      });
    }).catch(error => { log(error instanceof Error ? error.message : 'Desktop tools discovery failed'); client.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(stablePath, () => { server.off('error', failed); resolve(); });
  });
  server.on('error', () => log('Desktop tools relay listener failed'));
  return {
    path: stablePath,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return closePromise;
    },
  };
}

async function discoverDesktopPipes(): Promise<string[]> {
  if (process.platform !== 'win32') throw new Error('Automatic Desktop pipe discovery is only supported on Windows');
  return (await fs.readdir(PIPE_DIRECTORY)).filter(name => APP_PIPE_PATTERN.test(name)).map(name => PIPE_DIRECTORY + name);
}

function samePipe(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || value > 2_000) throw new Error('Desktop tools relay timeout must be between 1 and 2000 ms');
  return value;
}

function nativeFrame(value: unknown): Buffer {
  const content = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(content.length); else header.writeUInt32BE(content.length);
  return Buffer.concat([header, content]);
}

function isDesktopCatalog(value: unknown, requestId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const response = value as { id?: unknown; result?: { tools?: unknown }; error?: unknown };
  if (response.id !== requestId || response.error || !Array.isArray(response.result?.tools)) return false;
  const names = new Set(response.result.tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object' || tool.namespace !== 'codex_app' || typeof tool.name !== 'string') return [];
    return [tool.name];
  }));
  return names.has('open_in_codex') && names.has('list_artifacts');
}

function probeDesktopPipe(pipe: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection(pipe);
    const requestId = `feishu-codex-relay-probe-${randomUUID()}`;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      socket.destroy();
      resolve(valid);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('connect', () => socket.write(nativeFrame({ jsonrpc: '2.0', id: requestId, method: 'tools/list', params: { threadStartKind: 'all' } })));
    socket.on('data', chunk => {
      if (buffer.length + chunk.length > MAX_FRAME_BYTES + 4) { finish(false); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = os.endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) { finish(false); return; }
      if (buffer.length < length + 4) return;
      try { finish(isDesktopCatalog(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')), requestId)); }
      catch { finish(false); }
    });
  });
}

async function runStandalone(): Promise<void> {
  const args = process.argv.slice(2);
  let stablePath: string | undefined;
  let pidFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--pipe') stablePath = args[++index];
    else if (arg === '--pid-file') pidFile = args[++index];
    else throw new Error('Usage: desktop-tools-relay.js --pipe <stable-pipe> [--pid-file <absolute-path>]');
  }
  if (!stablePath) throw new Error('Desktop tools relay requires --pipe');
  if (pidFile && !path.isAbsolute(pidFile)) throw new Error('Desktop tools relay pid file must be an absolute path');
  const relay = await startDesktopToolsRelay(stablePath, { onDiagnostic: message => process.stderr.write(`[desktop-tools-relay] ${message}\n`) });
  try {
    if (pidFile) { await fs.mkdir(path.dirname(pidFile), { recursive: true }); await fs.writeFile(pidFile, String(process.pid)); }
  } catch (error) { await relay.close(); throw error; }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await relay.close();
    if (pidFile && await fs.readFile(pidFile, 'utf8').catch(() => '') === String(process.pid)) await fs.unlink(pidFile);
  };
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.stdout.write('Desktop tools relay is ready\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStandalone().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Desktop tools relay failed'}\n`); process.exitCode = 1; });
}
