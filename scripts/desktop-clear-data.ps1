function Remove-FeishuApplicationData {
    param([Parameter(Mandatory=$true)][string]$DataDir,
        [string]$ProfileDir = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'feishu-codex'),
        [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }))
    $dataRoot = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
    $profileRoot = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')
    $codexRoot = [IO.Path]::GetFullPath($CodexHome).TrimEnd('\')
    function Is-InDirectory([string]$Child, [string]$Parent) { return $Child -ieq $Parent -or $Child.StartsWith($Parent + '\', [StringComparison]::OrdinalIgnoreCase) }
    foreach ($root in @($dataRoot, $profileRoot)) {
        if ($root -ieq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or $root -ieq $env:USERPROFILE -or (Is-InDirectory $codexRoot $root) -or (Is-InDirectory $root $codexRoot)) { throw '数据清理目录不安全，未删除任何数据。' }
        # Reject junctions in the root or its ancestors before recursive deletion.
        $ancestor = $root
        while ($ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
            if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '数据路径包含目录链接，未删除任何数据。' }
            $ancestor = [IO.Path]::GetDirectoryName($ancestor)
        }
    }
    if ([IO.Path]::GetFileName($profileRoot) -ine 'feishu-codex') { throw '应用缓存目录无效，未删除任何数据。' }
    $projects = @()
    $configFile = Join-Path $dataRoot 'config.json'
    if (Test-Path -LiteralPath $configFile) {
        $config = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
        if ($config.defaultWorkspace) { $projects += [IO.Path]::GetFullPath($config.defaultWorkspace).TrimEnd('\') }
    }
    $stateFile = Join-Path $dataRoot 'state.json'
    if (Test-Path -LiteralPath $stateFile) {
        $state = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
        foreach ($conversation in $state.conversations.PSObject.Properties) {
            if ($conversation.Value.cwd) { $projects += [IO.Path]::GetFullPath($conversation.Value.cwd).TrimEnd('\') }
        }
    }
    # Only application-owned names are candidates, even with a custom DataDir.
    # Unknown files and workspace directories are never swept with the root.
    $owned = @('config.json', 'state.json', 'runtime.json', 'service.lock', 'desktop', 'desktop-baseline', 'desktop-launcher',
        'launch-verification', 'migration', 'shared-migration', 'protocol-ts-current', 'launcher.pid',
        'attachments', 'engine-migrations', 'pending-setup', 'hermes-runtime.json',
        'desktop-tools-relay.pid', 'desktop-tools-relay.pid.json', 'desktop-tools-relay.stderr.log', 'desktop-tools-relay.stdout.log',
        'service.stderr.log', 'service.stdout.log', 'shared-codex.pid.json', 'shared-codex.stderr.log', 'shared-codex.stdout.log')
    if (Test-Path -LiteralPath $dataRoot) {
        $owned += @(Get-ChildItem -LiteralPath $dataRoot -File -Force | Where-Object { $_.Name -match '^(config|state|runtime|hermes-runtime)\.json\.(\d+|[0-9a-f-]{36})\.tmp$' } | ForEach-Object { $_.Name })
    }
    $candidates = @($owned | ForEach-Object { Join-Path $dataRoot $_ }) + @($profileRoot)
    $targets = @()
    foreach ($candidate in $candidates) {
        $target = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if ($target -ine $profileRoot -and [IO.Path]::GetDirectoryName($target) -ine $dataRoot) { throw '数据清理路径超出应用目录。' }
        # The application data root can itself be the default workspace. That
        # must not protect every owned file from an explicit data-clear request.
        # The whitelist still excludes user files; separately configured nested
        # projects and projects containing a custom data directory stay protected.
        if (@($projects | Where-Object { $_ -ine $dataRoot -and ((Is-InDirectory $_ $target) -or (Is-InDirectory $target $_)) }).Count) { Write-Output '已保留包含项目文件的目录。'; continue }
        if (-not (Test-Path -LiteralPath $target)) { continue }
        $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($target)
        while ($pending.Count) {
            $entry = Get-Item -LiteralPath $pending.Pop() -Force -ErrorAction Stop
            if (-not (Is-InDirectory $entry.FullName $target) -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '数据目录包含链接或异常路径，未删除任何数据。' }
            if ($entry.PSIsContainer) { foreach ($child in @(Get-ChildItem -LiteralPath $entry.FullName -Force)) { $pending.Push($child.FullName) } }
        }
        $targets += $target
    }
    foreach ($target in $targets) {
        # All final absolute targets have been checked against the two named
        # application directories and against every known workspace above.
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
    if ((Test-Path -LiteralPath $dataRoot) -and -not @(Get-ChildItem -LiteralPath $dataRoot -Force).Count) { Remove-Item -LiteralPath $dataRoot -Force }
    Write-Output '已清除飞书配置、会话绑定、偏好、日志及应用缓存；Codex 和项目文件保持不变。'
}
