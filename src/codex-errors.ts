export const THREAD_WRITER_MESSAGE = '这个 Codex 会话仍被其他进程持有。桌面回复结束不代表已释放会话，当前桥接无法直接接管。若要继续原会话，请彻底退出持有它的 Codex 桌面 App 或 CLI 后重试；也可用 /session 选择其他已释放的会话，或用 /new 新建不含原会话历史的独立会话。';

export function isThreadWriterConflict(message: string): boolean {
  return /active writer|writer.*lock|thread.*locked|another process/i.test(message);
}

/** A new thread can be visible before its rollout metadata has reached disk. */
export function isThreadInitializationRace(message: string): boolean {
  return /no rollout found for thread id|failed to read session metadata[\s\S]*rollout[\s\S]*(?:is empty|not found)/i.test(message);
}
