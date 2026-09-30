export class UpdateCoordinator {
  constructor({ updater, onChange = () => {}, beforeInstall, currentVersion, latestReleaseTag }) {
    this.updater = updater;
    this.onChange = onChange;
    this.beforeInstall = beforeInstall;
    this.currentVersion = currentVersion;
    this.latestReleaseTag = latestReleaseTag;
    this.state = { phase: 'idle' };
    this.pending = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on('update-available', info => this.set({ phase: 'available', version: info.version }));
    updater.on('update-not-available', () => this.set({ phase: 'current' }));
    updater.on('download-progress', progress => this.set({ ...this.state, phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent ?? 0))) }));
    updater.on('update-downloaded', info => this.set({ phase: 'ready', version: info.version, percent: 100 }));
    updater.on('error', error => this.set({ phase: 'error', error: error.message || '更新失败，请稍后重试。' }));
  }

  getState() { return { ...this.state }; }
  set(next) { this.state = next; this.onChange(); }

  async check() {
    if (this.pending || ['downloading', 'ready', 'installing'].includes(this.state.phase)) return this.getState();
    this.set({ phase: 'checking' });
    try {
      this.pending = Promise.resolve().then(() => this.updater.checkForUpdates());
      await this.pending;
      if (this.state.phase === 'checking') this.set({ phase: 'current' });
      return this.getState();
    } catch (error) {
      if (/latest\.yml/i.test(error.message || '') && this.latestReleaseTag) {
        try {
          const tag = await this.latestReleaseTag();
          if (tag.replace(/^v/i, '') === this.currentVersion) {
            this.set({ phase: 'current' });
            return this.getState();
          }
        } catch { /* Keep the original update error. */ }
      }
      this.set({ phase: 'error', error: error.message || '检查更新失败。' });
      return this.getState();
    } finally { this.pending = null; }
  }

  async download() {
    if (this.state.phase !== 'available' || this.pending) throw new Error('当前没有可下载的新版本。');
    const version = this.state.version;
    this.set({ phase: 'downloading', version, percent: 0 });
    try {
      this.pending = Promise.resolve().then(() => this.updater.downloadUpdate());
      await this.pending;
      if (this.state.phase === 'downloading') this.set({ phase: 'ready', version, percent: 100 });
      return this.getState();
    } catch (error) {
      this.set({ phase: 'error', error: error.message || '下载更新失败。' });
      throw error;
    } finally { this.pending = null; }
  }

  async install() {
    if (this.state.phase !== 'ready' || this.pending) throw new Error('更新尚未下载完成。');
    const ready = this.getState();
    this.set({ ...ready, phase: 'installing' });
    try {
      const result = await this.beforeInstall();
      if (result?.cancelled) { this.set(ready); return result; }
      if (result?.ok !== true) throw new Error('尚未确认安全退出，更新已取消。');
      this.updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      this.set({ ...ready, error: error.message || '安装更新失败。' });
      throw error;
    }
  }
}
