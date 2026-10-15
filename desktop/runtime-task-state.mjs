const terminal = new Set(['completed', 'failed', 'interrupted']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Reconcile live status with the latest turn; persisted inProgress is not a live lock. */
export async function inspectTask(rpc, threadId, { now = Date.now, settle = delay, generation = () => 0 } = {}) {
  const read = async () => {
    const result = await rpc('thread/read', { threadId, includeTurns: false });
    const thread = result?.thread;
    if (thread?.id !== threadId || !['active', 'idle', 'notLoaded', 'systemError'].includes(thread.status?.type)) throw new Error('无法确认任务是否已结束。');
    return thread;
  };
  const latest = async thread => {
    if (thread.ephemeral === true) return undefined;
    if (thread.historyMode === 'paginated') {
      const page = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      if (!Array.isArray(page?.data)) throw new Error('无法确认最近任务是否结束。');
      return page.data[0];
    }
    const full = await rpc('thread/read', { threadId, includeTurns: true });
    if (full?.thread?.id !== threadId || !Array.isArray(full.thread.turns)) throw new Error('无法读取最近任务状态。');
    return full.thread.turns.at(-1);
  };
  const flags = thread => Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : [];
  const describe = (thread, active, reason) => ({ active, reason, id: threadId,
    title: thread.name || thread.preview?.slice(0, 80) || threadId.slice(0, 8) });
  let thread = await read();
  if (thread.ephemeral === true) {
    try { thread = await read(); }
    catch (error) { throw new Error('无法确认临时任务是否已结束。', { cause: error }); }
    if (thread.ephemeral !== true || thread.status.type === 'systemError') throw new Error('无法确认临时任务是否已结束。');
    return describe(thread, thread.status.type === 'active', '临时任务');
  }
  const epoch = generation(threadId);
  const turn = await latest(thread);
  if (turn && !terminal.has(turn.status) && turn.status !== 'inProgress') throw new Error('最近任务状态无法确认。');
  if (thread.status.type === 'systemError' && !terminal.has(turn?.status)) throw new Error('Codex 会话异常，无法确认最近任务状态。');
  if (flags(thread).length) return describe(thread, true, flags(thread).includes('waitingOnApproval') ? '等待审批' : '等待用户输入');
  if (thread.status.type === 'active' && (!turn || turn.status === 'inProgress')) return describe(thread, true, '正在处理');
  if (turn?.status === 'inProgress' && Number.isFinite(turn.startedAt) && turn.startedAt > now() / 1000 - 60) return describe(thread, true, '任务刚刚开始');
  if (thread.status.type === 'active' || turn?.status === 'inProgress') {
    await settle(150);
    const refreshed = await read();
    const current = await latest(refreshed);
    if (current && !terminal.has(current.status) && current.status !== 'inProgress') throw new Error('最近任务状态无法确认。');
    if (generation(threadId) !== epoch || current?.id !== turn?.id || flags(refreshed).length) return describe(refreshed, true, '任务状态正在变化');
    if (refreshed.status.type === 'active' && !terminal.has(current?.status)) return describe(refreshed, true, '正在处理');
    if (refreshed.status.type === 'systemError' && !terminal.has(current?.status)) throw new Error('Codex 会话异常，无法确认最近任务状态。');
    // Stable live idle plus old/undated history, or a stable terminal latest
    // turn plus a stale active summary, must not block shutdown indefinitely.
  }
  return describe(thread, false, '已空闲');
}
