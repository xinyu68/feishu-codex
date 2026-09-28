import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [scenario, directory] = process.argv.slice(2);
const trace = path.join(directory, `trace-${process.pid}.jsonl`);
const lock = path.join(directory, `owned-${process.pid}`);
fs.writeFileSync(lock, String(process.pid));
fs.appendFileSync(trace, `${JSON.stringify({ argv: process.argv.slice(4), codexHome: process.env.CODEX_HOME })}\n`);
process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (method, params) => write({ method, params });
const response = (id, result) => write({ id, result });
let threadId = 'new-thread';
let turnId = 'turn-1';
let approvalIndex = 0;
const approvals = [
  ['item/commandExecution/requestApproval', { command: 'test-command', reason: 'test-reason' }],
  ['item/fileChange/requestApproval', { grantRoot: directory }],
  ['item/permissions/requestApproval', { permissions: { network: { enabled: true } } }],
  ['item/tool/requestUserInput', { questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'yes', description: 'confirm' }] }] }],
];
const requestApproval = () => {
  const [method, params] = approvals[approvalIndex];
  write({ id: `approval-${approvalIndex}`, method, params: { ...params, threadId, turnId, itemId: `request-${approvalIndex}` } });
};
const finish = (status = 'completed') => event('turn/completed', { threadId, turn: { id: turnId, status, items: [
  { id: 'final', type: 'agentMessage', text: `${threadId}: final answer`, phase: 'final_answer' },
] } });
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(trace, `${JSON.stringify(message)}\n`);
  const params = message.params ?? {};
  if (message.method === 'initialize') response(message.id, { userAgent: 'fake-codex/1', codexHome: process.env.CODEX_HOME });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (scenario === 'busy') { write({ id: message.id, error: { code: -32000, message: 'thread writer lock held by another process' } }); return; }
    if (scenario === 'active-writer') { write({ id: message.id, error: { code: -32000, message: 'Cannot resume thread: it already has an active writer' } }); return; }
    threadId = params.threadId ?? 'new-thread';
    response(message.id, { thread: { id: threadId } });
  } else if (message.method === 'turn/start') {
    if (scenario === 'crash') process.exit(23);
    event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    event('item/completed', { threadId, turnId, item: { id: 'progress', type: 'agentMessage', text: 'working', phase: 'commentary' } });
    event('item/started', { threadId, turnId, item: { id: 'final', type: 'agentMessage', text: '', phase: 'final_answer' } });
    event('item/agentMessage/delta', { threadId, turnId, itemId: 'final', delta: 'partial ' });
    if (scenario === 'early') finish();
    response(message.id, { turn: { id: turnId } });
    if (scenario === 'approval') requestApproval();
    else if (scenario !== 'hang' && scenario !== 'early') finish();
  } else if (message.method === 'turn/interrupt') {
    response(message.id, {});
    finish('interrupted');
  } else if (message.method === 'account/read') response(message.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  else if (message.method === 'model/list') response(message.id, { data: [{ model: 'test-model', displayName: 'Test Model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null });
  else if (message.method === 'thread/read') response(message.id, { thread: { id: params.threadId, historyMode: 'paginated' } });
  else if (message.method === 'thread/turns/list') response(message.id, { data: [{ startedAt: 1700000000, items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
    { type: 'agentMessage', text: 'thinking', phase: 'commentary' },
    { type: 'agentMessage', text: 'Hello back', phase: 'final_answer' },
  ] }], nextCursor: null });
  else if (typeof message.id === 'string' && message.id.startsWith('approval-')) {
    approvalIndex++;
    if (approvalIndex < approvals.length) requestApproval(); else finish();
  } else if (message.method && message.id !== undefined) write({ id: message.id, error: { code: -32601, message: 'unknown method' } });
});
