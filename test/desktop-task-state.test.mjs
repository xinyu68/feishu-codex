import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTask } from '../desktop/runtime-task-state.mjs';

function fixture(status, turn, refreshed = status, next = turn) {
  let summaries = 0, turns = 0;
  const rpc = async (method, params) => {
    assert.ok(['thread/read', 'thread/turns/list'].includes(method), 'inspection must never write');
    if (method === 'thread/turns/list') return { data: [turns++ ? next : turn].filter(Boolean) };
    assert.equal(params.includeTurns, false);
    return { thread: { id: 'thread', name: '明确的会话名', historyMode: 'paginated', status: summaries++ ? refreshed : status } };
  };
  return { rpc, options: { settle: async () => {} } };
}
test('undated in-progress history cannot permanently lock an idle desktop', async () => {
  const fx = fixture({ type: 'idle' }, { id: 'old', status: 'inProgress', startedAt: null });
  assert.equal((await inspectTask(fx.rpc, 'thread', fx.options)).active, false);
});
test('a terminal latest turn reconciles a stale active summary', async () => {
  const fx = fixture({ type: 'active', activeFlags: [] }, { id: 'done', status: 'completed' });
  assert.equal((await inspectTask(fx.rpc, 'thread', fx.options)).active, false);
});
test('genuine running and waiting tasks are retained with a useful reason', async () => {
  for (const [flags, reason] of [[[], '正在处理'], [['waitingOnApproval'], '等待审批'], [['waitingOnUserInput'], '等待用户输入']]) {
    const fx = fixture({ type: 'active', activeFlags: flags }, { id: 'live', status: 'inProgress' });
    const result = await inspectTask(fx.rpc, 'thread', fx.options);
    assert.equal(result.active, true); assert.equal(result.reason, reason); assert.equal(result.title, '明确的会话名');
  }
});
test('a new task or an unknown status during reconciliation cannot authorize exit', async () => {
  const fx = fixture({ type: 'active' }, { id: 'old', status: 'completed' }, { type: 'active' }, { id: 'new', status: 'inProgress' });
  assert.equal((await inspectTask(fx.rpc, 'thread', fx.options)).active, true);
  const unknown = fixture({ type: 'active' }, { id: 'old', status: 'completed' }, { type: 'unknown' });
  await assert.rejects(inspectTask(unknown.rpc, 'thread', unknown.options), /无法确认/);
});
