import { desktopMode, sameProcess } from './lifecycle.mjs';

export function sharedDesktopToClose(snapshot, sharedPort, launched) {
  const mode = desktopMode(snapshot, sharedPort, launched);
  if (mode.mode === 'closed') return null;
  const candidate = snapshot.desktopRoots?.[0];
  if (mode.mode !== 'shared' || !sameProcess(launched, candidate)) {
    throw new Error('无法确认这是由本应用打开的 Codex，未关闭任何桌面。请先从 Codex 菜单退出，或在任务管理器中核对后结束对应进程。');
  }
  return { pid: candidate.pid, exe: candidate.exe, startedAt: candidate.startedAt };
}

export async function closeSharedDesktop({ inspect, initialSnapshot, sharedPort, launched, assertIdle, requestClose, terminate, captureTree }) {
  const before = initialSnapshot || await inspect();
  const identity = sharedDesktopToClose(before, sharedPort, launched);
  if (!identity) return before;
  // Both operations only read state. Neither can close a process until both
  // succeed; use the same fresh topology for this pre-close safety barrier.
  const [, captured] = await Promise.all([assertIdle(before), captureTree ? captureTree(identity) : null]);
  await requestClose(identity);
  const afterClose = await inspect();
  const remaining = sharedDesktopToClose(afterClose, sharedPort, identity);
  if (remaining || captured) {
    // Closing the last window may leave a tray-less Electron process alive.
    // Confirm task state again before ending only the recorded desktop process.
    await assertIdle(afterClose);
    await terminate(captured || remaining);
  }
  const after = await inspect();
  if (sharedDesktopToClose(after, sharedPort, identity)) throw new Error('本应用打开的 Codex 尚未完全退出，请稍后重试。');
  return after;
}

/** Independent task inventories run together; every barrier still reads live state. */
export async function checkIdleServices({ runtime, bridge }) {
  const results = await Promise.allSettled([runtime?.(), bridge?.()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [codex, feishu] = results.map(result => result.value);
  if (runtime && (codex?.ready !== true || !Number.isSafeInteger(codex.active) || codex.active < 0)) throw new Error('无法确认 Codex 的任务状态，请恢复连接后再退出。');
  if (codex?.active) throw new Error('还有 Codex 任务正在运行，请等任务完成，或先在 Codex 中停止任务，再退出应用。');
  if (bridge && (typeof feishu?.activeWork !== 'boolean' || !Array.isArray(feishu.conversations) || !Array.isArray(feishu.pendingRequests))) throw new Error('无法确认飞书任务状态，请稍后重试退出。');
  if (feishu?.activeWork || feishu?.conversations.some(conversation => conversation.busy) || feishu?.pendingRequests.length) throw new Error('飞书还有正在处理的消息，请稍后退出。');
  return feishu;
}

/** Wait on the child handle rather than repeatedly scanning every Windows process. */
export async function waitForChildExit(child, timeout = 6000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const done = exited => { clearTimeout(timer); child.off('exit', onExit); resolve(exited); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeout);
    child.once('exit', onExit);
    // A child can have exited just before its event listener was attached.
    if (child.exitCode !== null || child.signalCode !== null) done(true);
  });
}
