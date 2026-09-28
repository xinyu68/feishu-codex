param([Parameter(Mandatory=$true)][string]$ProductRoot, [Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$DataDir)
$ErrorActionPreference = 'Stop'
$directory = Join-Path $DataDir 'desktop'
[void][IO.Directory]::CreateDirectory($directory)
$entry = Join-Path $ProductRoot 'desktop\host.mjs'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '桌面后台文件不完整，请重新安装。' }
# Remain alive as the scheduled task's main process. Child lifetime is not tied
# to a transient launcher or Codex tool job.
& $NodePath $entry --root $ProductRoot --data-dir $DataDir 1>> (Join-Path $directory 'launcher.stdout.log') 2>> (Join-Path $directory 'launcher.stderr.log')
exit $LASTEXITCODE
