import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { powershell } from '../desktop/windows.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('task SDDL fixtures retain system/admin access, grant current user FA and reject denies', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-task-acl-'));
  const script = path.join(directory, 'fixture.ps1');
  const helper = path.join(root, 'scripts', 'desktop-task-security.ps1').replaceAll("'", "''");
  await fs.writeFile(script, `\uFEFF$ErrorActionPreference = 'Stop'
. '${helper}'
$sid = 'S-1-5-21-111-222-333-1001'
$before = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
$after = Get-DesktopTaskUserSddl $before $sid
if (-not (Test-DesktopTaskUserAccess $after $sid)) { throw 'Missing user FA' }
if ($after -notmatch '\\(A;;FA;;;SY\\)' -or $after -notmatch '\\(A;;FA;;;BA\\)') { throw 'System/admin ACE changed' }
if ((Get-DesktopTaskUserSddl $after $sid) -ne $after) { throw 'Not idempotent' }
$denied = $false
try { Get-DesktopTaskUserSddl ('O:BAG:BAD:(D;;FW;;;' + $sid + ')(A;;FA;;;SY)') $sid | Out-Null } catch { $denied = $true }
if (-not $denied) { throw 'Deny rule overwritten' }
$empty = $false
try { Get-DesktopTaskUserSddl 'O:BAG:BA' $sid | Out-Null } catch { $empty = $true }
if (-not $empty) { throw 'Null DACL accepted' }
Write-Output 'SDDL_FIXTURES_PASSED'
`, 'utf8');
  const result = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env: canonicalEnvironment(process.env), windowsHide: true });
  assert.match(result.stdout, /SDDL_FIXTURES_PASSED/);
});
