$ErrorActionPreference = 'Stop'
# This script launches only a temporary, unsigned-in profile for diagnostics.
# It does not stop the existing app or change user/machine environment variables.
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw 'The installed OpenAI.Codex package was not found.' }
$desktopExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) { throw 'ChatGPT.exe was not found in the installed package.' }
$nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$diagnosticScript = Join-Path $PSScriptRoot 'probe-desktop-isolated.mjs'
& $nodeExecutable $diagnosticScript $desktopExecutable --package-launch
if ($LASTEXITCODE -ne 0) { throw 'The probe did not pass. See artifacts\desktop-isolated-probe-latest.json; no production settings were changed.' }
