import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Shutdown observation only: isolated CODEX_HOME, no model request or bot client.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(project, 'artifacts', 'runtime-shutdown-probe.json');
const metadata = JSON.parse(await fs.readFile(path.join(os.homedir(), '.feishu-codex', 'shared-codex.pid.json'), 'utf8'));
const executable = metadata.executablePath;
if (process.platform !== 'win32' || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'codex.exe') {
  throw new Error('This diagnostic requires the installed Windows codex.exe.');
}
await fs.access(executable);
const port = 18794;
const wsUrl = `ws://127.0.0.1:${port}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-runtime-shutdown-'));
const report = { startedAt: new Date().toISOString(), scope: 'three isolated runtime shutdown observations; no model requests, Feishu client, or production changes', root, port, executable, passed: false, samples: [] };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX_|FEISHU_)/i.test(key)).map(([key, value]) => [key.toUpperCase(), value]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ps = source => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; ${source}`], { env: cleanEnv, windowsHide: true, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 }).trim());
async function assertFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
function inspectIdentity(processId) {
  return ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' -ErrorAction SilentlyContinue; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess); [pscustomobject]@{ processExists=[bool]$p; executableMatches=([bool]$p -and $p.ExecutablePath -ieq ${quote(executable)}); commandMatches=([bool]$p -and $p.CommandLine -match '\\bapp-server\\b' -and $p.CommandLine -match ${quote('--listen\\s+"?' + wsUrl.replaceAll('.', '\\.') + '(?:"|\\s|$)')}); startedAt=if($p){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null}; listeners=$listeners } | ConvertTo-Json -Depth 4 -Compress`);
}
function stopObserved(processId, startedAt) {
  const source = `
$expectedStart=[DateTimeOffset]::Parse(${quote(startedAt)}).UtcDateTime.Ticks
$candidate=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' -ErrorAction SilentlyContinue
if(-not $candidate -or $candidate.ExecutablePath -ine ${quote(executable)} -or $candidate.CreationDate.ToUniversalTime().Ticks -ne $expectedStart -or $candidate.CommandLine -notmatch '\\bapp-server\\b' -or $candidate.CommandLine -notmatch ${quote('--listen\\s+"?' + wsUrl.replaceAll('.', '\\.') + '(?:"|\\s|$)')}){throw 'Temporary runtime identity changed; no process was stopped.'}
$owners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue)
if($owners.Count -eq 0 -or @($owners | Where-Object {$_.OwningProcess -ne ${processId} -or $_.LocalAddress -ne '127.0.0.1'}).Count){throw 'Temporary runtime listener identity changed; no process was stopped.'}
$watch=[Diagnostics.Stopwatch]::StartNew()
Stop-Process -Id ${processId} -ErrorAction Stop
$waitErrors=@()
$null=Wait-Process -Id ${processId} -Timeout 15 -ErrorAction SilentlyContinue -ErrorVariable +waitErrors
$waitElapsed=$watch.ElapsedMilliseconds
$snapshots=@()
$stable=0
do {
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess)
  $remaining=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' -ErrorAction SilentlyContinue
  $sameIdentity=[bool]$remaining -and $remaining.ExecutablePath -ieq ${quote(executable)} -and $remaining.CreationDate.ToUniversalTime().Ticks -eq $expectedStart
  $otherOwners=@($listeners | Where-Object {$_.OwningProcess -ne ${processId}})
  $snapshots += [pscustomobject]@{elapsedMs=$watch.ElapsedMilliseconds; originalProcessExists=$sameIdentity; anyProcessWithIdExists=[bool]$remaining; listeners=$listeners}
  if($otherOwners.Count){break}
  if(-not $sameIdentity -and $listeners.Count -eq 0){$stable++}else{$stable=0}
  if($stable -ge 2){break}
  Start-Sleep -Milliseconds 200
} while($watch.ElapsedMilliseconds -lt 25000)
[pscustomobject]@{ waitElapsedMs=$waitElapsed; waitErrorIds=@($waitErrors | ForEach-Object {$_.FullyQualifiedErrorId}); immediateListenerPresent=($snapshots[0].listeners.Count -gt 0); released=($stable -ge 2); elapsedMs=$watch.ElapsedMilliseconds; snapshots=$snapshots } | ConvertTo-Json -Depth 6 -Compress
`;
  return ps(source);
}
let active;
let activeIdentity;
try {
  for (let index = 1; index <= 3; index++) {
    await assertFreePort();
    const codexHome = path.join(root, `codex-${index}`);
    await fs.mkdir(codexHome);
    const sample = { index, startedAt: new Date().toISOString(), isolatedCodexHome: codexHome };
    report.samples.push(sample);
    active = spawn(executable, ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', 'app-server', '--listen', wsUrl], { env: { ...cleanEnv, CODEX_HOME: codexHome }, cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnError;
    let stderr = '';
    active.once('error', error => { spawnError = error; });
    active.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1000); });
    sample.processId = active.pid;
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (active.exitCode !== null) throw new Error(`Temporary runtime exited before ready: ${stderr}`);
      try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await pause(200);
    }
    if (!ready) throw new Error('Temporary runtime did not become ready.');
    activeIdentity = inspectIdentity(active.pid);
    if (!activeIdentity.processExists || !activeIdentity.executableMatches || !activeIdentity.commandMatches || !activeIdentity.startedAt || !activeIdentity.listeners.length || activeIdentity.listeners.some(owner => owner.OwningProcess !== active.pid || owner.LocalAddress !== '127.0.0.1')) {
      throw new Error('Temporary runtime identity could not be confirmed.');
    }
    sample.processStartedAt = activeIdentity.startedAt;
    sample.identityConfirmed = true;
    sample.shutdown = stopObserved(active.pid, activeIdentity.startedAt);
    if (!sample.shutdown.released) throw new Error('Temporary runtime did not release its endpoint within the observation bound.');
    await pause(50);
    sample.childExitObserved = active.exitCode !== null || active.signalCode !== null;
    await assertFreePort();
    sample.finishedAt = new Date().toISOString();
    active = undefined;
    activeIdentity = undefined;
  }
  report.passed = report.samples.length === 3 && report.samples.every(sample => sample.identityConfirmed && sample.shutdown.released && sample.childExitObserved);
} catch (error) {
  report.error = error.message;
} finally {
  if (active && active.exitCode === null && active.signalCode === null) {
    try {
      // A live Node child handle still identifies the child created by this probe.
      const current = inspectIdentity(active.pid);
      if (current.processExists && current.executableMatches && current.commandMatches && (!activeIdentity || current.startedAt === activeIdentity.startedAt)) {
        active.kill();
        await pause(500);
        const after = inspectIdentity(active.pid);
        report.finalCleanup = { processId: active.pid, originalProcessGone: !after.processExists, listenerAbsent: after.listeners.length === 0 };
      }
    } catch (error) { report.cleanupError = error.message; }
  }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, artifact: reportPath, samples: report.samples.map(sample => ({ index: sample.index, processId: sample.processId, immediateListenerPresent: sample.shutdown?.immediateListenerPresent, released: sample.shutdown?.released, elapsedMs: sample.shutdown?.elapsedMs })), error: report.error }));
if (!report.passed) process.exitCode = 1;
