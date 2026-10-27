import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson, runPowerShell } from './windows.mjs';
import { applicationExecutables } from './switch-desktop.mjs';
import { samePath } from './lifecycle.mjs';

// No runtime RPC, task inventory, port scan or shared-mode reclassification.
export async function forceQuitOwnedServices({ root, dataDir, callerPid = process.pid, run = runPowerShell }) {
  const deployment = await readJson(path.join(dataDir, 'desktop/deployment.json'));
  if (!deployment || !samePath(deployment.productRoot, root)) return { skipped: true, warnings: [] };
  const roots = [];
  for (const role of ['host', 'bridge', 'runtime', 'relay', 'desktop']) {
    const identity = await readJson(path.join(dataDir, 'desktop', `${role}-identity.json`)).catch(() => null);
    if (Number.isInteger(identity?.pid) && identity.pid > 0 && typeof identity.exe === 'string' && Number.isFinite(Date.parse(identity.startedAt))) {
      roots.push({ ...identity, role });
    }
  }
  const operationId = randomUUID(), file = path.join(dataDir, 'desktop', `force-exit-${operationId}.json`), resultFile = `${file}.result`;
  await atomicJson(file, { roots, callerPid, preserveExecutables: applicationExecutables(root) });
  try {
    await run(path.join(root, 'scripts/desktop-force-quit.ps1'), ['-InputFile', file, '-ResultFile', resultFile, '-OperationId', operationId],
      { timeout: 12_000, completion: { file: resultFile, operationId } });
    return await readJson(resultFile);
  } finally { await fs.unlink(file).catch(() => {}); await fs.unlink(resultFile).catch(() => {}); }
}
