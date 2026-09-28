import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One isolated diagnostic launch. No login, model prompt, or Feishu consumer.
const project = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(project, 'artifacts', 'packaged-shared-launch-helper.json');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const port = 18794;
const protectedPids = [12464, 40760, 52240];
const environment = {};
for (const [key, value] of Object.entries(process.env)) environment[key.toUpperCase()] = value;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const runPowerShell = source => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${source}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: environment, timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] });
const jsonPowerShell = source => JSON.parse(runPowerShell(source).trim() || 'null');
const identity = ids => jsonPowerShell(`@(${ids.length ? `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${ids.join(',')}) } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name;startTime=$_.CreationDate.ToUniversalTime().ToString('o');exe=$_.ExecutablePath} }` : ''}) | ConvertTo-Json -Compress`);
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), port, expectedMode: 'Shared', passed: false, protectedPids, observations: [] };
let runtime;
let runtimeIdentity;
let appIdentity;
let temporaryRoot;
let launchResultPath;
let observedTree = [];

function topology(rootPid) {
  return jsonPowerShell(`$all=@(Get-CimInstance Win32_Process); $ids=@(${rootPid}); do { $more=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $ids+=$more } while ($more.Count); $connections=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -in @(18791,${port}) }); $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); [pscustomobject]@{tree=@($all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;startTime=$_.CreationDate.ToUniversalTime().ToString('o')} });connections=@($connections | Where-Object { $ids -contains [int]$_.OwningProcess } | ForEach-Object { [pscustomobject]@{pid=[int]$_.OwningProcess;localAddress=$_.LocalAddress;localPort=$_.LocalPort;remoteAddress=$_.RemoteAddress;remotePort=$_.RemotePort} });listeners=@($listeners | ForEach-Object { [pscustomobject]@{pid=[int]$_.OwningProcess;address=$_.LocalAddress;port=$_.LocalPort} })} | ConvertTo-Json -Depth 5 -Compress`);
}

try {
  if (process.platform !== 'win32') throw new Error('This diagnostic requires Windows.');
  report.productionBefore = asArray(identity(protectedPids));
  if (report.productionBefore.length !== protectedPids.length) throw new Error('Expected production processes were not all found; refusing to start.');
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => reserve.close(resolve));
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-shared-helper-probe-'));
  report.temporaryRoot = temporaryRoot;
  const desktopProfile = path.join(temporaryRoot, 'desktop profile');
  const codexHome = path.join(temporaryRoot, 'codex');
  await fs.mkdir(desktopProfile);
  await fs.mkdir(codexHome);
  launchResultPath = path.join(temporaryRoot, 'launch.json');
  const runtimeExecutable = report.productionBefore.find(item => item.pid === 40760).exe;
  if (!runtimeExecutable || path.basename(runtimeExecutable).toLowerCase() !== 'codex.exe') throw new Error('The production runtime executable could not be identified.');
  const runtimeEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('CODEX_') && !key.startsWith('FEISHU_') && key !== 'ELECTRON_RUN_AS_NODE'));
  runtimeEnvironment.CODEX_HOME = codexHome;
  runtime = spawn(runtimeExecutable, ['app-server', '--listen', `ws://127.0.0.1:${port}`], { env: runtimeEnvironment, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { runtime.once('spawn', resolve); runtime.once('error', reject); });
  runtimeIdentity = asArray(identity([runtime.pid]))[0];
  if (!runtimeIdentity || protectedPids.includes(runtime.pid)) throw new Error('Temporary runtime identity could not be verified.');
  report.runtime = runtimeIdentity;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    if (runtime.exitCode != null) throw new Error('The temporary runtime exited before becoming ready.');
    await delay(250);
  }
  if (!ready) throw new Error('The temporary runtime did not become ready.');
  report.runtimeReady = true;
  runPowerShell(`& ${quote(path.join(project, 'scripts', 'launch-packaged-probe.ps1'))} -Mode Shared -WsUrl ${quote(`ws://127.0.0.1:${port}`)} -ResultPath ${quote(launchResultPath)} -DesktopProfile ${quote(desktopProfile)} -CodexHome ${quote(codexHome)} | Out-Null`);
  report.launch = JSON.parse(await fs.readFile(launchResultPath, 'utf8'));
  if (!report.launch.started || report.launch.error || !Number.isInteger(report.launch.pid) || protectedPids.includes(report.launch.pid)) throw new Error('The helper did not return a valid isolated App process.');
  appIdentity = asArray(identity([report.launch.pid]))[0];
  if (!appIdentity || new Date(appIdentity.startTime).getTime() !== new Date(report.launch.startTime).getTime()) throw new Error('App PID/start time did not match the helper report.');
  report.app = appIdentity;
  let connectedAt;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const observation = topology(appIdentity.pid);
    observation.at = new Date().toISOString();
    observedTree = asArray(observation.tree);
    report.observations.push(observation);
    if (!observedTree.some(item => item.pid === appIdentity.pid)) throw new Error('The isolated App exited during verification.');
    if (observedTree.some(item => protectedPids.includes(item.pid))) throw new Error('A protected production PID appeared in the temporary App tree.');
    if (asArray(observation.listeners).length !== 1 || observation.listeners[0].pid !== runtimeIdentity.pid || observation.listeners[0].address !== '127.0.0.1') throw new Error('The test listener does not belong exclusively to the temporary runtime on loopback.');
    if (asArray(observation.connections).some(item => item.remotePort === 18791)) throw new Error('The temporary App connected to the production runtime.');
    if (observedTree.some(item => item.name.toLowerCase() === 'codex.exe')) throw new Error('The temporary App created its own Codex backend.');
    if (asArray(observation.connections).some(item => item.remotePort === port && item.remoteAddress === '127.0.0.1')) connectedAt ??= Date.now();
    else connectedAt = undefined;
    if (connectedAt && Date.now() - connectedAt >= 5000) { report.modeVerified = true; break; }
    await delay(750);
  }
  if (!report.modeVerified) throw new Error('No stable connection from the temporary App tree to its test runtime was observed.');
  report.passed = true;
} catch (error) {
  report.error = error.message;
} finally {
  // Retrieve a partially successful helper result before attempting cleanup.
  if (!report.launch && launchResultPath) {
    try { report.launch = JSON.parse(await fs.readFile(launchResultPath, 'utf8')); } catch {}
  }
  const appPid = appIdentity?.pid ?? report.launch?.pid;
  const appStartTime = appIdentity?.startTime ?? report.launch?.startTime;
  if (Number.isInteger(appPid) && !protectedPids.includes(appPid) && appStartTime && temporaryRoot) {
    try {
      const cleanup = jsonPowerShell(`$app=Get-CimInstance Win32_Process -Filter 'ProcessId=${appPid}'; if (-not $app) { [pscustomobject]@{rootAlreadyExited=$true;stopped=$false} | ConvertTo-Json -Compress; exit }; if ($app.CreationDate.ToUniversalTime().Ticks -ne [DateTime]::Parse(${quote(appStartTime)}).ToUniversalTime().Ticks -or -not $app.CommandLine.Contains(${quote(path.join(temporaryRoot, 'desktop profile'))})) { throw 'App cleanup identity check failed.' }; $all=@(Get-CimInstance Win32_Process); $ids=@(${appPid}); do { $more=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $ids+=$more } while ($more.Count); if (@($ids | Where-Object { $_ -in @(${protectedPids.join(',')}) }).Count) { throw 'Protected PID in cleanup tree.' }; $before=@($all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name;startTime=$_.CreationDate.ToUniversalTime().ToString('o')} }); & taskkill.exe /PID ${appPid} /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Exact isolated App tree cleanup failed.' }; [pscustomobject]@{stopped=$true;processes=$before} | ConvertTo-Json -Depth 4 -Compress`);
      report.appCleanup = cleanup;
      if (cleanup.processes) observedTree = asArray(cleanup.processes);
    } catch (error) { report.appCleanupError = error.message; report.passed = false; }
  }
  if (runtime && runtimeIdentity && !protectedPids.includes(runtimeIdentity.pid)) {
    try {
      const current = asArray(identity([runtimeIdentity.pid]))[0];
      if (current && current.startTime !== runtimeIdentity.startTime) throw new Error('Runtime cleanup identity changed.');
      if (current && runtime.exitCode == null) {
        report.runtimeCleanup = jsonPowerShell(`$runtime=Get-CimInstance Win32_Process -Filter 'ProcessId=${runtimeIdentity.pid}'; if (-not $runtime) { [pscustomobject]@{alreadyExited=$true} | ConvertTo-Json -Compress; exit }; if ($runtime.CreationDate.ToUniversalTime().Ticks -ne [DateTime]::Parse(${quote(runtimeIdentity.startTime)}).ToUniversalTime().Ticks -or -not $runtime.CommandLine.Contains('ws://127.0.0.1:${port}')) { throw 'Runtime cleanup identity check failed.' }; $all=@(Get-CimInstance Win32_Process); $ids=@(${runtimeIdentity.pid}); do { $more=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $ids+=$more } while ($more.Count); if (@($ids | Where-Object { $_ -in @(${protectedPids.join(',')}) }).Count) { throw 'Protected PID in runtime cleanup tree.' }; & taskkill.exe /PID ${runtimeIdentity.pid} /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Exact temporary runtime cleanup failed.' }; [pscustomobject]@{stopped=$true;pids=$ids} | ConvertTo-Json -Compress`);
      }
      await Promise.race([new Promise(resolve => runtime.exitCode != null ? resolve() : runtime.once('exit', resolve)), delay(5000)]);
    } catch (error) { report.runtimeCleanupError = error.message; report.passed = false; }
  }
  try {
    const recordedPids = [...new Set([appPid, runtimeIdentity?.pid, report.launch?.wrapperPid, ...observedTree.map(item => item.pid), ...asArray(report.runtimeCleanup?.pids)].filter(Number.isInteger))];
    const remaining = asArray(identity(recordedPids));
    const testListeners = jsonPowerShell(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=[int]$_.OwningProcess;address=$_.LocalAddress;port=$_.LocalPort} }) | ConvertTo-Json -Compress`);
    report.productionAfter = asArray(identity(protectedPids));
    report.cleanup = { remainingProcesses: remaining, testListeners: asArray(testListeners), productionUnchanged: JSON.stringify(report.productionBefore) === JSON.stringify(report.productionAfter) };
    if (remaining.length || asArray(testListeners).length || !report.cleanup.productionUnchanged) report.passed = false;
  } catch (error) { report.cleanupVerificationError = error.message; report.passed = false; }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ artifact, passed: report.passed, error: report.error, modeVerified: report.modeVerified, cleanup: report.cleanup, appCleanupError: report.appCleanupError, cleanupVerificationError: report.cleanupVerificationError }, null, 2));
if (!report.passed) process.exitCode = 1;
