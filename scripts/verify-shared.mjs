import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CodexClient } from '../dist/codex.js';

// An explicit smoke test: creates and archives one test thread, never resumes a user thread.
const endpoint = process.argv[2];
const verifyTools = process.argv.includes('--tools');
if (!endpoint) throw new Error('Usage: node scripts/verify-shared.mjs ws://127.0.0.1:PORT');
const cwd = fileURLToPath(new URL('../examples/workspace', import.meta.url));
const key = `SHARED${Date.now()}`;
const socket = new WebSocket(endpoint, { handshakeTimeout: 5000 });
const pending = new Map();
const completions = new Map();
const subscribers = new Map();
const observed = new Set();
let sequence = 0;
let threadId;
let activeTurnId;
const bridge = new CodexClient({ websocketUrl: endpoint });

socket.on('error', () => {});
socket.on('message', data => {
  const message = JSON.parse(data.toString());
  if (message.id !== undefined && !message.method) {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  } else if (message.method === 'turn/completed') {
    const { threadId: source, turn } = message.params;
    if (source !== threadId) return;
    observed.add(turn.id);
    completions.set(turn.id, turn);
    subscribers.get(turn.id)?.(turn);
  }
});

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function turn(text) {
  const response = await rpc('turn/start', {
    threadId, input: [{ type: 'text', text, text_elements: [] }],
    approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, effort: 'low',
  });
  activeTurnId = response.turn.id;
  const result = completions.get(activeTurnId) ?? await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscribers.delete(activeTurnId); reject(new Error('Test turn timeout')); }, 120000);
    subscribers.set(activeTurnId, value => { clearTimeout(timer); subscribers.delete(activeTurnId); resolve(value); });
  });
  assert.equal(result.status, 'completed');
  activeTurnId = undefined;
  return result;
}

try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await rpc('initialize', { clientInfo: { name: 'feishu_shared_smoke_desktop', title: 'Shared conversation smoke', version: '0.1' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  const started = await rpc('thread/start', { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never', developerInstructions: verifyTools
    ? 'This is a read-only shared runtime tool integration test. Follow the requested tool verification, do not modify any files, settings or conversations.'
    : 'This is a small shared connection smoke test. Do not use tools. Follow the user and reply only the requested short text.' });
  threadId = started.thread.id;
  if (verifyTools) {
    await turn('请使用代码执行工具 functions.exec 调用桌面工具 mcp__codex_app__list_artifacts（如果工具名称略有不同，请先查找工具名称），读取本测试会话的附件列表即可。不要打开别的会话，不要修改文件或状态。成功后只回复“桌面工具验证完成”，不能调用时说明原因。');
    const page = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
    const items = page.data[0].items;
    const answer = items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text).join('\n');
    console.log(JSON.stringify({ toolIntegration: true, itemTypes: items.map(item => item.type), answer }));
    assert.match(answer, /桌面工具验证完成/);
    assert.ok(items.some(item => !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)), 'the model must actually execute a tool');
  } else {
  await turn(`记住本次测试编号 ${key}，只回复已记住。`);
  await rpc('thread/name/set', { threadId, name: '共享连接自动验证（测试后归档）' });
  const result = await bridge.run({ threadId, cwd, prompt: '刚才的测试编号是什么？只回复编号。', effort: 'low' });
  assert.equal(result.threadId, threadId);
  assert.equal(result.text.trim(), key);
  await bridge.close();
  await turn('保持原来的测试编号，只回复验证完成。');
  assert.ok(observed.size >= 3, 'desktop connection must observe the bridge turn as well as its own turns');
  const loaded = await rpc('thread/loaded/list');
  assert.ok(loaded.data.includes(threadId), 'closing the bridge client must not terminate the shared thread');
  console.log(JSON.stringify({ passed: true, sameThread: true, contextPreserved: true, turnsObservedByDesktop: observed.size, bridgeDisconnectPreservesThread: true, workspace: path.basename(cwd) }));
  }
} finally {
  await bridge.close().catch(() => {});
  if (socket.readyState === WebSocket.OPEN && threadId) {
    if (activeTurnId) await rpc('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
    await rpc('thread/archive', { threadId }).then(() => console.log('Test thread archived')).catch(error => console.error(`Test archive: ${error.message}`));
  }
  socket.terminate();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Smoke client closed')); }
}
