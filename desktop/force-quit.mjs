import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson, runPowerShell } from './windows.mjs';
import { applicationExecutables } from './switch-desktop.mjs';
import { samePath, sameProcess } from './lifecycle.mjs';

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

// A runtime upgrade ends only the verified idle backend. The host, desktop,
// Feishu connections and developer processes spawned by earlier tasks survive.
export async function stopOwnedRuntimeForUpgrade({ root, dataDir, identity, run = runPowerShell }) {
  const deployment = await readJson(path.join(dataDir, 'desktop/deployment.json'));
  const recorded = await readJson(path.join(dataDir, 'desktop/runtime-identity.json'));
  if (!samePath(deployment?.productRoot, root) || !sameProcess(recorded, identity)
    || identity.pid === process.pid || !/(?:^|[\\/])codex\.exe$/i.test(identity.exe)) throw Error('Codex 后台归属已变化，本次未切换。');
  const operationId = randomUUID(), file = path.join(dataDir, 'desktop', `runtime-upgrade-${operationId}.json`), resultFile = `${file}.result`;
  await atomicJson(file, { roots: [identity], callerPid: process.pid, rootOnly: true, preserveExecutables: applicationExecutables(root) });
  try {
    await run(path.join(root, 'scripts/desktop-force-quit.ps1'), ['-InputFile', file, '-ResultFile', resultFile, '-OperationId', operationId],
      { timeout: 12_000, completion: { file: resultFile, operationId } });
    const result = await readJson(resultFile);
    if (!result?.success || result.warnings?.length) throw Error('Codex 后台尚未退出，稍后重试；未停止其他服务。');
    return result;
  } finally { await fs.unlink(file).catch(() => {}); await fs.unlink(resultFile).catch(() => {}); }
}
