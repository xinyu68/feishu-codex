$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
(Get-Command node.exe -ErrorAction Stop).Source
