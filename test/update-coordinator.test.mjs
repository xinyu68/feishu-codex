import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { UpdateCoordinator } from '../desktop/update-coordinator.mjs';

class FakeUpdater extends EventEmitter {
  installs = 0;
  async checkForUpdates() { this.emit('update-available', { version: '0.3.3' }); }
  async downloadUpdate() {
    this.emit('download-progress', { percent: 48.6 });
    this.emit('update-downloaded', { version: '0.3.3' });
  }
  quitAndInstall() { this.installs++; }
}

test('downloads a new version but only installs after the safe-exit barrier', async () => {
  const updater = new FakeUpdater();
  let safeExit = false;
  const updates = new UpdateCoordinator({ updater, beforeInstall: async () => { safeExit = true; return { ok: true }; } });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal((await updates.check()).phase, 'available');
  assert.deepEqual(await updates.download(), { phase: 'ready', version: '0.3.3', percent: 100 });
  assert.equal(updater.installs, 0);
  await updates.install();
  assert.equal(safeExit, true);
  assert.equal(updater.installs, 1);
});

test('cancelled or blocked shutdown never launches the installer', async () => {
  const updater = new FakeUpdater();
  let result = { cancelled: true };
  const updates = new UpdateCoordinator({ updater, beforeInstall: async () => result });
  await updates.check();
  await updates.download();
  assert.deepEqual(await updates.install(), { cancelled: true });
  assert.equal(updates.getState().phase, 'ready');
  result = null;
  updates.beforeInstall = async () => { throw new Error('还有任务正在运行'); };
  await assert.rejects(updates.install(), /还有任务正在运行/);
  assert.equal(updater.installs, 0);
  assert.equal(updates.getState().phase, 'ready');
});

test('network check failures stay within the updater state', async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => { throw new Error('network offline'); };
  const updates = new UpdateCoordinator({ updater, beforeInstall: async () => ({ ok: true }) });
  assert.deepEqual(await updates.check(), { phase: 'error', error: 'network offline' });
  assert.equal(updater.installs, 0);
});

test('an older release without update metadata is current only at the same version', async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => { throw new Error('404 Cannot find latest.yml in GitHub release'); };
  const current = new UpdateCoordinator({ updater, currentVersion: '0.3.2', latestReleaseTag: async () => 'v0.3.2', beforeInstall: async () => ({ ok: true }) });
  assert.equal((await current.check()).phase, 'current');
  const missingNewer = new UpdateCoordinator({ updater, currentVersion: '0.3.2', latestReleaseTag: async () => 'v0.3.3', beforeInstall: async () => ({ ok: true }) });
  assert.equal((await missingNewer.check()).phase, 'error');
});
