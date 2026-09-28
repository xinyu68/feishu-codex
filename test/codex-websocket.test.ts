import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexClient, type CodexClientOptions } from '../src/codex.js';
import { validateCodexWebsocketUrl, type RpcMessage, type RpcParams } from '../src/codex-websocket.js';

type Turn = { id: string; status: string; items: RpcParams[] };
type Received = { socket: WebSocket; message: RpcMessage };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(codexHome?: string, options: Partial<CodexClientOptions> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  const received: Received[] = [];
  const responses: RpcMessage[] = [];
  const status = new Map<string, string>();
  const turns = new Map<string, Turn[]>();
  const failures: unknown[] = [];
  let sequence = 0;
  const send = (socket: WebSocket, message: RpcMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const reply = (socket: WebSocket, message: RpcMessage, result: unknown) => send(socket, { id: message.id, result });
  const notify = (method: string, params: RpcParams) => {
    for (const socket of server.clients) send(socket, { method, params });
  };
  const fx = {
    server, url, received, responses, status, turns, notify, send, reply,
    onSteer: undefined as undefined | ((socket: WebSocket, message: RpcMessage) => void | Promise<void>),
    onStart: undefined as undefined | ((socket: WebSocket, message: RpcMessage) => void | Promise<void>),
    onRead: undefined as undefined | ((socket: WebSocket, message: RpcMessage) => boolean | Promise<boolean>),
    onResume: undefined as undefined | ((socket: WebSocket, message: RpcMessage) => boolean | Promise<boolean>),
    onLoaded: undefined as undefined | ((socket: WebSocket, message: RpcMessage) => void),
    begin(threadId: string, clientId: string, turnId = `turn-${++sequence}`) {
      const turn: Turn = { id: turnId, status: 'inProgress', items: [{ type: 'userMessage', id: `user-${turnId}`, clientId, content: [{ type: 'text', text: 'hello' }] }] };
      turns.set(threadId, [turn, ...(turns.get(threadId) ?? [])]);
      status.set(threadId, 'active');
      notify('turn/started', { threadId, turn: { ...turn, items: [] } });
      notify('item/started', { threadId, turnId, item: turn.items[0] });
      return turn;
    },
    complete(threadId: string, turn: Turn, text = 'own final answer') {
      turn.status = 'completed';
      turn.items.push({ type: 'agentMessage', id: `answer-${turn.id}`, text, phase: 'final_answer' });
      notify('item/completed', { threadId, turnId: turn.id, item: turn.items.at(-1) });
      status.set(threadId, 'idle');
      notify('turn/completed', { threadId, turn });
      notify('thread/status/changed', { threadId, status: { type: 'idle' } });
    },
    client: new CodexClient({ websocketUrl: url, requestTimeoutMs: 2_000, idleTimeoutMs: 5_000, codexHome, ...options }),
    async cleanup() {
      await fx.client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.deepEqual(failures, []);
    },
  };
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as RpcMessage;
    if (!message.method) { responses.push(message); return; }
    received.push({ socket, message });
    void (async () => {
      const params = message.params ?? {};
      const threadId = String(params.threadId ?? 'new-thread');
      switch (message.method) {
        case 'initialized': return;
        case 'initialize': reply(socket, message, { userAgent: 'fake-shared/1' }); return;
        case 'account/read': reply(socket, message, { account: { id: 'user' } }); return;
        case 'model/list': reply(socket, message, { data: [], nextCursor: null }); return;
        case 'thread/loaded/list': if (fx.onLoaded) fx.onLoaded(socket, message); else reply(socket, message, { data: [], nextCursor: null }); return;
        case 'thread/resume':
          if (await fx.onResume?.(socket, message)) return;
          reply(socket, message, { thread: { id: threadId, status: { type: status.get(threadId) ?? 'idle' } } }); return;
        case 'thread/start':
          reply(socket, message, { thread: { id: threadId, status: { type: status.get(threadId) ?? 'idle' } } }); return;
        case 'thread/read':
          if (await fx.onRead?.(socket, message)) return;
          reply(socket, message, { thread: { id: threadId, status: { type: status.get(threadId) ?? 'idle' }, historyMode: 'paginated' } }); return;
        case 'thread/turns/list': reply(socket, message, { data: turns.get(threadId) ?? [], nextCursor: null }); return;
        case 'turn/steer': if (fx.onSteer) await fx.onSteer(socket, message); else reply(socket, message, { turnId: params.expectedTurnId }); return;
        case 'turn/start': {
          if (fx.onStart) { await fx.onStart(socket, message); return; }
          const turn = fx.begin(threadId, String(params.clientUserMessageId));
          // The server is allowed to deliver events before the RPC response.
          fx.complete(threadId, turn);
          reply(socket, message, { turn }); return;
        }
        case 'turn/interrupt': {
          const turn = turns.get(threadId)?.find(item => item.id === params.turnId);
          if (turn) { turn.status = 'interrupted'; status.set(threadId, 'idle'); notify('turn/completed', { threadId, turn }); }
          reply(socket, message, {}); return;
        }
        default: throw new Error(`Unexpected request ${message.method}`);
      }
    })().catch(error => { failures.push(error); send(socket, { id: message.id, error: { message: String(error) } }); });
  }));
  return fx;
}


test('notification timing reads the requested turn and normalizes seconds without starting work', async () => {
 const fx = await fixture(); try {
  fx.turns.set('thread', [
   Object.assign({ id: 'newer', status: 'completed', items: [] }, { durationMs: 999_999 }),
   Object.assign({ id: 'measured', status: 'completed', items: [] }, { startedAt: 1_800_000_000, completedAt: 1_800_000_090, durationMs: 90_100 }),
  ]);
  assert.deepEqual(await fx.client.turnTiming('thread', 'measured'), { startedAtMs: 1_800_000_000_000, completedAtMs: 1_800_000_090_000, durationMs: 90_100 });
  assert.deepEqual(await fx.client.turnTiming('thread', 'missing'), {});
  assert.equal(fx.received.some(row => ['turn/start', 'turn/steer', 'turn/interrupt', 'thread/resume'].includes(row.message.method || '')), false);
 } finally { await fx.cleanup(); }
});

test('shared resume preserves native settings and early output', async () => {
 const fx=await fixture(); try {
  const result=await fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'go'});
  assert.equal(result.text,'own final answer');assert.ok(result.turnId);
  assert.deepEqual(fx.received.find(row=>row.message.method==='thread/resume')!.message.params,{threadId:'thread',excludeTurns:true});
  assert.deepEqual(fx.received.find(row=>row.message.method==='turn/start')!.message.params!.sandboxPolicy,{type:'dangerFullAccess'});
  await fx.client.history('thread'); assert.equal(fx.received.filter(row=>row.message.method==='thread/resume').length,1);
 } finally {await fx.cleanup();}
});

test('a role persists in thread instructions and updates while resuming the same thread', async () => {
 const fx = await fixture(); try {
  const first = await fx.client.run({ cwd: process.cwd(), prompt: 'analyse', model: 'product-model', effort: 'high', roleInstructions: '你是产品经理，只整理需求和验收标准。' });
  const start = fx.received.find(row => row.message.method === 'thread/start')!.message.params!;
  assert.match(String(start.developerInstructions), /Feishu Codex/);
  assert.match(String(start.developerInstructions), /你是产品经理，只整理需求和验收标准。/);
  assert.equal(start.model, 'product-model');
  const next = await fx.client.run({ cwd: process.cwd(), threadId: first.threadId, prompt: 'continue', model: 'review-model', effort: 'medium', roleInstructions: '你是产品经理，本阶段还需要检查交互一致性。' });
  assert.equal(next.threadId, first.threadId);
  const resumed = fx.received.find(row => row.message.method === 'thread/resume')!.message.params!;
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.excludeTurns, true);
  assert.match(String(resumed.developerInstructions), /本阶段还需要检查交互一致性/);
  assert.doesNotMatch(String(resumed.developerInstructions), /只整理需求和验收标准/);
  assert.equal(fx.received.filter(row => row.message.method === 'thread/start').length, 1);
  const submissions = fx.received.filter(row => row.message.method === 'turn/start').map(row => row.message.params!);
  assert.deepEqual(submissions.map(item => [item.model, item.effort]), [['product-model', 'high'], ['review-model', 'medium']]);
  assert.equal(submissions[1]!.threadId, first.threadId);
 } finally { await fx.cleanup(); }
});

test('explicitly clearing a role updates instructions while a native continuation does not overwrite them', async () => {
 const fx = await fixture(); try {
  await fx.client.run({ cwd: process.cwd(), threadId: 'role-thread', prompt: 'clear role', roleInstructions: '' });
  const cleared = fx.received.find(row => row.message.method === 'thread/resume')!.message.params!;
  assert.match(String(cleared.developerInstructions), /Feishu Codex/);
  assert.equal(String(cleared.developerInstructions).includes('\n\n'), false);
  await fx.client.run({ cwd: process.cwd(), threadId: 'native-thread', prompt: 'continue' });
  const native = fx.received.filter(row => row.message.method === 'thread/resume').at(-1)!.message.params!;
  assert.deepEqual(native, { threadId: 'native-thread', excludeTurns: true });
  await fx.client.watch('role-thread');
  const watcher = fx.received.filter(row => row.message.method === 'thread/resume').at(-1)!.message.params!;
  assert.deepEqual(watcher, { threadId: 'role-thread', excludeTurns: true }, 'passive watchers never overwrite role settings');
 } finally { await fx.cleanup(); }
});

test('a stale interruption report does not fail a turn that is still running', async () => {
 const fx = await fixture(); let turn!: Turn;
 fx.onStart = (socket, message) => {
  turn = fx.begin('thread', String(message.params!.clientUserMessageId), 'still-running');
  fx.notify('turn/completed', { threadId: 'thread', turn: { ...turn, status: 'interrupted' } });
  fx.reply(socket, message, { turn: { ...turn, status: 'interrupted' } });
  setTimeout(() => fx.complete('thread', turn, 'finished after stale interruption'), 300);
 };
 try {
  const result = await fx.client.run({ cwd: process.cwd(), threadId: 'thread', prompt: 'continue' });
  assert.equal(result.text, 'finished after stale interruption');
  assert.equal(fx.received.some(row => row.message.method === 'turn/interrupt'), false);
 } finally { await fx.cleanup(); }
});

test('a confirmed external interruption still ends the submitted turn', async () => {
 const fx = await fixture();
 fx.onStart = (socket, message) => {
  const turn = fx.begin('thread', String(message.params!.clientUserMessageId), 'really-interrupted');
  turn.status = 'interrupted';
  fx.status.set('thread', 'idle');
  fx.notify('turn/completed', { threadId: 'thread', turn });
  fx.reply(socket, message, { turn });
 };
 try {
  await assert.rejects(fx.client.run({ cwd: process.cwd(), threadId: 'thread', prompt: 'continue' }), /已停止当前任务/);
 } finally { await fx.cleanup(); }
});

test('shared turns report only images generated during the current turn', async () => {
 const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-generated-images-'));
 const directory = path.join(codexHome, 'generated_images', 'thread');
 await mkdir(directory, { recursive: true });
 const oldImage = path.join(directory, 'old.png');
 const newImage = path.join(directory, 'new.png');
 await writeFile(oldImage, 'old');
 const fx = await fixture(codexHome);
 fx.onStart = async (socket, message) => {
  const params = message.params ?? {};
  const turn = fx.begin('thread', String(params.clientUserMessageId));
  await writeFile(newImage, 'new');
  fx.complete('thread', turn, 'image ready');
  fx.reply(socket, message, { turn });
 };
 try {
  const result = await fx.client.run({ cwd: process.cwd(), threadId: 'thread', prompt: 'make image' });
  assert.equal(result.text, 'image ready');
  assert.deepEqual(result.images, [newImage]);
 } finally {
  await fx.cleanup();
  await rm(codexHome, { recursive: true, force: true });
 }
});
test('native active turn steers immediately with expectedTurnId',async()=>{
 const fx=await fixture(); const turn=fx.begin('thread','native','native-turn'); const sent=deferred();
 fx.onSteer=(socket,message)=>{fx.reply(socket,message,{turnId:turn.id});sent.resolve();};
 try{
  const result=fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'change'});
  await sent.promise;assert.equal(fx.received.find(row=>row.message.method==='turn/steer')!.message.params!.expectedTurnId,'native-turn');
  assert.equal(fx.received.some(row=>row.message.method==='turn/start'),false);
  fx.complete('thread',turn,'combined');assert.deepEqual(await result,{threadId:'thread',turnId:'native-turn',text:'combined'});
 }finally{await fx.cleanup();}
});
test('parallel inputs share one turn; watched deltas emit once',async()=>{
 const fx=await fixture();const started=deferred();const steered=deferred();let turn!:Turn;
 fx.onStart=(socket,message)=>{turn=fx.begin('thread',String(message.params!.clientUserMessageId),'one');fx.reply(socket,message,{turn});started.resolve();};
 fx.onSteer=(socket,message)=>{fx.reply(socket,message,{turnId:turn.id});steered.resolve();};
 const events:string[]=[];fx.client.subscribe(event=>{if(event.method==='item/agentMessage/delta')events.push(String(event.params?.delta));});
 try{
  await fx.client.watch('thread');
  const a=fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a'});await started.promise;
  const b=fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'b'});await steered.promise;
  fx.notify('item/agentMessage/delta',{threadId:'thread',turnId:'one',itemId:'answer',delta:'hello'});
  fx.complete('thread',turn);assert.deepEqual((await Promise.all([a,b])).map(result=>result.turnId),['one','one']);
  assert.deepEqual(events,['hello']);assert.equal(fx.received.filter(row=>row.message.method==='turn/start').length,1);
 }finally{await fx.cleanup();}
});
test('explicit stop interrupts native-only turn; idle stop is a no-op',async()=>{
 const fx=await fixture();fx.begin('thread','native','native-only');
 fx.status.set('thread','idle'); // Real native app-server metadata lags just after turn/start.
 try{
  await fx.client.stop('thread');await fx.client.stop('thread');
  assert.deepEqual(fx.received.filter(row=>row.message.method==='turn/interrupt').map(row=>row.message.params),[{threadId:'thread',turnId:'native-only'}]);
 }finally{await fx.cleanup();}
});
test('stop waits for accepted mutation identity',async()=>{
 const fx=await fixture();const sent=deferred();const response=deferred();
 fx.onStart=async(socket,message)=>{const turn=fx.begin('thread',String(message.params!.clientUserMessageId),'ours');sent.resolve();await response.promise;fx.reply(socket,message,{turn});};
 try{
  const result=fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a'});const rejected=assert.rejects(result,/已停止/);await sent.promise;
  const stopped=fx.client.stop('thread');await pause(20);assert.equal(fx.received.some(row=>row.message.method==='turn/interrupt'),false);
  response.resolve();await stopped;await rejected;assert.equal(fx.received.filter(row=>row.message.method==='turn/interrupt').length,1);
 }finally{response.resolve();await fx.cleanup();}
});
test('definitively rejected ended turn may start once, changed active turn may not',async()=>{
 for(const changed of [false,true]){
  const fx=await fixture();fx.begin('thread','native','old');
  fx.onSteer=(socket,message)=>{if(changed)fx.begin('thread','native','new');else { fx.status.set('thread','idle'); for (const turn of fx.turns.get('thread') ?? []) turn.status = 'completed'; }fx.send(socket,{id:message.id,error:{code:-32000,message:'no active turn'}});};
  try{
   const result=fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a'});
   if(changed)await assert.rejects(result,/任务已经变化/);else assert.equal((await result).text,'own final answer');
   assert.equal(fx.received.filter(row=>row.message.method==='turn/start').length,changed?0:1);
   assert.equal(fx.received.filter(row=>row.message.method==='turn/steer').length,1);
  }finally{await fx.cleanup();}
 }
});
test('lost mutation response is uncertain with no replay or interruption',async()=>{
 const fx=await fixture();const states:string[]=[];
 fx.onStart=(socket,message)=>{fx.begin('thread',String(message.params!.clientUserMessageId));socket.terminate();};
 try{
  await assert.rejects(fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a',onSubmitted:event=>states.push(event.status)}),/本机 Codex 连接已断开/);
  assert.deepEqual(states,['submitting','uncertain']);assert.equal(fx.received.filter(row=>row.message.method==='turn/start').length,1);
  assert.equal(fx.received.some(row=>row.message.method==='turn/interrupt'),false);
 }finally{await fx.cleanup();}
});
test('accepted start survives an empty rollout snapshot and retains approval ownership',async()=>{
 const fx=await fixture();const states:string[]=[];let approvals=0;let reads=0;
 fx.onRead=(socket,message)=>{reads++;fx.send(socket,{id:message.id,error:{code:-32000,message:'failed to read thread: thread-store internal error: failed to read session metadata rollout.jsonl: rollout at rollout.jsonl is empty'}});return true;};
 fx.onStart=(socket,message)=>{
  const turn=fx.begin('new-thread',String(message.params!.clientUserMessageId),'fresh-turn');
  fx.reply(socket,message,{turn:{id:turn.id}});
  setTimeout(()=>fx.send(socket,{id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'new-thread',turnId:turn.id,command:'safe'}}),5);
  setTimeout(()=>fx.complete('new-thread',turn,'completed despite snapshot race'),20);
 };
 try{
  const result=await fx.client.run({cwd:process.cwd(),prompt:'a',onSubmitted:event=>states.push(event.status),onRequest:async()=>{approvals++;return{decision:'accept'};}});
  assert.equal(result.text,'completed despite snapshot race');
  assert.deepEqual(states,['submitting','submitted']);
  assert.equal(fx.received.filter(row=>row.message.method==='turn/start').length,1);
  assert.equal(fx.received.some(row=>row.message.method==='turn/steer'),false);
  assert.equal(reads,5);
  assert.equal(approvals,1);
  assert.deepEqual(fx.responses.find(message=>message.id==='approval')?.result,{decision:'accept'});
 }finally{await fx.cleanup();}
});
test('all auxiliary snapshot read errors are best effort after submission',async()=>{
 const fx=await fixture();const states:string[]=[];let reads=0;
 fx.onRead=(socket,message)=>{reads++;fx.send(socket,{id:message.id,error:{code:-32603,message:'snapshot backend unavailable'}});return true;};
 fx.onStart=(socket,message)=>{
  const turn=fx.begin('new-thread',String(message.params!.clientUserMessageId),'generic-read-error');
  fx.reply(socket,message,{turn:{id:turn.id}});
  setTimeout(()=>fx.complete('new-thread',turn,'event result'),10);
 };
 try{
  const result=await fx.client.run({cwd:process.cwd(),prompt:'a',onSubmitted:event=>states.push(event.status)});
  assert.equal(result.text,'event result');
  assert.deepEqual(states,['submitting','submitted']);
  assert.equal(reads,1);
  assert.equal(fx.received.filter(row=>row.message.method==='turn/start').length,1);
 }finally{await fx.cleanup();}
});
test('steering an existing turn does not claim its approval requests',async()=>{
 const fx=await fixture();const turn=fx.begin('thread','native','native-turn');let approvals=0;
 fx.onSteer=(socket,message)=>{
  fx.reply(socket,message,{turnId:turn.id});
  setTimeout(()=>fx.send(socket,{id:'native-approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:turn.id,command:'native'}}),5);
  setTimeout(()=>fx.complete('thread',turn,'native complete'),20);
 };
 try{
  assert.equal((await fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a',onRequest:async()=>{approvals++;return{decision:'accept'};}})).text,'native complete');
  await pause(20);
  assert.equal(approvals,0);
  assert.equal(fx.responses.some(message=>message.id==='native-approval'),false);
 }finally{await fx.cleanup();}
});
test('write gate runs immediately before mutation; watcher detach leaves native task alive',async()=>{
 const fx=await fixture();try{
  await assert.rejects(fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a',onBeforeSubmit:async()=>{throw new Error('independent desktop');}}),/independent desktop/);
  assert.equal(fx.received.some(row=>row.message.method==='turn/start'),false);
  await fx.client.watch('thread');fx.begin('thread','native','native');await pause(15);await fx.client.close();
  assert.equal(fx.status.get('thread'),'active');assert.equal(fx.received.some(row=>row.message.method==='turn/interrupt'),false);
 }finally{await fx.cleanup();}
});
test('watch retries an initializing rollout serially and deduplicates callers',async()=>{
 const fx=await fixture();let attempts=0;let concurrent=0;let maximum=0;
 fx.onResume=async(socket,message)=>{
  attempts++;concurrent++;maximum=Math.max(maximum,concurrent);await pause(15);concurrent--;
  if(attempts<3)fx.send(socket,{id:message.id,error:{code:-32000,message:'no rollout found for thread id fresh'}});
  else fx.reply(socket,message,{thread:{id:'fresh',status:{type:'idle'}}});
  return true;
 };
 try{
  await Promise.all([fx.client.watch('fresh'),fx.client.watch('fresh'),fx.client.watch('fresh')]);
  assert.equal(attempts,3);assert.equal(maximum,1);
  assert.equal(fx.received.filter(row=>row.message.method==='thread/resume').length,3);
 }finally{await fx.cleanup();}
});
test('watch throws a permanent resume error without background retry',async()=>{
 const fx=await fixture();let attempts=0;
 fx.onResume=(socket,message)=>{attempts++;fx.send(socket,{id:message.id,error:{code:-32602,message:'invalid thread id'}});return true;};
 try{
  await assert.rejects(fx.client.watch('bad'),/invalid thread id/);await pause(150);
  assert.equal(attempts,1);
 }finally{await fx.cleanup();}
});
test('an established watcher survives one failed transport reconnect without parallel attempts',{timeout:7_000},async()=>{
 const fx=await fixture();const recovered=deferred();let attempts=0;let concurrent=0;let maximum=0;
 fx.onResume=async(socket,message)=>{
  attempts++;concurrent++;maximum=Math.max(maximum,concurrent);await pause(10);concurrent--;
  if(attempts===2){socket.terminate();return true;}
  fx.reply(socket,message,{thread:{id:'watched',status:{type:'idle'}}});
  if(attempts===3)recovered.resolve();
  return true;
 };
 try{
  await fx.client.watch('watched');
  fx.received.find(row=>row.message.method==='thread/resume')!.socket.terminate();
  await recovered.promise;
  assert.equal(attempts,3);assert.equal(maximum,1);
  assert.equal(fx.received.filter(row=>row.message.method==='thread/resume').length,3);
 }finally{await fx.cleanup();}
});
test('unwatch during initialization backoff prevents watcher resurrection',async()=>{
 const fx=await fixture();const failed=deferred();let attempts=0;
 fx.onResume=(socket,message)=>{attempts++;fx.send(socket,{id:message.id,error:{code:-32000,message:'no rollout found for thread id fresh'}});failed.resolve();return true;};
 try{
  const watching=fx.client.watch('fresh');await failed.promise;await fx.client.unwatch('fresh');await watching;await pause(150);
  assert.equal(attempts,1);
 }finally{await fx.cleanup();}
});
test('thread and turn correlation ignores foreign output and approvals',async()=>{
 const fx=await fixture();let approvals=0;
 fx.onStart=async(socket,message)=>{
  const turn=fx.begin('thread',String(message.params!.clientUserMessageId),'ours');
  fx.send(socket,{id:'foreign',method:'item/commandExecution/requestApproval',params:{threadId:'other',turnId:'different',command:'wrong'}});
  fx.notify('item/completed',{threadId:'other',turnId:'ours',item:{id:'wrong',type:'agentMessage',phase:'final_answer',text:'WRONG'}});
  fx.reply(socket,message,{turn});await pause(15);fx.complete('thread',turn,'correct');
 };
 try{
  assert.equal((await fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'a',onRequest:async()=>{approvals++;return{decision:'accept'};}})).text,'correct');
  assert.equal(approvals,0);assert.deepEqual(fx.responses,[]);
 }finally{await fx.cleanup();}
});
test('shared URL is credential-free loopback only',()=>{
 assert.equal(validateCodexWebsocketUrl('ws://127.0.0.1:4567'),'ws://127.0.0.1:4567/');
 for(const url of ['ws://example.com:4567','ws://localhost:4567','wss://127.0.0.1:4567','ws://name:secret@127.0.0.1:4567','ws://127.0.0.1:4567/?key=secret','ws://127.0.0.1:1000','ws://127.0.0.1:4567/path'])assert.throws(()=>new CodexClient({websocketUrl:url}),/Codex 连接地址/);
});

test('notification publisher stays pinned when a watcher joins and resets once on socket handover', async () => {
 const fx=await fixture();const started=deferred();let turn!:Turn;
 fx.onStart=(socket,message)=>{turn=fx.begin('thread',String(message.params!.clientUserMessageId),'handover');fx.reply(socket,message,{turn});started.resolve();};
 const events:Array<{method:string;text?:string}>=[];
 fx.client.subscribe(event=>events.push({method:event.method,text:typeof event.params?.delta==='string'?event.params.delta:undefined}));
 try{
  const pending=fx.client.run({cwd:process.cwd(),threadId:'thread',prompt:'one'});
  const rejected=assert.rejects(pending,/连接已断开/);await started.promise;await fx.client.watch('thread');
  for(let index=0;index<2;index++)fx.notify('item/agentMessage/delta',{threadId:'thread',turnId:turn.id,itemId:'answer',delta:'same'});
  await pause(20);assert.deepEqual(events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.text),['same','same']);
  const origin=fx.received.find(row=>row.message.method==='turn/start')!.socket;origin.terminate();await rejected;await pause(20);
  fx.notify('item/agentMessage/delta',{threadId:'thread',turnId:turn.id,itemId:'answer',delta:'after'});await pause(20);
  assert.deepEqual(events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.text),['same','same','after']);
  assert.equal(events.filter(event=>event.method==='stream/reset').length,2);
  fx.complete('thread',turn);
 }finally{await fx.cleanup();}
});

test('background loaded-thread polling survives an unavailable runtime and retries', { timeout: 6_000 }, async () => {
 const fx=await fixture(); let reads=0; const recovered=deferred();
 fx.onLoaded=(socket,message)=>{
  reads++;
  if(reads===2) { socket.terminate(); return; }
  fx.reply(socket,message,{data:[],nextCursor:null});
  if(reads===3) recovered.resolve();
 };
 try {
  await fx.client.watchLoaded();
  await recovered.promise;
  assert.equal(reads,3);
 } finally { await fx.cleanup(); }
});

test('history watcher never resumes an unloaded thread or acquires its writer lock', async () => {
 const fx = await fixture(); fx.status.set('history-only', 'notLoaded');
 try {
  await fx.client.watch('history-only');
  await fx.client.watch('history-only');
  assert.equal(fx.received.filter(row => row.message.method === 'thread/read').length, 2);
  assert.equal(fx.received.some(row => row.message.method === 'thread/resume'), false);
  fx.status.set('history-only', 'active');
  await fx.client.watch('history-only');
  assert.equal(fx.received.filter(row => row.message.method === 'thread/resume').length, 1);
 } finally { await fx.cleanup(); }
});

test('independent desktop blocks both preview watching and loaded-thread subscriptions', async () => {
 const fx = await fixture(undefined, { canWatch: async () => false });
 fx.onLoaded = (socket, message) => fx.reply(socket, message, { data: ['thread'], nextCursor: null });
 try {
  await fx.client.watch('thread'); await fx.client.watchLoaded();
  assert.equal(fx.received.some(row => row.message.method === 'thread/resume'), false);
 } finally { await fx.cleanup(); }
});

test('desktop ownership changing during a history read prevents its subsequent resume', async () => {
 let allowed = true;
 const fx = await fixture(undefined, { canWatch: async () => allowed });
 fx.onRead = () => { allowed = false; return false; };
 try {
  await fx.client.watch('thread');
  assert.equal(fx.received.some(row => row.message.method === 'thread/resume'), false);
 } finally { await fx.cleanup(); }
});

test('an ownership-blocked watcher disconnects without interrupting a running turn', async () => {
 let allowed = true;
 const fx = await fixture(undefined, { canWatch: async () => allowed });
 try {
  await fx.client.watch('thread');
  const socket = fx.received.find(row => row.message.method === 'thread/resume')!.socket;
  const closed = once(socket, 'close');
  fx.begin('thread', 'native'); allowed = false;
  await fx.client.watch('thread'); await closed;
  assert.equal(fx.status.get('thread'), 'active');
  assert.equal(fx.received.some(row => row.message.method === 'turn/interrupt'), false);
 } finally { await fx.cleanup(); }
});

test('unwatch during the final ownership check cannot resurrect a subscription', async () => {
 const checked = deferred(), decision = deferred<boolean>(); let checks = 0;
 const fx = await fixture(undefined, { canWatch: async () => { if (++checks === 1) return true; checked.resolve(); return decision.promise; } });
 try {
  const watching = fx.client.watch('thread'); await checked.promise;
  await fx.client.unwatch('thread'); decision.resolve(true); await watching;
  assert.equal(fx.received.some(row => row.message.method === 'thread/resume'), false);
 } finally { decision.resolve(false); await fx.cleanup(); }
});
