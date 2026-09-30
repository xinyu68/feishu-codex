param([Parameter(Mandatory=$true)][string]$IdentityFile, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'desktop-process-tree.ps1')
$identity = [IO.File]::ReadAllText($IdentityFile) | ConvertFrom-Json
if ($identity.pid -le 0 -or -not $identity.exe -or -not $identity.startedAt) { throw '进程身份记录不完整，没有停止任何服务。' }
$tree = @(Get-OwnedProcessTree $identity)
if ($identity.tree) { $tree += @($identity.tree) }
if ($Port) {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (@($listeners | Where-Object { $_.OwningProcess -ne $identity.pid -or $_.LocalAddress -ne '127.0.0.1' }).Count) { throw '监听端口属于其他进程，没有停止任何服务。' }
}
Stop-OwnedProcessTree $tree
if ($Port) {
    $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($remaining.Count) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($identity.pid)" -ErrorAction Stop
        if (-not $owner -and -not @($remaining | Where-Object { $_.OwningProcess -ne $identity.pid -or $_.LocalAddress -ne '127.0.0.1' }).Count) {
            Write-Output '已确认服务进程退出；Windows 仍保留旧监听记录，下次启动将恢复连接。'
            exit 0
        }
        throw '端口尚未释放，已取消后续清理。'
    }
}
Write-Output '已确认服务及子进程退出，端口已释放。'
