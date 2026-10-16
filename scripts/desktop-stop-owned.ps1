param([Parameter(Mandatory=$true)][string]$IdentityFile, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'desktop-process-tree.ps1')
$identity = [IO.File]::ReadAllText($IdentityFile) | ConvertFrom-Json
if ($identity.pid -le 0 -or -not $identity.exe -or -not $identity.startedAt) { throw '进程身份记录不完整，没有停止任何服务。' }
$preserveExecutables = @($identity.preserveExecutables | Where-Object { $_ })
# This fallback also protects a running UI when an older host calls the updated
# helper without protection metadata. Direct application exits remain explicit.
if ([IO.Path]::GetFileName([string]$identity.exe) -in @('ChatGPT.exe', 'codex.exe')) {
    $productRoot = Split-Path -Parent $PSScriptRoot
    if ((Split-Path -Leaf $productRoot) -ieq 'product' -and (Split-Path -Leaf (Split-Path -Parent $productRoot)) -ieq 'resources') {
        $applicationExe = [IO.Path]::GetFullPath((Join-Path $productRoot '..\..\Feishu Codex.exe'))
    } else {
        $applicationExe = Join-Path $productRoot 'node_modules\electron\dist\electron.exe'
    }
    $preserveExecutables = @($preserveExecutables) + @($applicationExe)
}
$tree = @(Get-OwnedProcessTree $identity $null $preserveExecutables)
if ($identity.tree) { $tree += @($identity.tree) }
if ($Port) {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (@($listeners | Where-Object { $_.OwningProcess -ne $identity.pid -or $_.LocalAddress -ne '127.0.0.1' }).Count) { throw '监听端口属于其他进程，没有停止任何服务。' }
}
Stop-OwnedProcessTree $tree $preserveExecutables
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
