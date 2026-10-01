function Get-BlockingServiceListeners {
    param([Parameter(Mandatory=$true)][string]$DataDir)
    $readRecord = {
        param($Name)
        $file = Join-Path $DataDir ('desktop\' + $Name + '.json')
        if (Test-Path -LiteralPath $file -PathType Leaf) { return [IO.File]::ReadAllText($file) | ConvertFrom-Json }
        return $null
    }
    $ports = @(8790, 18791, 18792)
    $records = @()
    $runtimePath = Join-Path $DataDir 'runtime.json'
    $currentUrl = 'ws://127.0.0.1:18791'
    if (Test-Path -LiteralPath $runtimePath -PathType Leaf) {
        $settings = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
        if ($settings.wsUrl) { $currentUrl = [string]$settings.wsUrl }
    }
    $endpoint = [Uri]$currentUrl
    if ($endpoint.Scheme -ne 'ws' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.Port -lt 1024 -or $endpoint.Port -gt 65535) { throw '本机连接记录无效，未清除任何数据。' }
    $ports += $endpoint.Port
    $records += @{ port = $endpoint.Port; identity = (& $readRecord 'runtime-identity') }
    $recovery = & $readRecord 'runtime-endpoint-recovery'
    if ($recovery -and $recovery.previousUrl) {
        $previous = [Uri]$recovery.previousUrl
        if ($previous.Scheme -ne 'ws' -or $previous.Host -ne '127.0.0.1' -or $previous.Port -lt 1024 -or $previous.Port -gt 65535) { throw '连接恢复记录无效，未清除任何数据。' }
        $ports += $previous.Port
        $records += @{ port = $previous.Port; identity = $recovery.previousIdentity }
    }
    foreach ($listener in @(Get-NetTCPConnection -LocalPort ($ports | Select-Object -Unique) -State Listen -ErrorAction SilentlyContinue)) {
        $stale = $false
        foreach ($record in $records) {
            $identity = $record.identity
            if ($listener.LocalAddress -eq '127.0.0.1' -and $listener.LocalPort -eq $record.port -and $identity -and $identity.pid -gt 0 -and $identity.exe -and $identity.startedAt -and $listener.OwningProcess -eq $identity.pid) {
                # Only a confirmed absent process can explain a stale Windows socket.
                # A reused PID, foreign listener or failed inspection still blocks cleanup.
                $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$identity.pid)" -ErrorAction Stop
                if (-not $candidate) { $stale = $true }
            }
        }
        if (-not $stale) { $listener }
    }
}
