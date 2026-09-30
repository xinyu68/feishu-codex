import type { CodexRuntime, CodexRunInput, RuntimeConsultInput, RuntimeEvent } from './types.js';

export const isHermesThread = (threadId: string): boolean => threadId.startsWith('hermes:');

/** Route persisted session identities without ever submitting a Hermes session to Codex. */
export class RuntimeRouter implements CodexRuntime {
  readonly supportsSteering?: boolean;
  constructor(readonly codex: CodexRuntime, readonly hermes?: CodexRuntime) { this.supportsSteering = codex.supportsSteering; }
  forEngine(engine: 'codex' | 'hermes' = 'codex'): CodexRuntime {
    if (engine === 'codex') return this.codex;
    if (engine !== 'hermes') throw new Error('不支持的机器人执行端');
    if (!this.hermes) throw new Error('Hermes 本机接口尚未配置，请先连接 Hermes。');
    return this.hermes;
  }
  private forThread(id: string) { return this.forEngine(isHermesThread(id) ? 'hermes' : 'codex'); }
  run(input: CodexRunInput) { return (input.threadId ? this.forThread(input.threadId) : this.codex).run(input); }
  async consult(input: RuntimeConsultInput) {
    const runtime = this.forEngine(input.engine);
    if (!runtime.consult) throw new Error('当前执行端不支持独立咨询。');
    return runtime.consult(input);
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    const unsubscribe = [...new Set([this.codex, this.hermes])].flatMap(runtime => runtime?.subscribe ? [runtime.subscribe(listener)] : []);
    return () => { for (const stop of unsubscribe) stop(); };
  }
  async watchLoaded() { await this.codex.watchLoaded?.(); }
  async watch(id: string) { await this.forThread(id).watch?.(id); }
  async unwatch(id: string) { await this.forThread(id).unwatch?.(id); }
  stop(id: string) { return this.forThread(id).stop(id); }
  release(id: string) { return this.forThread(id).release(id); }
  models() { return this.codex.models(); }
  history(id: string) { return this.forThread(id).history(id); }
  status() { return this.codex.status(); }
  async threadInfo(id: string) {
    const runtime = this.forThread(id);
    if (!runtime.threadInfo) throw new Error('当前执行端暂不支持读取会话信息。');
    return runtime.threadInfo(id);
  }
  async turnStatus(id: string, turn: string) { return await this.forThread(id).turnStatus?.(id, turn) ?? 'unknown' as const; }
  async turnTiming(id: string, turn: string) { return await this.forThread(id).turnTiming?.(id, turn) ?? {}; }
  async updateGroupHandoffPolicy(id: string, instructions: string) { await this.forThread(id).updateGroupHandoffPolicy?.(id, instructions); }
  async usage() {
    if (!this.codex.usage) throw new Error('当前 Codex 后端暂不支持查询套餐余量。');
    return this.codex.usage();
  }
  async close() { await Promise.all([this.codex.close(), this.hermes?.close()]); }
}
