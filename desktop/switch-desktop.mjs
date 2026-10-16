import path from 'node:path';
import { desktopMode, samePath, sameProcess } from './lifecycle.mjs';

export function applicationExecutables(productRoot) {
  const root = path.resolve(productRoot);
  return path.basename(root).toLowerCase() === 'product' && path.basename(path.dirname(root)).toLowerCase() === 'resources'
    ? [path.join(root, '..', '..', 'Feishu Codex.exe')]
    : [path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')];
}

export function independentDesktop(snapshot, sharedPort, launched) {
  const mode = desktopMode(snapshot, sharedPort, launched);
  if (mode.mode === 'shared' || mode.mode === 'closed') return null;
  const root = snapshot.desktopRoots?.[0];
  if (mode.mode !== 'independent' || snapshot.desktopRoots.length !== 1 || !root?.exe || !root.startedAt) {
    throw new Error('无法确认当前 Codex 的进程身份，请稍后重试连接。');
  }
  return { pid: root.pid, exe: root.exe, startedAt: root.startedAt };
}

export async function stopIndependentDesktop({ inspect, expected, sharedPort, launched, requestClose, terminate,
  preserveExecutables = [],
  settleMs = 3_000, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const before = await inspect();
  const root = independentDesktop(before, sharedPort, launched);
  if (!sameProcess(expected, root)) throw new Error('Codex 已重新打开或运行方式已变化，请重新点击“连接飞书”并确认。');
  const tree = new Set([root.pid]);
  let changed;
  do {
    changed = false;
    for (const item of before.processes) {
      if (tree.has(item.parentPid) && !tree.has(item.pid) && !preserveExecutables.some(exe => samePath(exe, item.exe))) {
        tree.add(item.pid); changed = true;
      }
    }
  } while (changed);
  const backends = before.processes.filter(item => tree.has(item.pid)
    && /(?:^|[\\/])codex\.exe$/i.test(item.exe ?? '') && /\bapp-server\b/.test(item.commandLine ?? ''));
  if (!backends.length || backends.some(item => !item.startedAt)) throw new Error('无法确认独立 Codex 的任务后台，请稍后重试。');
  // Confirmation explicitly authorizes ending running independent turns.
  // Capture their identities before closing the window, since children can
  // outlive their original parent and must never be selected by name alone.
  await requestClose(root);
  const protectedIdentity = identity => preserveExecutables.length ? { ...identity, preserveExecutables } : identity;
  await terminate(protectedIdentity(root));
  for (const backend of backends) await terminate(protectedIdentity({ pid: backend.pid, exe: backend.exe, startedAt: backend.startedAt }));
  const deadline = now() + settleMs;
  for (;;) {
    const after = await inspect();
    if (after.unknownDesktop) throw new Error('暂时无法确认 Codex 是否已退出，请重试连接；未启动第二个窗口。');
    if (after.desktopRoots.some(item => !sameProcess(expected, item))) {
      throw new Error('检测到新打开的 Codex，请重新点击“连接飞书”并确认；未关闭新窗口。');
    }
    const remaining = after.desktopRoots.length || after.processes.some(item => backends.some(backend => sameProcess(backend, item)));
    if (!remaining) return;
    if (now() >= deadline) throw new Error('Codex 尚未完全退出，请稍后重试连接；未启动第二个窗口。');
    // Windows can briefly retain terminated processes. Recheck their captured
    // identities without sending another close/kill request to a reused PID.
    await sleep(Math.min(200, Math.max(0, deadline - now())));
  }
}
