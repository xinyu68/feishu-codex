import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runPowerShell } from '../desktop/windows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'scripts', 'desktop-migration-launch.ps1');
const fixture = `param([string]$ProductRoot,[string]$NodePath,[string]$DataDir,[string]$StatusFile,[string]$RunId,[string]$ExpectedUserSid,[switch]$NonInteractive,[switch]$WaitForDesktopExit,[switch]$CheckOnly,[string]$PreflightFile)
$ErrorActionPreference = 'Stop'
if ($CheckOnly) {
  $scenario = [IO.File]::ReadAllText((Join-Path $DataDir 'scenario.txt'))
  $report = @{ requiresElevation = $scenario -eq 'elevation'; blocked = $scenario -eq 'blocked'; checks = @(@{status='blocked';message='isolated preflight failure'}) }
  [IO.File]::WriteAllText($PreflightFile,($report | ConvertTo-Json -Depth 4))
  exit 0
}
if (-not $WaitForDesktopExit -or $ExpectedUserSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Wrong launch identity or wait mode' }
[IO.File]::WriteAllText((Join-Path $DataDir 'actual-called.txt'),'yes')
[IO.File]::WriteAllText($StatusFile,(@{status='succeeded';runId=$RunId;message='isolated completion'} | ConvertTo-Json))
exit 0
`;

for (const scenario of ['ready', 'blocked', 'elevation']) {
  test(`migration launch handles ${scenario} without touching production or displaying UAC`, { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-migration-launch-'));
    const productRoot = path.join(directory, 'product with spaces');
    const dataDir = path.join(directory, 'data');
    const statusFile = path.join(dataDir, 'desktop', 'migration-status.json');
    await fs.mkdir(path.join(productRoot, 'scripts'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(productRoot, 'scripts', 'desktop-migrate.ps1'), '\ufeff' + fixture);
    await fs.writeFile(path.join(dataDir, 'scenario.txt'), scenario);
    let entry = launcher;
    if (scenario === 'elevation') {
      // Intercept the OS dialog in this private PowerShell scope only. A real
      // Start-Process is never reached, and no production hook is introduced.
      entry = path.join(directory, 'cancel-elevation.ps1');
      await fs.writeFile(entry, '\ufeff' + `function Start-Process { param($FilePath,$Verb,$ArgumentList,$WindowStyle,[switch]$Wait,[switch]$PassThru)
if ($Verb -ne 'RunAs' -or $WindowStyle -ne 'Hidden') { throw 'Unexpected elevation request' }
throw [ComponentModel.Win32Exception]::new(1223)
}
& '${launcher.replaceAll("'", "''")}' @args
exit $LASTEXITCODE
`);
    }
    const args = ['-ProductRoot', productRoot, '-NodePath', process.execPath, '-DataDir', dataDir, '-StatusFile', statusFile, '-RunId', 'isolated-launch', '-NonInteractive', '-WaitForDesktopExit'];
    try {
      if (scenario === 'ready') await runPowerShell(entry, args);
      else await assert.rejects(runPowerShell(entry, args));
      const result = JSON.parse((await fs.readFile(statusFile, 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(result.status, scenario === 'ready' ? 'succeeded' : 'failed');
      if (scenario === 'blocked') assert.match(result.message, /isolated preflight failure/);
      if (scenario === 'elevation') assert.match(result.message, /授权已取消/);
      assert.equal(await fs.access(path.join(dataDir, 'actual-called.txt')).then(() => true, () => false), scenario === 'ready');
      assert.equal((await fs.readdir(path.join(dataDir, 'desktop'))).some(name => name.startsWith('elevated-migration-')), false);
    } finally {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith('feishu-migration-launch-'));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  });
}
