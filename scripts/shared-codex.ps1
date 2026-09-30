function Get-FeishuCodexDataRoot {
  param([string]$DataDir)
  $directory = if ($DataDir) { $DataDir } elseif ($env:FEISHU_CODEX_DATA_DIR) { $env:FEISHU_CODEX_DATA_DIR } else { Join-Path $env:USERPROFILE '.feishu-codex' }
  return [System.IO.Path]::GetFullPath($directory)
}

function Assert-FeishuCodexProcess {
  param([int]$ProcessId, [string]$DataDir, [string]$EntryPath)
  $lockPath = Join-Path (Get-FeishuCodexDataRoot $DataDir) 'service.lock'
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $candidate -or $candidate.Name -ine 'node.exe' -or $candidate.CommandLine -notmatch ('(?:^|\s)"?' + [regex]::Escape($EntryPath) + '(?:"|\s|$)')) { throw 'The listener is not this Feishu Codex bridge. No process was stopped.' }
  if (-not (Test-Path -LiteralPath $lockPath) -or [int](Get-Content -LiteralPath $lockPath -Raw).Trim() -ne $ProcessId) { throw 'The running bridge belongs to a different data directory. No process was stopped.' }
}

function Read-CodexRuntimeConfig {
  param([string]$DataDir)
  $file = Join-Path (Get-FeishuCodexDataRoot $DataDir) 'runtime.json'
  if (-not (Test-Path -LiteralPath $file)) { return [pscustomobject]@{ mode = 'per-turn'; wsUrl = 'ws://127.0.0.1:18791'; codexPath = ''; desktopPath = '' } }
  $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($config.mode -notin @('per-turn', 'shared')) { throw 'runtime.json mode must be per-turn or shared.' }
  if ($config.mode -eq 'shared' -and -not $config.wsUrl) { throw 'Shared runtime.json must specify wsUrl.' }
  if ($config.wsUrl) { $null = Get-CodexWebSocketUri $config.wsUrl }
  return $config
}

function Get-CodexWebSocketUri {
  param([string]$Url)
  $parsed = [uri]$Url
  if (-not $parsed.IsAbsoluteUri -or $parsed.Scheme -ne 'ws' -or $parsed.Host -ne '127.0.0.1' -or $parsed.Port -lt 1024 -or $parsed.Port -gt 65535 -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or $parsed.AbsolutePath -ne '/') {
    throw 'The shared Codex URL must be ws://127.0.0.1:<port>, with port 1024-65535.'
  }
  return $parsed
}

function Get-CodexDesktopProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -match '(?i)[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$' })
}

function Resolve-CodexDesktopPath {
  param([string]$ConfiguredPath)
  $resolved = $null
  if ($ConfiguredPath) {
    $resolved = [System.IO.Path]::GetFullPath($ConfiguredPath)
    if ([System.IO.Path]::GetFileName($resolved) -ine 'ChatGPT.exe') { throw 'desktopPath must identify the installed Codex ChatGPT.exe.' }
    if ($resolved -notmatch '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$') {
      if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'The configured custom desktopPath does not exist.' }
      return $resolved
    }
  }
  $running = Get-CodexDesktopProcesses | Select-Object -First 1
  if ($running) { return $running.ExecutablePath }
  $packages = @(Get-ChildItem -LiteralPath (Join-Path $env:ProgramFiles 'WindowsApps') -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue | Sort-Object @{ Expression = { if ($_.Name -match '^OpenAI\.Codex_([\d.]+)_') { [version]$Matches[1] } else { [version]'0.0' } }; Descending = $true })
  foreach ($package in $packages) {
    $candidate = Join-Path $package.FullName 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  if ($resolved -and (Test-Path -LiteralPath $resolved -PathType Leaf)) { return $resolved }
  throw 'Unable to locate Codex Desktop. Supply its installed ChatGPT.exe with -DesktopPath.'
}

function Resolve-SharedCodexPath {
  param([string]$ConfiguredPath)
  $resolved = $null
  if ($ConfiguredPath) {
    $resolved = [System.IO.Path]::GetFullPath($ConfiguredPath)
    if ([System.IO.Path]::GetFileName($resolved) -ine 'codex.exe') { throw 'codexPath must identify the native codex.exe.' }
    if ($resolved -notmatch '(?i)[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]codex\.exe$') {
      if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'The configured custom codexPath does not exist.' }
      return $resolved
    }
  }
  $desktopIds = @(Get-CodexDesktopProcesses | ForEach-Object { $_.ProcessId })
  $running = Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object { $desktopIds -contains $_.ParentProcessId -and $_.CommandLine -match '\bapp-server\b' } | Select-Object -First 1
  if ($running -and (Test-Path -LiteralPath $running.ExecutablePath -PathType Leaf)) { return $running.ExecutablePath }
  $binaryRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  $binaries = @(Get-ChildItem -LiteralPath $binaryRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $candidate = Join-Path $_.FullName 'codex.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
  } | Sort-Object LastWriteTime -Descending)
  if ($binaries.Count) { return $binaries[0].FullName }
  if ($resolved -and (Test-Path -LiteralPath $resolved -PathType Leaf)) { return $resolved }
  throw 'Unable to locate the native Codex binary. Supply -CodexPath.'
}

function Resolve-CodexMcpNodePath {
  param([string]$ConfiguredPath)
  $managedPattern = '(?i)[\\/]OpenAI[\\/]Codex[\\/]runtimes[\\/]cua_node[\\/][^\\/]+[\\/]bin[\\/]node(?:_repl)?\.exe$'
  $candidate = if ($ConfiguredPath) { [System.IO.Path]::GetFullPath($ConfiguredPath) } else { $env:CODEX_MCP_NODE_PATH }
  if ($candidate -and $candidate -notmatch $managedPattern) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'The configured custom MCP Node path does not exist.' }
    return $candidate
  }
  if ($env:CODEX_MCP_NODE_PATH -and (Test-Path -LiteralPath $env:CODEX_MCP_NODE_PATH -PathType Leaf)) { return $env:CODEX_MCP_NODE_PATH }
  $runtimeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
  $binaries = @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $native = Join-Path $_.FullName 'bin\node.exe'
    if (Test-Path -LiteralPath $native -PathType Leaf) { Get-Item -LiteralPath $native }
  } | Sort-Object LastWriteTime -Descending)
  if ($binaries.Count) { return $binaries[0].FullName }
  if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  throw 'Unable to locate the bundled Codex MCP Node runtime. Supply -McpNodePath.'
}

function ConvertTo-CodexNativeArgument {
  param([string]$Value)
  if ($Value -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Write-CodexRuntimeJson {
  param([string]$Path, [object]$Value)
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Test-CodexProcessStartTime {
  param([object]$Process, [object]$StartedAt)
  if (-not $Process -or -not $Process.CreationDate -or -not $StartedAt) { return $false }
  try {
    $expected = if ($StartedAt -is [datetime]) { $StartedAt.ToUniversalTime().Ticks } else { [DateTimeOffset]::Parse([string]$StartedAt, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime.Ticks }
    return $Process.CreationDate.ToUniversalTime().Ticks -eq $expected
  } catch { return $false }
}

function Wait-CodexProcessIdentity {
  param([int]$ProcessId, [string]$ExecutablePath)
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (-not $identity) { throw "Process $ProcessId exited before its identity could be recorded." }
    if ($identity.ExecutablePath -and $identity.CreationDate -and $identity.CommandLine) {
      if ($identity.ExecutablePath -ine $ExecutablePath) { throw 'The launched process has an unexpected executable path.' }
      return $identity
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'The launched process identity did not become readable; no process was stopped.'
}

function Get-OwnedSharedCodexProcess {
  param([string]$DataDir, [string]$WsUrl, [string]$ExecutablePath)
  $metadataPath = Join-Path (Get-FeishuCodexDataRoot $DataDir) 'shared-codex.pid.json'
  if (-not (Test-Path -LiteralPath $metadataPath)) { return $null }
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ($metadata.wsUrl -ne $WsUrl -or $metadata.processId -le 0) { return $null }
  $managedPattern = '(?i)[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]codex\.exe$'
  if ($metadata.executablePath -ine $ExecutablePath -and ($metadata.executablePath -notmatch $managedPattern -or $ExecutablePath -notmatch $managedPattern)) { return $null }
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$metadata.processId)" -ErrorAction SilentlyContinue
  if (-not $candidate -or $candidate.ExecutablePath -ine $metadata.executablePath) { return $null }
  if (-not (Test-CodexProcessStartTime $candidate $metadata.startedAt)) { return $null }
  if ($candidate.CommandLine -notmatch '\bapp-server\b' -or $candidate.CommandLine -notmatch ('--listen\s+"?' + [regex]::Escape($WsUrl) + '(?:"|\s|$)')) { return $null }
  return $candidate
}

function Test-CodexWebSocket {
  param([string]$WsUrl, [int]$TimeoutSeconds = 5)
  $uri = Get-CodexWebSocketUri $WsUrl
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $timeout = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
  try {
    $null = $socket.ConnectAsync($uri, $timeout.Token).GetAwaiter().GetResult()
    $hello = @{ id = 1; method = 'initialize'; params = @{ clientInfo = @{ name = 'feishu-codex-launcher'; version = '0.1.0' }; capabilities = @{ experimentalApi = $true } } } | ConvertTo-Json -Depth 5 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($hello)
    $null = $socket.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 16384
    for ($messageIndex = 0; $messageIndex -lt 20; $messageIndex++) {
      $stream = [System.IO.MemoryStream]::new()
      try {
        do {
          $chunk = $socket.ReceiveAsync([System.ArraySegment[byte]]::new($buffer), $timeout.Token).GetAwaiter().GetResult()
          if ($chunk.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $false }
          $stream.Write($buffer, 0, $chunk.Count)
          if ($stream.Length -gt 1048576) { return $false }
        } while (-not $chunk.EndOfMessage)
        $reply = [System.Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($reply.id -eq 1) { return ($null -ne $reply.result -and $null -eq $reply.error) }
      } finally { $stream.Dispose() }
    }
    return $false
  } catch { return $false }
  finally { $socket.Abort(); $socket.Dispose(); $timeout.Dispose() }
}

function Test-CodexToolsPipe {
  param([string]$PipePath)
  if (-not $PipePath.StartsWith('\\.\pipe\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'desktopToolsPipe must be a local Windows named pipe.' }
  $pipeName = $PipePath.Substring(9)
  if (-not $pipeName -or $pipeName.Contains('\') -or $pipeName.Contains('/')) { throw 'desktopToolsPipe has an invalid pipe name.' }
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try { $client.Connect(300); return $true } catch { return $false } finally { $client.Dispose() }
}

function Start-DesktopToolsRelay {
  param([string]$DataDir, [object]$Config)
  if (-not $Config.desktopToolsPipe) { return }
  $dataRoot = Get-FeishuCodexDataRoot $DataDir
  $entryPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\desktop-tools-relay.js'
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Build the desktop tools relay before starting shared Codex.' }
  $metadataPath = Join-Path $dataRoot 'desktop-tools-relay.pid.json'
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $owned = $null
  if (Test-Path -LiteralPath $metadataPath) {
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$metadata.processId)" -ErrorAction SilentlyContinue
    $entryMatches = $candidate -and $candidate.CommandLine -match ('(?:^|\s)"?' + [regex]::Escape($entryPath) + '(?:"|\s|$)')
    $pipeMatches = $candidate -and $candidate.CommandLine -match ('--pipe\s+"?' + [regex]::Escape([string]$Config.desktopToolsPipe) + '(?:"|\s|$)')
    $identityMatches = $candidate -and $candidate.Name -ieq 'node.exe' -and $metadata.pipe -eq $Config.desktopToolsPipe -and (Test-CodexProcessStartTime $candidate $metadata.startedAt) -and $entryMatches -and $pipeMatches
    if ($identityMatches -and -not $metadata.executablePath -and $candidate.ExecutablePath -ieq $node) {
      $metadata.executablePath = $candidate.ExecutablePath
      Write-CodexRuntimeJson $metadataPath $metadata
    }
    if ($identityMatches -and $candidate.ExecutablePath -and $candidate.ExecutablePath -ieq $metadata.executablePath) { $owned = $candidate }
  }
  if (Test-CodexToolsPipe $Config.desktopToolsPipe) {
    if (-not $owned) { throw 'The desktop tools pipe is already in use by another process. No process was stopped.' }
    return
  }
  if ($owned) { throw 'The desktop tools relay is running but not ready. Check its stderr log.' }
  $arguments = @($entryPath, '--pipe', [string]$Config.desktopToolsPipe, '--pid-file', (Join-Path $dataRoot 'desktop-tools-relay.pid'))
  $argumentLine = ($arguments | ForEach-Object { ConvertTo-CodexNativeArgument $_ }) -join ' '
  $process = Start-Process -FilePath $node -ArgumentList $argumentLine -WorkingDirectory $dataRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'desktop-tools-relay.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'desktop-tools-relay.stderr.log') -PassThru
  $identity = Wait-CodexProcessIdentity $process.Id $node
  Write-CodexRuntimeJson $metadataPath @{ processId = $process.Id; executablePath = $identity.ExecutablePath; pipe = $Config.desktopToolsPipe; startedAt = $identity.CreationDate.ToUniversalTime().ToString('o') }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw "Desktop tools relay exited. See $dataRoot\desktop-tools-relay.stderr.log" }
    if (Test-CodexToolsPipe $Config.desktopToolsPipe) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Desktop tools relay did not become ready. See $dataRoot\desktop-tools-relay.stderr.log"
}

function Start-SharedCodex {
  param([string]$DataDir, [object]$Config)
  $dataRoot = Get-FeishuCodexDataRoot $DataDir
  if (-not $Config) { $Config = Read-CodexRuntimeConfig $dataRoot }
  if ($Config.mode -ne 'shared') { throw 'Shared mode is disabled in runtime.json.' }
  $uri = Get-CodexWebSocketUri $Config.wsUrl
  $executable = Resolve-SharedCodexPath $Config.codexPath
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  $mutexName = 'Local\FeishuCodexShared-' + $uri.Port
  $mutex = [System.Threading.Mutex]::new($false, $mutexName)
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another launcher is starting shared Codex. Retry shortly.' }
    Start-DesktopToolsRelay $dataRoot $Config
    $listener = Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $owned = Get-OwnedSharedCodexProcess $dataRoot $Config.wsUrl $executable
    if ($listener) {
      if (-not $owned -or $listener.OwningProcess -ne $owned.ProcessId -or $listener.LocalAddress -ne '127.0.0.1') { throw "Port $($uri.Port) belongs to a process not owned by this shared Codex launcher. No process was stopped." }
      if (-not (Test-CodexWebSocket $Config.wsUrl)) { throw 'Owned shared Codex is not responding. No active process was stopped.' }
      return [pscustomobject]@{ processId = $owned.ProcessId; wsUrl = $Config.wsUrl; reused = $true }
    }
    if ($owned) { throw 'Shared Codex is already starting or is unresponsive. Check shared-codex.stderr.log before retrying.' }
    $notifyNode = if ($Config.mcpNodePath) { Resolve-CodexMcpNodePath $Config.mcpNodePath } else { (Get-Command node -ErrorAction Stop).Source }
    $notifyServer = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\server\notify-mcp.js'
    $notifyCommandToml = ConvertTo-Json ([string]$notifyNode) -Compress
    $notifyArgsToml = ConvertTo-Json @([string]$notifyServer) -Compress
    # All -c overrides must follow app-server; mixing both scopes loses the root options.
    $arguments = @('app-server', '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'features.code_mode_host=true', '-c', "mcp_servers.feishu_completion.command=$notifyCommandToml", '-c', "mcp_servers.feishu_completion.args=$notifyArgsToml", '--listen', $Config.wsUrl, '--analytics-default-enabled', '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true')
    $arguments += @('-c', 'mcp_servers.feishu_completion.tool_timeout_sec=1830')
    $argumentLine = ($arguments | ForEach-Object { ConvertTo-CodexNativeArgument $_ }) -join ' '
    $previousToolsPipe = $env:CODEX_APP_TOOLS_PIPE_PATH
    $previousMcpNode = $env:CODEX_MCP_NODE_PATH
    try {
      if ($Config.desktopToolsPipe) { $env:CODEX_APP_TOOLS_PIPE_PATH = [string]$Config.desktopToolsPipe }
      if ($Config.mcpNodePath) {
        $env:CODEX_MCP_NODE_PATH = Resolve-CodexMcpNodePath $Config.mcpNodePath
      }
      $process = Start-Process -FilePath $executable -ArgumentList $argumentLine -WorkingDirectory $dataRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'shared-codex.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'shared-codex.stderr.log') -PassThru
    } finally {
      if ($null -eq $previousToolsPipe) { Remove-Item Env:CODEX_APP_TOOLS_PIPE_PATH -ErrorAction SilentlyContinue } else { $env:CODEX_APP_TOOLS_PIPE_PATH = $previousToolsPipe }
      if ($null -eq $previousMcpNode) { Remove-Item Env:CODEX_MCP_NODE_PATH -ErrorAction SilentlyContinue } else { $env:CODEX_MCP_NODE_PATH = $previousMcpNode }
    }
    $identity = Wait-CodexProcessIdentity $process.Id $executable
    Write-CodexRuntimeJson (Join-Path $dataRoot 'shared-codex.pid.json') @{ processId = $process.Id; executablePath = $executable; wsUrl = $Config.wsUrl; startedAt = $identity.CreationDate.ToUniversalTime().ToString('o') }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $process.Refresh()
      if ($process.HasExited) { throw "Shared Codex exited. See $dataRoot\shared-codex.stderr.log" }
      $listener = Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($listener) {
        if ($listener.OwningProcess -ne $process.Id -or $listener.LocalAddress -ne '127.0.0.1') { throw 'A different process acquired the shared Codex port. No process was stopped.' }
        if (Test-CodexWebSocket $Config.wsUrl) { return [pscustomobject]@{ processId = $process.Id; wsUrl = $Config.wsUrl; reused = $false } }
      }
      Start-Sleep -Milliseconds 250
    }
    throw "Shared Codex did not become ready. See $dataRoot\shared-codex.stderr.log; the process was retained for diagnosis."
  } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
