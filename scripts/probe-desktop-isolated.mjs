import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { probeDesktopTurns } from './probe-desktop-turns.mjs';
import assert from 'node:assert/strict';

// Diagnostic App instance with a temporary desktop profile; no bot consumer or
// production launch/configuration changes. Default mode uses an empty CODEX_HOME.
// --inspect-test-ui reads the normal account data; --verify-turns also writes
// only to the pinned disposable test thread (see probe-desktop-turns.mjs).
const executable = process.argv[2];
if (process.platform !== 'win32' || !executable || !path.isAbsolute(executable)
    || path.basename(executable).toLowerCase() !== 'chatgpt.exe') {
  throw new Error('Usage: node scripts/probe-desktop-isolated.mjs <absolute installed ChatGPT.exe path>');
}
await fs.access(executable);
const port = 19377;
const testListener = net.createServer();
await new Promise((resolve, reject) => { testListener.once('error', reject); testListener.listen(port, '127.0.0.1', resolve); });
await new Promise(resolve => testListener.close(resolve));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-desktop-control-probe-'));
const profile = path.join(root, 'profile');
const verifyTurns = process.argv.includes('--verify-turns');
const inspectUiOnly = process.argv.includes('--inspect-test-ui');
const sharedRuntimeOption = process.argv.indexOf('--shared-runtime');
const sharedExecutable = sharedRuntimeOption >= 0 ? process.argv[sharedRuntimeOption + 1] : undefined;
if (sharedRuntimeOption >= 0 && (!sharedExecutable || !path.isAbsolute(sharedExecutable) || path.basename(sharedExecutable).toLowerCase() !== 'codex.exe')) {
  throw new Error('--shared-runtime requires an absolute codex.exe path');
}
if (sharedExecutable && (verifyTurns || inspectUiOnly)) throw new Error('Shared launch isolation must not read or write production Codex data');
const sharedUrl = sharedExecutable ? 'ws://127.0.0.1:18794' : undefined;
const useExistingCodexData = verifyTurns || inspectUiOnly;
const codexData = useExistingCodexData ? path.join(os.homedir(), '.codex') : path.join(root, 'codex');
await fs.mkdir(profile);
if (!useExistingCodexData) await fs.mkdir(codexData);

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  const upper = key.toUpperCase();
  if (upper.startsWith('CODEX_') || upper.startsWith('FEISHU_') || upper === 'ELECTRON_RUN_AS_NODE') continue;
  env[upper] = value;
}
Object.assign(env, {
  CODEX_HOME: codexData,
  CODEX_ELECTRON_USER_DATA_PATH: profile,
  CODEX_APP_SERVER_FORCE_CLI: '1',
});
if (sharedUrl) { delete env.CODEX_APP_SERVER_FORCE_CLI; env.CODEX_APP_SERVER_WS_URL = sharedUrl; }
const report = { startedAt: new Date().toISOString(), executable, root, port, isolatedDesktopProfile: true, isolatedCodexData: !useExistingCodexData, verifyTurns, inspectUiOnly };
report.testSharedEndpoint = sharedUrl;
report.scope = sharedUrl ? 'per-launch shared endpoint isolation; no model generation' : 'desktop direct-control compatibility';
let testRuntime;
let socket;
let app;
let isolatedPid;
const packageLaunch = process.argv.includes('--package-launch');
const packageMarker = path.join(root, 'package-launch.json');
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;
const pending = new Map();
let sequence = 0;
try {
  if (sharedUrl) {
    await fs.access(sharedExecutable);
    const free = net.createServer();
    await new Promise((resolve, reject) => { free.once('error', reject); free.listen(18794, '127.0.0.1', resolve); });
    await new Promise(resolve => free.close(resolve));
    testRuntime = spawn(sharedExecutable, ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', 'app-server', '--listen', sharedUrl], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    report.testRuntimePid = testRuntime.pid;
    let runtimeError = '';
    let runtimeSpawnError;
    testRuntime.once('error', error => { runtimeSpawnError = error; });
    testRuntime.stderr.on('data', data => { runtimeError = (runtimeError + data.toString()).slice(-1500); });
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      if (runtimeSpawnError) throw runtimeSpawnError;
      if (testRuntime.exitCode !== null) throw new Error(`Temporary runtime exited: ${runtimeError}`);
      try { ready = (await fetch('http://127.0.0.1:18794/readyz', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!ready) throw new Error('Temporary shared runtime did not become ready');
    const ownerCommand = `@(Get-NetTCPConnection -State Listen -LocalPort 18794 | Select-Object LocalAddress,OwningProcess) | ConvertTo-Json -Compress`;
    const owners = [JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ownerCommand], { windowsHide: true, encoding: 'utf8' }))].flat();
    assert(owners.length && owners.every(owner => owner.LocalAddress === '127.0.0.1' && owner.OwningProcess === testRuntime.pid), 'Temporary runtime listener ownership mismatch');
    report.testRuntimeListenerIdentityConfirmed = true;
  }
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`, '--no-first-run',
  ];
  if (packageLaunch) {
    const childScript = path.join(root, 'launch-isolated.ps1');
    const powershellPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const childSource = `$ErrorActionPreference='Stop'
$probeResult=@{wrapperPid=$PID;started=$false}
try {
  foreach ($probeKey in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($probeKey -like 'CODEX_*' -or $probeKey -like 'FEISHU_*' -or $probeKey -eq 'ELECTRON_RUN_AS_NODE') { [Environment]::SetEnvironmentVariable($probeKey,$null,'Process') }
  }
  $env:CODEX_HOME=${quotePowerShell(codexData)}
  $env:CODEX_ELECTRON_USER_DATA_PATH=${quotePowerShell(profile)}
  ${sharedUrl ? `$env:CODEX_APP_SERVER_WS_URL=${quotePowerShell(sharedUrl)}` : "$env:CODEX_APP_SERVER_FORCE_CLI='1'"}
  $probeStart=[Diagnostics.ProcessStartInfo]::new()
  $probeStart.FileName=${quotePowerShell(executable)}
  $probeStart.Arguments=${quotePowerShell(args.map(arg => `"${arg}"`).join(' '))}
  $probeStart.WorkingDirectory=${quotePowerShell(path.dirname(executable))}
  $probeStart.UseShellExecute=$false
  $probeStart.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $probeStart.CreateNoWindow=$true
  $probeStart.EnvironmentVariables['CODEX_HOME']=${quotePowerShell(codexData)}
  $probeStart.EnvironmentVariables['CODEX_ELECTRON_USER_DATA_PATH']=${quotePowerShell(profile)}
  ${sharedUrl ? `$probeStart.EnvironmentVariables.Remove('CODEX_APP_SERVER_FORCE_CLI')\n  $probeStart.EnvironmentVariables['CODEX_APP_SERVER_WS_URL']=${quotePowerShell(sharedUrl)}` : "$probeStart.EnvironmentVariables['CODEX_APP_SERVER_FORCE_CLI']='1'\n  $probeStart.EnvironmentVariables.Remove('CODEX_APP_SERVER_WS_URL')"}
  $probeChild=[Diagnostics.Process]::Start($probeStart)
  $probeResult.pid=$probeChild.Id
  $probeResult.started=$true
  [IO.File]::WriteAllText(${quotePowerShell(packageMarker)},($probeResult | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $probeChild.WaitForExit()
} catch {
  $probeResult.error=$_.Exception.Message
  [IO.File]::WriteAllText(${quotePowerShell(packageMarker)},($probeResult | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  exit 1
}
`;
    await fs.writeFile(childScript, childSource);
    const launch = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; try { Invoke-CommandInDesktopPackage -PackageFamilyName 'OpenAI.Codex_2p2nqsd0c76g0' -AppId 'App' -Command ${quotePowerShell(powershellPath)} -Args ${quotePowerShell(`-NoProfile -NonInteractive -WindowStyle Hidden -File "${childScript}"`)} -PreventBreakaway } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    app = spawn(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', launch], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';
    app.stderr.on('data', data => { errorOutput = (errorOutput + data.toString()).slice(0, 2000); });
    app.once('exit', code => { if (code) report.launchError = errorOutput.trim(); });
    report.launchMethod = 'Invoke-CommandInDesktopPackage (diagnostics only)';
  } else if (process.argv.includes('--shell-launch')) {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const launch = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; try { $probeApp = Start-Process -FilePath ${quote(executable)} -ArgumentList ${quote(args.map(arg => `"${arg}"`).join(' '))} -WorkingDirectory ${quote(path.dirname(executable))} -WindowStyle Hidden -PassThru; Write-Output $probeApp.Id; $probeApp.WaitForExit() } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    app = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    app.stdout.on('data', data => {
      output += data.toString();
      const match = output.match(/^\s*(\d+)\s*$/m);
      if (match) { isolatedPid = Number(match[1]); report.pid = isolatedPid; }
    });
    let errorOutput = '';
    app.stderr.on('data', data => { errorOutput = (errorOutput + data.toString()).slice(0, 2000); });
    app.once('exit', code => { if (code) report.launchError = errorOutput.trim(); });
    report.launchMethod = 'Start-Process';
  } else {
    app = spawn(executable, args, { cwd: path.dirname(executable), env, windowsHide: true, stdio: 'ignore' });
    isolatedPid = app.pid;
    report.pid = isolatedPid;
    report.launchMethod = 'CreateProcess';
  }
  const appError = new Promise((_, reject) => app.once('error', reject));
  const discovery = (async () => {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      if (packageLaunch) {
        let marker;
        try { marker = JSON.parse(await fs.readFile(packageMarker, 'utf8')); } catch {}
        if (marker) {
          report.packageWrapperPid = marker.wrapperPid;
          if (marker.pid) { isolatedPid = marker.pid; report.pid = isolatedPid; }
          if (marker.error) throw new Error(`Package context launch: ${marker.error}`);
        }
      }
      if (app.exitCode !== null && (!packageLaunch || app.exitCode !== 0)) throw new Error(`Isolated launcher exited (${app.exitCode}) before CDP became available`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const targets = await response.json();
          if (Array.isArray(targets) && targets.some(target => target.type === 'page' && target.url?.startsWith('app://'))) return targets;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Isolated app did not expose a CDP endpoint within 35 seconds');
  })();
  const targets = await Promise.race([discovery, appError]);
  if (!Number.isSafeInteger(isolatedPid)) throw new Error('Isolated process identity unavailable');
  const identityCommand = `$probeApp = Get-CimInstance Win32_Process -Filter 'ProcessId=${isolatedPid}'; if ($probeApp -and $probeApp.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { 'isolated' }`;
  if (execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', identityCommand], { windowsHide: true, encoding: 'utf8' }).trim() !== 'isolated') {
    throw new Error('Debug process isolation could not be confirmed');
  }
  const listenerCommand = `$ErrorActionPreference='Stop'; $probeProcesses=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $probeListeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port}); if (-not $probeListeners.Count) { exit 1 }; foreach ($probeListener in $probeListeners) { if ($probeListener.LocalAddress -notin @('127.0.0.1','::1')) { exit 1 }; $probeOwner=[int]$probeListener.OwningProcess; $probeSeen=@{}; while ($probeOwner -ne ${isolatedPid}) { if ($probeSeen.ContainsKey($probeOwner)) { exit 1 }; $probeSeen[$probeOwner]=$true; $probeParent=$probeProcesses | Where-Object ProcessId -eq $probeOwner | Select-Object -First 1; if (-not $probeParent -or $probeParent.ParentProcessId -eq 0) { exit 1 }; $probeOwner=[int]$probeParent.ParentProcessId } }; 'isolated-listener'`;
  if (execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', listenerCommand], { windowsHide: true, encoding: 'utf8' }).trim() !== 'isolated-listener') {
    throw new Error('CDP listener does not belong to the isolated app process tree');
  }
  report.listenerIsolationConfirmed = true;
  const topologyCommand = `$probeAll=@(Get-CimInstance Win32_Process); $probeIds=@(${isolatedPid}); do { $probeMore=@($probeAll | Where-Object { $probeIds -contains [int]$_.ParentProcessId -and $probeIds -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $probeIds+= $probeMore } while ($probeMore.Count); $probeShared=@(Get-NetTCPConnection -State Established -RemotePort 18791 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); @($probeAll | Where-Object { $probeIds -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;connectsToShared=($probeShared -contains $_.ProcessId);hasTemporaryRootArg=($_.CommandLine -like '*${root.replaceAll("'", "''")}*')} }) | ConvertTo-Json -Compress`;
  report.processTree = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', topologyCommand], { windowsHide: true, encoding: 'utf8' }));
  report.connectsToProductionSharedRuntime = [report.processTree].flat().some(process => process.connectsToShared);
  report.targets = targets.map(target => ({ type: target.type, url: target.url, title: target.title }));
  const page = targets.find(target => target.type === 'page' && target.url?.startsWith('app://'));
  if (!page) throw new Error('No app:// desktop page in isolated CDP instance');
  const url = new URL(page.webSocketDebuggerUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port) throw new Error('Unexpected debug endpoint');
  socket = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 3000 });
  socket.on('error', () => {});
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  function rpc(method, params, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  // Only reads interface shape. Does not navigate, dispatch an app message,
  // inspect login tokens, or read any conversation.
  const evaluated = await rpc('Runtime.evaluate', {
    expression: `JSON.stringify({ origin: location.origin, pathname: location.pathname, electronBridgeType: typeof window.electronBridge, bridgeMethods: Object.keys(window.electronBridge || {}).sort(), sendMessageFromViewType: typeof window.electronBridge?.sendMessageFromView })`,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error('Read-only interface inspection failed');
  report.interface = JSON.parse(evaluated.result.value);
  report.cdpReadOnlyPassed = true;
  if (report.interface.sendMessageFromViewType === 'function') {
    // Current production renderer channel, not the removed debug App Actions.
    // Return only identifiers/status, never message content or login credentials.
    const response = await rpc('Runtime.evaluate', {
      expression: `(async () => {
        const id = crypto.randomUUID();
        return await new Promise(resolve => {
          let timer;
          const finish = result => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(JSON.stringify(result)); };
          const receive = event => {
            const value = event.data;
            if (value?.type !== 'mcp-response' || value.hostId !== 'local' || value.message?.id !== id) return;
            const message = value.message;
            finish(message.error ? { ok: false, error: message.error.message }
              : Array.isArray(message.result?.data) ? { ok: true, threadCount: message.result.data.length, sample: message.result.data.map(t => ({ id: t.id, cwd: t.cwd, path: t.path, status: t.status?.type })) }
              : { ok: false, error: 'Unexpected thread/list response shape' });
          };
          window.addEventListener('message', receive);
          timer = setTimeout(() => finish({ ok: false, error: 'Read-only thread/list timed out' }), 10000);
          Promise.resolve(window.electronBridge.sendMessageFromView({ type: 'mcp-request', hostId: 'local', request: { id, method: 'thread/list', params: { limit: 1 } }, priority: 'background', timeoutMs: 9000 })).catch(error => finish({ ok: false, error: String(error) }));
        });
      })()`,
      awaitPromise: true, returnByValue: true,
    }, 15000);
    if (response.exceptionDetails) throw new Error('Read-only backend channel probe failed');
    report.backendReadOnly = JSON.parse(response.result.value);
    if (!report.backendReadOnly.ok) throw new Error(`Backend channel failed: ${report.backendReadOnly.error}`);
  } else {
    throw new Error('The current renderer does not expose the expected bridge method');
  }
  if (report.connectsToProductionSharedRuntime) throw new Error('Read-only desktop channel works, but test app still connects to the production shared runtime; backend isolation is not established');
  if (sharedUrl) {
    const ids = [report.processTree].flat().map(item => item.pid);
    const endpointCommand = `$probeConnections=@(Get-NetTCPConnection -State Established -RemotePort 18794 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in @(${ids.join(',')}) -and $_.RemoteAddress -eq '127.0.0.1' } | Select-Object OwningProcess,RemotePort); ConvertTo-Json -InputObject $probeConnections -Compress`;
    report.testEndpointConnections = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', endpointCommand], { windowsHide: true, encoding: 'utf8' }));
    assert.ok(report.testEndpointConnections.length, 'Temporary App did not connect to its per-launch shared endpoint');
    assert.ok(![report.processTree].flat().some(item => item.name.toLowerCase() === 'codex.exe'), 'Shared App unexpectedly launched its own codex.exe backend');
    assert.equal(report.backendReadOnly.threadCount, 0, 'Temporary App must read the empty test runtime, not production history');
    report.sharedEndpointIsolationPassed = true;
  }
  if (useExistingCodexData) {
    if (![report.processTree].flat().some(process => process.name.toLowerCase() === 'codex.exe')) throw new Error('No app-owned backend process was observed; refusing write tests');
    await probeDesktopTurns({ rpc, report, cwd: fileURLToPath(new URL('../examples/workspace', import.meta.url)), inspectUiOnly });
  }
  report.passed = true;
} catch (error) {
  report.cdpReadOnlyPassed ??= false;
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  socket?.terminate();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Probe closed')); }
  // Stop only an exact PID whose command line still identifies this temporary
  // profile. Never search/kill by executable name or touch the existing desktop.
  if (Number.isSafeInteger(isolatedPid)) {
    const cleanup = `$probeApp = Get-CimInstance Win32_Process -Filter 'ProcessId=${isolatedPid}'; if (-not $probeApp) { 'root-exited-descendants-unverified' } elseif ($probeApp.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { & taskkill.exe /PID ${isolatedPid} /T /F | Out-Null; if ($LASTEXITCODE -eq 0) { 'stopped' } }`;
    try {
      report.isolatedProcessStopped = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cleanup], { windowsHide: true, encoding: 'utf8' }).trim() === 'stopped';
    } catch { report.isolatedProcessStopped = false; }
  }
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    try {
      // The wrapper belongs only to this probe; its own handle guards PID reuse.
      if (process.argv.includes('--shell-launch') || packageLaunch) app.kill();
      else if (report.isolatedProcessStopped === undefined) app.kill();
    } catch {
      report.wrapperCleanupFailed = true;
    }
  }
  report.isolatedProcessStopped ??= !isolatedPid;
  const recordedPids = [...new Set([isolatedPid, report.packageWrapperPid, ...[report.processTree ?? []].flat().map(item => item.pid)].filter(Number.isSafeInteger))];
  if (recordedPids.length) {
    try {
      const verification = `$probeRemaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${recordedPids.join(',')}) } | Select-Object -ExpandProperty ProcessId); $probeListeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); [pscustomobject]@{remainingPids=$probeRemaining;debugListenerPresent=($probeListeners.Count -gt 0)} | ConvertTo-Json -Compress`;
      report.cleanupVerification = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verification], { windowsHide: true, encoding: 'utf8' }));
      report.isolatedProcessStopped = report.cleanupVerification.remainingPids.length === 0 && !report.cleanupVerification.debugListenerPresent;
    } catch (error) { report.cleanupVerificationError = error.message; }
  }
  if (testRuntime?.pid && testRuntime.exitCode === null) {
    // Exact child handle; this process was created by this probe with an empty CODEX_HOME.
    testRuntime.kill();
    await Promise.race([new Promise(resolve => testRuntime.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (sharedUrl && testRuntime?.pid) {
    const verifyRuntime = `$probeProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${testRuntime.pid}'; $probeListeners=@(Get-NetTCPConnection -State Listen -LocalPort 18794 -ErrorAction SilentlyContinue); [pscustomobject]@{processExited=($null -eq $probeProcess);listenerAbsent=($probeListeners.Count -eq 0)} | ConvertTo-Json -Compress`;
    report.testRuntimeCleanup = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verifyRuntime], { windowsHide: true, encoding: 'utf8' }));
    if (!report.testRuntimeCleanup.processExited || !report.testRuntimeCleanup.listenerAbsent) { report.passed = false; report.error ??= 'Temporary shared runtime cleanup failed'; process.exitCode = 1; }
  }
  if (!report.isolatedProcessStopped || report.wrapperCleanupFailed) {
    report.passed = false;
    report.error ??= 'Temporary process cleanup was not confirmed; inspect the recorded PID before retrying';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  if (packageLaunch) report.launchCaveat = 'Microsoft documents package-context launches as debugging only; passing does not establish normal production launch compatibility.';
  report.notes = [verifyTurns ? 'Only the pre-existing dedicated test thread may be resumed, sent prompts, steered, or stopped; standard account credentials are read in place, never copied.' : 'No conversation was created, resumed, sent a prompt, steered, or stopped.', 'The probe does not change production app or bridge settings.'];
  await fs.writeFile(path.join(root, 'probe-result.json'), `${JSON.stringify(report, null, 2)}\n`);
  const artifactDirectory = new URL('../artifacts/', import.meta.url);
  await fs.mkdir(artifactDirectory, { recursive: true });
  await fs.writeFile(new URL('desktop-isolated-probe-latest.json', artifactDirectory), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
