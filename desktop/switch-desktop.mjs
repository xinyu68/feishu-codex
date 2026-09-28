import { desktopMode, sameProcess } from './lifecycle.mjs';

export function independentDesktop(snapshot, sharedPort, launched) {
  const mode = desktopMode(snapshot, sharedPort, launched);
  if (mode.mode === 'shared' || mode.mode === 'closed') return null;
  const root = snapshot.desktopRoots?.[0];
  if (mode.mode !== 'independent' || snapshot.desktopRoots.length !== 1 || !root?.exe || !root.startedAt) {
    throw new Error('无法确认当前 Codex 的进程身份，请稍后重试连接。');
  }
  return { pid: root.pid, exe: root.exe, startedAt: root.startedAt };
}

export async function stopIndependentDesktop({ inspect, expected, sharedPort, launched, requestClose, terminate }) {
  const before = await inspect();
  const root = independentDesktop(before, sharedPort, launched);
  if (!sameProcess(expected, root)) throw new Error('Codex 已重新打开或运行方式已变化，请重新点击“连接飞书”并确认。');
  const tree = new Set([root.pid]);
  let changed;
  do {
    changed = false;
    for (const item of before.processes) {
      if (tree.has(item.parentPid) && !tree.has(item.pid)) { tree.add(item.pid); changed = true; }
    }
  } while (changed);
  const backends = before.processes.filter(item => tree.has(item.pid)
    && /(?:^|[\\/])codex\.exe$/i.test(item.exe ?? '') && /\bapp-server\b/.test(item.commandLine ?? ''));
  if (!backends.length || backends.some(item => !item.startedAt)) throw new Error('无法确认独立 Codex 的任务后台，请稍后重试。');
  // Confirmation explicitly authorizes ending running independent turns.
  // Capture their identities before closing the window, since children can
  // outlive their original parent and must never be selected by name alone.
  await requestClose(root);
  await terminate(root);
  for (const backend of backends) await terminate({ pid: backend.pid, exe: backend.exe, startedAt: backend.startedAt });
  const after = await inspect();
  if (after.unknownDesktop || after.desktopRoots.length || after.processes.some(item => backends.some(backend => sameProcess(backend, item)))) {
    throw new Error('Codex 尚未完全退出或有新窗口打开，请重试连接。');
  }
}
