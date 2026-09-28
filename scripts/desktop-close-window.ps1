param([Parameter(Mandatory=$true)][string]$IdentityFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity = [IO.File]::ReadAllText($IdentityFile) | ConvertFrom-Json
if ($identity.pid -le 0 -or -not $identity.exe -or -not $identity.startedAt) { throw '进程身份记录不完整，没有关闭窗口。' }
$candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$identity.pid)" -ErrorAction Stop
if (-not $candidate) { return }
$handle = Get-Process -Id $identity.pid -ErrorAction Stop
$actualTicks = $handle.StartTime.ToUniversalTime().Ticks
$actualMicros = $actualTicks - ($actualTicks % 10)
if ($handle.Path -ine $identity.exe -or $actualMicros -ne [DateTimeOffset]::Parse($identity.startedAt).UtcDateTime.Ticks) { throw '进程身份已发生变化，没有关闭窗口。' }
# This only requests a normal window close. The host must recheck live tasks
# before any separate operation to terminate a remaining background process.
if ($handle.CloseMainWindow()) { [void]$handle.WaitForExit(3000) }
