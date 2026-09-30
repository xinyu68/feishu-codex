# Shared by normal exit and the installer. Never stop processes by image name.
function Get-ProcessIdentity($Process) {
    $exe = [string]$Process.ExecutablePath
    if (-not $exe) {
        $handle = Get-Process -Id $Process.ProcessId -ErrorAction SilentlyContinue
        if (-not $handle) { return $null }
        $ticks = $handle.StartTime.ToUniversalTime().Ticks
        if (($ticks - ($ticks % 10)) -ne $Process.CreationDate.ToUniversalTime().Ticks) { throw '无法确认子进程身份。' }
        $exe = [string]$handle.Path
    }
    if (-not $exe) { throw '无法读取子进程路径。' }
    return [pscustomobject]@{ pid = [int]$Process.ProcessId; parentPid = [int]$Process.ParentProcessId; exe = $exe; startedAt = $Process.CreationDate.ToUniversalTime().ToString('o') }
}

function Test-ProcessIdentity($Identity, $Process) {
    if (-not $Process) { return $false }
    $actual = Get-ProcessIdentity $Process
    return $actual -and $actual.exe -ieq $Identity.exe -and $actual.startedAt -eq $Identity.startedAt
}

function Get-OwnedProcessTree($Identity, $Snapshot = $null) {
    if ($Identity.pid -le 0 -or -not $Identity.exe -or -not $Identity.startedAt) { throw '进程身份记录不完整。' }
    $all = if ($null -ne $Snapshot) { @($Snapshot) } else { @(Get-CimInstance Win32_Process -ErrorAction Stop) }
    $root = $all | Where-Object ProcessId -eq $Identity.pid
    if (-not $root) { return }
    if (-not (Test-ProcessIdentity $Identity $root)) { throw '进程身份已发生变化，没有停止任何服务。' }
    $found = @{}
    $found[[int]$Identity.pid] = Get-ProcessIdentity $root
    do {
        $changed = $false
        foreach ($candidate in $all) {
            $parent = $found[[int]$candidate.ParentProcessId]
            if (-not $parent -or $found.ContainsKey([int]$candidate.ProcessId)) { continue }
            if ($candidate.CreationDate.ToUniversalTime() -lt [DateTimeOffset]::Parse($parent.startedAt).UtcDateTime) { continue }
            $record = Get-ProcessIdentity $candidate
            if ($record) { $found[$record.pid] = $record; $changed = $true }
        }
    } while ($changed)
    $found.Values | Sort-Object { [DateTimeOffset]::Parse($_.startedAt) }
}

function Stop-OwnedProcessTree($Identities) {
    $known = @{}
    foreach ($identity in @($Identities)) { $known[[int]$identity.pid] = $identity }
    if (-not $known.Count) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $live = @()
        $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $expanded = @{}
        foreach ($identity in @($known.Values)) {
            if ($expanded.ContainsKey([int]$identity.pid)) { continue }
            $candidate = $snapshot | Where-Object ProcessId -eq $identity.pid
            if (-not (Test-ProcessIdentity $identity $candidate)) { continue }
            foreach ($child in @(Get-OwnedProcessTree $identity $snapshot)) { $known[$child.pid] = $child; $expanded[$child.pid] = $true }
        }
        $pending = @()
        try {
            foreach ($identity in @($known.Values | Sort-Object { [DateTimeOffset]::Parse($_.startedAt) })) {
                $handle = Get-Process -Id $identity.pid -ErrorAction SilentlyContinue
                if (-not $handle) { continue }
                try {
                    # Retain the handle: PID reuse must never redirect Kill().
                    $null = $handle.Handle
                    $ticks = $handle.StartTime.ToUniversalTime().Ticks
                    if ($handle.Path -ine $identity.exe -or ($ticks - ($ticks % 10)) -ne [DateTimeOffset]::Parse($identity.startedAt).UtcDateTime.Ticks) {
                        # A still-live recorded identity must not silently count as
                        # stopped when Windows temporarily cannot expose its path.
                        $candidate = $snapshot | Where-Object ProcessId -eq $identity.pid
                        if (-not $handle.HasExited -and (Test-ProcessIdentity $identity $candidate)) { throw '退出前无法复核进程身份，已取消后续清理。' }
                        continue
                    }
                    if (-not $handle.HasExited) {
                        $handle.Kill()
                        $live += $identity
                        $pending += $handle
                        $handle = $null
                    }
                } catch {
                    if (-not $handle.HasExited) { throw }
                } finally { if ($handle) { $handle.Dispose() } }
            }
            # Request every verified process exit first. Waiting two seconds for
            # each parent before signaling its children multiplies shutdown time.
            # Retained handles protect against PID reuse throughout this shared wait.
            $waitDeadline = [DateTime]::UtcNow.AddSeconds(2)
            foreach ($handle in $pending) {
                $remaining = [Math]::Max(0, [int]($waitDeadline - [DateTime]::UtcNow).TotalMilliseconds)
                [void]$handle.WaitForExit($remaining)
            }
        } finally { foreach ($handle in $pending) { $handle.Dispose() } }
        if (-not $live.Count) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw '仍有本应用的子进程未退出，已取消后续清理。'
}
