param([Parameter(Mandatory=$true)][string]$IdentityFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'desktop-process-tree.ps1')
$identity = [IO.File]::ReadAllText($IdentityFile) | ConvertFrom-Json
$tree = @(Get-OwnedProcessTree $identity)
ConvertTo-Json -InputObject $tree -Depth 5 -Compress
