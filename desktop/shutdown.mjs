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

export async function closeSharedDesktop({ inspect, sharedPort, launched, assertIdle, requestClose, terminate, captureTree }) {
  const identity = sharedDesktopToClose(await inspect(), sharedPort, launched);
  if (!identity) return;
  await assertIdle();
  const captured = captureTree ? await captureTree(identity) : null;
  await requestClose(identity);
  const remaining = sharedDesktopToClose(await inspect(), sharedPort, identity);
  if (remaining || captured) {
    // Closing the last window may leave a tray-less Electron process alive.
    // Confirm task state again before ending only the recorded desktop process.
    await assertIdle();
    await terminate(captured || remaining);
  }
  if (sharedDesktopToClose(await inspect(), sharedPort, identity)) throw new Error('本应用打开的 Codex 尚未完全退出，请稍后重试。');
}
