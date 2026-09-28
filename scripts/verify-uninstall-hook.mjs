import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, closeWindowsInspectors, inspectWindows } from '../desktop/windows.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

// Compile and run the real NSIS hook in a disposable harness. This deliberately
// does not install/uninstall the product or register application associations.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-uninstall-nsis-'));
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis-3.0.4.1');
const versions = await fs.readdir(cache);
const compiler = (await Promise.all(versions.map(async name => {
  const candidate = path.join(cache, name, 'Bin', 'makensis.exe');
  return await fs.stat(candidate).catch(() => null) ? candidate : null;
}))).find(Boolean);
assert.ok(compiler, 'NSIS compiler required after package:win');
const installDir = path.join(directory, '安装目录'), dataDir = path.join(directory, '数据');
const marker = path.join(directory, 'passed.txt');
const executable = path.join(directory, 'hook-test.exe');
const script = path.join(directory, 'hook-test.nsi');
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { windowsHide: true, env: canonicalEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 60_000);
  try { const [code] = await once(child, 'exit'); return { code, output }; }
  finally { clearTimeout(timer); }
}
await fs.writeFile(script, `\uFEFFUnicode true
Name "Feishu Codex uninstall hook test"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
OutFile "${quote(executable)}"
!include "LogicLib.nsh"
!define PROJECT_DIR "${quote(root)}"
!include "${quote(path.join(root, 'scripts', 'nsis-uninstall.nsh'))}"
InstallDir "${quote(installDir)}"
Section
  !insertmacro customCheckAppRunning
  !insertmacro feishuSafeStop Cleanup
  FileOpen $0 "${quote(marker)}" w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
`);
const build = await run(compiler, ['/V2', script]);
assert.equal(build.code, 0, build.output);
const env = { ...process.env, FEISHU_CODEX_DATA_DIR: dataDir };
await fs.mkdir(installDir, { recursive: true });
const fakeApp = path.join(installDir, 'Feishu Codex.exe');
await fs.copyFile(process.execPath, fakeApp);
const shell = spawn(fakeApp, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
await once(shell, 'spawn');
try {
  const success = await run(executable, ['/S'], env);
  assert.equal(success.code, 0, success.output);
  assert.equal(await fs.readFile(marker, 'utf8'), 'passed');
  assert.notEqual(shell.exitCode, null, '32-bit NSIS must inspect and release a real 64-bit application');
} finally { if (shell.exitCode === null) shell.kill(); }
await fs.unlink(marker);
const desktop = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
await once(desktop, 'spawn');
try {
  const snapshot = await inspectWindows(root, [18792], [desktop.pid]);
  const identity = snapshot.processes.find(value => value.pid === desktop.pid);
  await atomicJson(path.join(dataDir, 'desktop', 'desktop-identity.json'), identity);
  await atomicJson(path.join(dataDir, 'desktop', 'deployment.json'), { state: 'active', productRoot: path.join(installDir, 'resources', 'product') });
  const failure = await run(executable, ['/S'], env);
  assert.equal(failure.code, 1, failure.output);
  assert.equal(await fs.stat(marker).catch(() => null), null, 'NSIS must stop before deleting files');
  assert.equal(desktop.exitCode, null, 'unconfirmed Codex must remain alive');
  const report = { passed: true, directory, checks: ['NSIS embedded helpers execute with Chinese paths', '32-bit installer releases its 64-bit app using native PowerShell', 'both pre-delete phases succeed', 'silent failure exits with code 1 before subsequent file operations', 'unconfirmed desktop preserved'], finishedAt: new Date().toISOString() };
  await atomicJson(path.join(root, 'artifacts', 'uninstall-hook-verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally { desktop.kill(); closeWindowsInspectors(); }
