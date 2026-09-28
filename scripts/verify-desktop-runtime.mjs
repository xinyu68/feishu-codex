import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CodexClient, resolveCodexCommand } from '../src/codex.ts';
import { WebsocketCodexConnection } from '../src/codex-websocket.ts';

// An isolated app-server and new, disposable thread. Never contact the live
// bridge, consume Feishu events, or resume an existing user's thread.
const port = 18794;
const endpoint = `ws://127.0.0.1:${port}`;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-runtime-contract-'));
const report = { startedAt: new Date().toISOString(), isolated: true, port, cwd, passed: false, checks: {}, errors: [] };
const originalRequest = WebsocketCodexConnection.prototype.request;
WebsocketCodexConnection.prototype.request = async function(method, params, timeout) {
  const result = await originalRequest.call(this, method, params, timeout);
  if (report.stopTurnId && ['thread/read', 'thread/turns/list', 'turn/interrupt'].includes(method)) {
    report.stopTrace ??= [];
    report.stopTrace.push({ method, includeTurns: params.includeTurns, interruptTurnId: params.turnId, status: result?.thread?.status, turns: (result?.data ?? result?.thread?.turns)?.map(turn => ({ id: turn.id, status: turn.status })) });
  }
  return result;
};
const artifact = path.resolve('artifacts/desktop-runtime-contract-latest.json');
fs.mkdirSync(path.dirname(artifact), { recursive: true });
let child; let native; let client; let threadId; let errorLog = ''; let deadline;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rpcUntilReady() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Isolated runtime exited (${child.exitCode}): ${errorLog.slice(-500)}`);
    const connection = new WebsocketCodexConnection(endpoint, 1000);
    try { await connection.initialize(); return connection; }
    catch { await connection.close(); await pause(250); }
  }
  throw new Error('Isolated runtime did not become ready');
}
async function check() {
  const probe = net.createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening'); await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).reduce((map, [key, value]) => { const normalized = key.toUpperCase(); if (!map.has(normalized) || key === normalized) map.set(normalized, value); return map; }, new Map()));
  delete env.CODEX_APP_SERVER_WS_URL; delete env.CODEX_APP_SERVER_FORCE_CLI;
  const command = resolveCodexCommand();
  report.executable = command.command;
  child = spawn(command.command, [...command.args, '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'features.code_mode_host=true', 'app-server', '--listen', endpoint], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { errorLog += error.message; });
  child.stderr.on('data', data => { errorLog = (errorLog + String(data)).slice(-2000); }); child.stdout.on('data', () => {});
  report.pid = child.pid;
  native = await rpcUntilReady();
  const started = await native.request('thread/start', { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never', config: { sandbox_mode: 'danger-full-access', approval_policy: 'never' } });
  threadId = started.thread.id; report.threadId = threadId;
  client = new CodexClient({ websocketUrl: endpoint, requestTimeoutMs: 30000, idleTimeoutMs: 120000 });
  const original = await native.request('turn/start', { threadId, input: [{ type: 'text', text: 'This is an isolated protocol validation. Do not edit files. Wait for the next user instruction before giving the final reply.', text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  report.nativeTurnId = original.turn.id;
  await pause(500);
  const metadata = await native.request('thread/read', { threadId, includeTurns: false });
  report.historyMode = metadata.thread.historyMode;
  const stages = [];
  const result = await client.run({ cwd, threadId, prompt: 'Protocol test updated instruction: reply only RUNTIME_STEER731. Do not edit files or use tools.', onSubmitted: event => stages.push({ status: event.status, mode: event.mode, turnId: event.turnId }) });
  report.submissions = stages;
  report.reply = result.text;
  report.checks.nativeSteered = stages.some(event => event.mode === 'steer' && event.status === 'submitted' && event.turnId === report.nativeTurnId);
  report.checks.sameTurn = result.turnId === report.nativeTurnId;
  report.checks.reply = result.text.trim() === 'RUNTIME_STEER731';
  const stopTurn = await native.request('turn/start', { threadId, input: [{ type: 'text', text: 'This isolated protocol validation will be stopped immediately. Do not edit files.', text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  report.stopTurnId = stopTurn.turn.id;
  await client.stop(threadId);
  for (let attempt = 0; attempt < 30; attempt++) {
    const history = await native.request('thread/read', { threadId, includeTurns: true });
    report.stopStatus = history.thread.turns.find(turn => turn.id === stopTurn.turn.id)?.status;
    if (report.stopStatus === 'interrupted') break;
    await pause(100);
  }
  report.checks.nativeStopped = report.stopStatus === 'interrupted';
  report.passed = Object.values(report.checks).every(Boolean);
}
try {
  await Promise.race([check(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Validation deadline exceeded')), 180000); })]);
} catch (error) { report.errors.push(error.message); }
finally {
  clearTimeout(deadline);
  if (threadId && client) await client.stop(threadId).catch(() => {});
  await client?.close().catch(() => {});
  if (threadId && native) { try { await native.request('thread/archive', { threadId }); report.archived = true; } catch (error) { report.errors.push(`Archive: ${error.message}`); } }
  await native?.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), pause(3000)]); }
  report.finishedAt = new Date().toISOString(); fs.writeFileSync(artifact, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.passed ? 0 : 1;
}
