import path from 'node:path';
import { samePath } from './lifecycle.mjs';
import { atomicJson, readJson, runPowerShell } from './windows.mjs';

export async function restoreInstallation({ productRoot, nodePath, dataDir, prepare = runPowerShell }) {
  const file = path.join(dataDir, 'desktop', 'deployment.json');
  const previous = await readJson(file);
  await prepare(path.join(productRoot, 'scripts', 'desktop-restore-setup.ps1'),
    ['-ProductRoot', productRoot, '-NodePath', nodePath, '-DataDir', dataDir], { timeout: 60_000 });
  // Startup and task registration must succeed before changing the saved root.
  // The user's bot configuration, preferences and conversation bindings are not rewritten.
  if (!previous || !samePath(previous.productRoot, productRoot)) {
    if (previous) await atomicJson(path.join(dataDir, 'desktop', 'previous-installation.json'), previous);
    await atomicJson(file, { ...previous, version: 1, state: 'active', productRoot, restoredAt: new Date().toISOString() });
  }
}
