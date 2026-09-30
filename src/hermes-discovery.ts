import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export type HermesDashboardEndpoint = {
  baseUrl: string;
  token: string;
  pid?: number;
  version?: string;
  hermesHome?: string;
};

export type HermesDashboardCandidate = { baseUrl: string; pid?: number };

export type HermesDashboardDiscoveryOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable transports keep discovery tests independent of local processes. */
  fetch?: typeof globalThis.fetch;
  candidates?: () => Promise<HermesDashboardCandidate[]>;
};

let lastDashboard: HermesDashboardCandidate | undefined;

/** Discover the existing Hermes Desktop backend; never start another gateway. */
export async function discoverHermesDashboard(
  options: HermesDashboardDiscoveryOptions = {},
): Promise<HermesDashboardEndpoint> {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (options.baseUrl) {
    return inspectDashboard({ baseUrl: normalizeHermesDashboardUrl(options.baseUrl) }, request, timeoutMs);
  }

  // A Desktop backend receives a new port and token after restart. Cache only
  // its address and re-read the token from its own bootstrap page each time.
  if (lastDashboard && !options.candidates) {
    try {
      return await inspectDashboard(lastDashboard, request, timeoutMs);
    } catch {
      lastDashboard = undefined;
    }
  }

  const candidates = await (options.candidates ?? discoverWindowsDashboards)();
  for (const candidate of candidates) {
    try {
      const endpoint = await inspectDashboard(candidate, request, timeoutMs);
      if (!options.candidates) lastDashboard = { baseUrl: endpoint.baseUrl, pid: endpoint.pid };
      return endpoint;
    } catch {
      // A process can exit between the inventory and its health request.
    }
  }
  throw new Error('未找到可连接的 Hermes 桌面服务，请先打开 Hermes。');
}

/** Restrict token retrieval to a local backend, without credentials or redirects. */
export function normalizeHermesDashboardUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Hermes 服务地址无效。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Hermes 服务地址必须是本机 http://127.0.0.1:端口。');
  }
  return url.origin;
}

async function inspectDashboard(
  candidate: HermesDashboardCandidate,
  request: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<HermesDashboardEndpoint> {
  const baseUrl = normalizeHermesDashboardUrl(candidate.baseUrl);
  const statusResponse = await request(`${baseUrl}/api/status`, {
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  if (!statusResponse.ok) throw new Error('Hermes 桌面服务尚未就绪。');
  const status = await statusResponse.json() as Record<string, unknown>;
  if (typeof status.version !== 'string' || typeof status.hermes_home !== 'string') {
    throw new Error('该地址不是可识别的 Hermes 桌面服务。');
  }
  if (status.auth_required === true) {
    throw new Error('此 Hermes 服务需要独立登录，当前仅支持本机桌面服务。');
  }
  const pageResponse = await request(`${baseUrl}/`, {
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  if (!pageResponse.ok) throw new Error('无法读取 Hermes 桌面连接凭据。');
  const html = await pageResponse.text();
  const value = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
  let token: unknown;
  try { token = value ? JSON.parse(value) : undefined; } catch { /* Invalid bootstrap value. */ }
  if (typeof token !== 'string' || !token || token.length > 4_096 || /[\r\n]/.test(token)) {
    throw new Error('Hermes 桌面未提供可用的连接凭据，请重试或重新打开 Hermes。');
  }
  return { baseUrl, token, pid: candidate.pid, version: status.version, hermesHome: status.hermes_home };
}

async function discoverWindowsDashboards(): Promise<HermesDashboardCandidate[]> {
  if (process.platform !== 'win32') {
    throw new Error('请配置正在运行的 Hermes 本机服务地址。');
  }
  // Query listening ports only for Python processes running the known Hermes
  // dashboard entrypoint. Do not probe arbitrary local ports or shell inputs.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$taskProcesses = @(Get-CimInstance Win32_Process)
$taskCandidates = @($taskProcesses | Where-Object {
  $_.Name -match '^pythonw?\.exe$' -and
  $_.CommandLine -match '(?:-m\s+hermes_cli\.main|hermes[^\r\n]*?\.exe)\s+[^\r\n]*?\bdashboard\b'
})
$taskResults = @()
foreach ($taskProcess in $taskCandidates) {
  $taskOwner = $taskProcess
  $taskDesktop = $false
  for ($taskDepth = 0; $taskDepth -lt 5 -and $null -ne $taskOwner; $taskDepth++) {
    if ($taskOwner.Name -eq 'Hermes.exe') { $taskDesktop = $true; break }
    $taskParent = $taskOwner.ParentProcessId
    $taskOwner = $taskProcesses | Where-Object { $_.ProcessId -eq $taskParent } | Select-Object -First 1
  }
  $taskPorts = @(Get-NetTCPConnection -OwningProcess $taskProcess.ProcessId -State Listen -ErrorAction SilentlyContinue)
  foreach ($taskPort in $taskPorts) {
    if ($taskPort.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::')) {
      $taskResults += [PSCustomObject]@{
        pid = [int]$taskProcess.ProcessId
        port = [int]$taskPort.LocalPort
        ipv6 = $taskPort.LocalAddress -eq '::1'
        desktop = $taskDesktop
      }
    }
  }
}
ConvertTo-Json -InputObject @($taskResults | Sort-Object -Property @{Expression='desktop';Descending=$true}, pid, port -Unique) -Compress
`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stdout: string;
  try {
    ({ stdout } = await executeFile(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { windowsHide: true, timeout: 12_000, maxBuffer: 1_048_576, encoding: 'utf8' }));
  } catch {
    throw new Error('无法读取 Hermes 桌面服务状态，请确认 Hermes 已打开。');
  }
  let rows: unknown;
  try { rows = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as { pid?: unknown; port?: unknown; ipv6?: unknown };
    if (!Number.isInteger(item.pid) || !Number.isInteger(item.port)
        || Number(item.pid) <= 0 || Number(item.port) <= 0 || Number(item.port) > 65_535) return [];
    return [{ pid: Number(item.pid), baseUrl: `http://${item.ipv6 ? '[::1]' : '127.0.0.1'}:${item.port}` }];
  });
}
