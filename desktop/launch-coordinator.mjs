const DEFAULT_PREFERENCES = Object.freeze({ openCodexOnLaunch: true, closeWindowAction: 'tray' });
const INDEPENDENT_MESSAGE = 'Codex 已打开，但尚未连接飞书。点击“连接飞书”，确认后会重新打开 Codex。';

export function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(value, 'openCodexOnLaunch') || typeof value.openCodexOnLaunch !== 'boolean'
    || Object.keys(value).some(key => !['openCodexOnLaunch', 'closeWindowAction'].includes(key))
    || (value.closeWindowAction !== undefined && !['tray', 'quit'].includes(value.closeWindowAction))) {
    throw new TypeError('启动设置必须包含 openCodexOnLaunch 布尔值和有效的关闭窗口方式。');
  }
  return { openCodexOnLaunch: value.openCodexOnLaunch, closeWindowAction: value.closeWindowAction || 'tray' };
}

export class LaunchPreferences {
  constructor({ read, write }) { this.read = read; this.write = write; this.value = { ...DEFAULT_PREFERENCES }; this.pending = Promise.resolve(); }
  async load() {
    const stored = await this.read();
    try { this.value = validatePreferences(stored); } catch { this.value = { ...DEFAULT_PREFERENCES }; }
    return this.get();
  }
  get() { return { ...this.value }; }
  set(value) {
    const next = validatePreferences(value);
    const operation = this.pending.catch(() => {}).then(async () => { await this.write(next); this.value = next; return this.get(); });
    this.pending = operation;
    return operation;
  }
}

// Automatic startup only opens/focuses Codex. Restarting an independent
// desktop requires a separate explicit action and a native confirmation.
export class LaunchCoordinator {
  constructor({ openCodex, prepareSwitch, confirmSwitch, restartCodex, onChange = () => {}, now = Date.now, readyTimeoutMs = 90_000, hidden = false }) {
    this.open = openCodex; this.onChange = onChange; this.now = now;
    this.prepareSwitch = prepareSwitch; this.confirmSwitch = confirmSwitch; this.restart = restartCodex;
    this.readyTimeoutMs = readyTimeoutMs; this.hidden = hidden;
    this.state = { state: 'idle' }; this.status = null; this.intent = null; this.inFlight = null; this.startupRequested = false;
  }
  getState() { return { ...this.state }; }
  publish(state) {
    if (this.state.state === state.state && this.state.message === state.message) return;
    this.state = state; this.onChange(this.getState());
  }
  start(preferences) {
    if (this.startupRequested) return this.getState();
    this.startupRequested = true;
    return this.requestAutoOpen(preferences);
  }
  requestAutoOpen(preferences) {
    if (!validatePreferences(preferences).openCodexOnLaunch || this.hidden) return this.getState();
    if (this.inFlight || this.intent) return this.getState();
    this.intent = { kind: 'startup', deadline: null };
    this.publish({ state: 'opening', message: '正在准备飞书服务，就绪后会自动打开 Codex。' });
    this.evaluate();
    return this.getState();
  }
  update(status) {
    this.status = status;
    if (!this.inFlight && this.state.state === 'error' && status?.desktop?.mode === 'shared') this.publish({ state: 'idle' });
    this.evaluate();
    return this.getState();
  }
  evaluate() {
    if (!this.intent || this.inFlight) return;
    if (this.intent.kind === 'startup' && (!this.status || this.status.state === 'setup')) { this.intent.deadline = null; return; }
    if (this.intent.deadline === null) this.intent.deadline = this.now() + this.readyTimeoutMs;
    if (this.now() >= this.intent.deadline) {
      this.intent = null;
      this.publish({ state: 'error', message: '等待服务就绪超时。可以重试连接，就绪后手动打开 Codex；不会自动重复启动。' });
      return;
    }
    const mode = this.status?.desktop?.mode;
    if (mode === 'shared') { this.intent = null; this.publish({ state: 'idle' }); return; }
    if (mode === 'independent' && this.intent.kind === 'startup') {
      this.intent = null; this.publish({ state: 'error', message: INDEPENDENT_MESSAGE }); return;
    }
    if (mode !== 'closed' || this.status?.canWrite !== true) return;
    this.intent = null;
    if (this.hidden) { this.publish({ state: 'idle' }); return; }
    void this.launch().catch(() => {});
  }
  openCodex() {
    if (this.inFlight) return this.inFlight;
    this.intent = null;
    const mode = this.status?.desktop?.mode;
    if (mode === 'independent') return this.reject(INDEPENDENT_MESSAGE);
    if (mode !== 'shared' && (mode !== 'closed' || this.status?.canWrite !== true)) return this.reject('后台尚未准备好。请等待服务就绪，或重试连接后再打开 Codex。');
    return this.launch();
  }
  reject(message) { this.publish({ state: 'error', message }); return Promise.reject(new Error(message)); }
  launch() {
    if (this.inFlight) return this.inFlight;
    this.publish({ state: 'opening', message: '正在打开连接飞书的 Codex…' });
    const operation = Promise.resolve().then(() => this.open()).then(result => {
      this.publish({ state: 'idle' }); return result;
    }, error => {
      this.publish({ state: 'error', message: error?.message || 'Codex 暂时无法打开，请查看日志后重试。' }); throw error;
    }).finally(() => { if (this.inFlight === operation) this.inFlight = null; });
    this.inFlight = operation;
    return operation;
  }
  switchToShared() {
    if (this.inFlight) return this.inFlight;
    this.intent = null;
    if (this.hidden) return Promise.resolve({ ok: false, cancelled: true });
    const operation = Promise.resolve().then(async () => {
      const target = await this.prepareSwitch();
      if (!target.desktop) return this.open();
      this.publish({ state: 'confirming', message: '请确认是否重启 Codex 并连接飞书。' });
      if (!await this.confirmSwitch()) return { ok: false, cancelled: true };
      this.publish({ state: 'switching', message: '正在重启 Codex 并连接飞书…' });
      return this.restart(target.desktop);
    }).then(result => { this.publish({ state: 'idle' }); return result; }, error => {
      this.publish({ state: 'error', message: error?.message || '连接飞书失败，请重试。' }); throw error;
    }).finally(() => { if (this.inFlight === operation) this.inFlight = null; });
    this.inFlight = operation;
    return operation;
  }
  cancelPending() {
    if (this.intent) { this.intent = null; this.publish({ state: 'idle' }); }
  }
}
