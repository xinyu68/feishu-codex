import WebSocket from 'ws';

// Read-only snapshot for an external shutdown check. Never resume a thread or
// send a turn; uncertain states fail closed instead of being reported as idle.
const report = { ok: false, loadedCount: 0, activeCount: 0 };
const pending = new Map();
let socket;
let sequence = 0;
let finished = false;
let timeout;
let rejectConnection;

function fail(error) {
  rejectConnection?.(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
}

async function inspect() {
  const endpoint = new URL(process.argv[2]);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || !endpoint.port || Number(endpoint.port) < 1024 || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || process.argv.length !== 3) {
    throw new Error('Expected a credential-free loopback WebSocket URL');
  }
  socket = new WebSocket(endpoint, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
  socket.on('error', fail);
  socket.on('close', () => { if (!finished) fail(new Error('Runtime connection closed')); });
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { fail(new Error('Invalid runtime response')); return; }
    if (!message || typeof message !== 'object') { fail(new Error('Invalid runtime response')); return; }
    if (message.method || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error || !Object.hasOwn(message, 'result')) request.reject(new Error('Runtime request failed'));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    rejectConnection = reject;
    socket.once('open', resolve);
  });
  rejectConnection = undefined;
  await rpc('initialize', {
    clientInfo: { name: 'feishu_codex_idle_probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));

  const ids = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const page = await rpc('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.data)
        || page.data.some(id => typeof id !== 'string' || !id)
        || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor))) {
      throw new Error('Unexpected loaded-thread response');
    }
    for (const id of page.data) ids.add(id);
    report.loadedCount = ids.size;
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated loaded-thread cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);

  for (const threadId of ids) {
    const result = await rpc('thread/read', { threadId, includeTurns: false });
    const status = result?.thread?.status?.type;
    if (result?.thread?.id !== threadId || !['active', 'idle', 'notLoaded'].includes(status)) {
      throw new Error('Thread state cannot be confirmed');
    }
    if (status === 'active') report.activeCount++;
  }
  report.ok = true;
}

try {
  await Promise.race([
    inspect(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Probe deadline exceeded')), 30000); }),
  ]);
  process.exitCode = report.activeCount ? 2 : 0;
} catch {
  report.ok = false;
  process.exitCode = 1;
} finally {
  finished = true;
  clearTimeout(timeout);
  fail(new Error('Probe finished'));
  socket?.terminate();
  console.log(JSON.stringify(report));
}
