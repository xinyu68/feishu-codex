param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    if (-not $candidate -or $candidate.ExecutablePath -notmatch '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:ChatGPT|Codex)\.exe$' -or
        -not $candidate.CommandLine -or $candidate.CommandLine -match '(?i)(?:^|\s|"|\x27)--type(?:=|\s)') {
        throw '未找到可切换的 Codex 窗口。'
    }
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    try {
        if ($process.Path -ine $candidate.ExecutablePath -or
            [Math]::Abs(($process.StartTime.ToUniversalTime() - $candidate.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) {
            throw 'Codex 进程已发生变化，请重新点击打开。'
        }
        . (Join-Path $PSScriptRoot 'desktop-window.ps1')
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        $shown = $false
        do {
            if ($process.HasExited) { throw 'Codex 已退出，请重新点击打开。' }
            $window = [FeishuCodex.NativeWindow]::FindMainWindow([uint32]$ProcessId)
            if ($window -ne [IntPtr]::Zero) {
                $shown = [FeishuCodex.NativeWindow]::Restore($window, [uint32]$ProcessId)
                if ($shown) { break }
            }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $shown) { throw 'Codex 已在运行，但窗口尚未就绪，请稍后重试。' }
        # Windows can deny foreground focus even after the window is restored.
        # A visible window remains usable; this is not a failed Codex launch.
        $foreground = [FeishuCodex.NativeWindow]::Activate($window, [uint32]$ProcessId)
        @{ visible = $true; foreground = $foreground } | ConvertTo-Json -Compress
    } finally { $process.Dispose() }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
