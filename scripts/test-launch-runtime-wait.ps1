$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-launch-modes.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors.Message -join [Environment]::NewLine) }
$definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-LaunchProbeRuntimeExit' }, $false)
if ($definition.Count -ne 1) { throw 'Expected exactly one runtime-exit wait function.' }
. ([scriptblock]::Create($definition[0].Extent.Text))

# Only the extracted wait function runs. OS queries are replaced locally; no
# real process is stopped and the interactive acceptance test is not executed.
$script:caseSamples = @()
$script:sampleIndex = 0
$script:queryFailure = $false
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return $script:caseSamples[[Math]::Min($script:sampleIndex, $script:caseSamples.Count - 1)].process
}
function Get-NetTCPConnection {
  param($ErrorAction)
  if ($script:queryFailure) { throw 'Simulated TCP query failure' }
  $sample = $script:caseSamples[[Math]::Min($script:sampleIndex, $script:caseSamples.Count - 1)]
  $script:sampleIndex++
  return $sample.listeners
}
function Invoke-WaitCase {
  param([string]$Name, [object[]]$Samples, [bool]$ShouldPass, [string]$ExpectedError, [int]$ExpectedSamples = 0, [switch]$QueryFailure)
  $script:caseSamples = $Samples
  $script:sampleIndex = 0
  $script:queryFailure = [bool]$QueryFailure
  $trace = [ordered]@{}
  $caught = $null
  try { Wait-LaunchProbeRuntimeExit -RuntimeProcessId 12345 -StartedAt '2026-09-24T17:00:00Z' -Port 18794 -Trace $trace -TimeoutSeconds 2 }
  catch { $caught = $_.Exception.Message }
  if ($ShouldPass -and ($caught -or -not $trace.released)) { throw "$Name failed: $caught" }
  if (-not $ShouldPass -and (-not $caught -or $trace.released -or $caught -notlike $ExpectedError)) { throw "$Name accepted an invalid state or returned an unexpected error: $caught" }
  if ($ExpectedSamples -gt 0 -and $trace.samples.Count -ne $ExpectedSamples) { throw "$Name observed $($trace.samples.Count) samples instead of $ExpectedSamples" }
  [pscustomobject]@{ name = $Name; passed = $true; samples = $trace.samples.Count }
}
$staleListener = [pscustomobject]@{ LocalPort = 18794; State = 'Listen'; OwningProcess = 12345; LocalAddress = '127.0.0.1' }
$foreignListener = [pscustomobject]@{ LocalPort = 18794; State = 'Listen'; OwningProcess = 54321; LocalAddress = '127.0.0.1' }
$oldProcess = [pscustomobject]@{ CreationDate = [DateTime]::Parse('2026-09-24T17:00:00Z').ToUniversalTime() }
$reusedProcess = [pscustomobject]@{ CreationDate = [DateTime]::Parse('2026-09-24T17:01:00Z').ToUniversalTime() }
$absent = @{ process = $null; listeners = @() }
$stale = @{ process = $null; listeners = @($staleListener) }
Invoke-WaitCase 'Wait for stale listening records' @($stale, $absent, $absent) $true '' 3
Invoke-WaitCase 'Require two consecutive clear snapshots' @($absent, $stale, $absent, $absent) $true '' 4
Invoke-WaitCase 'Refuse a different listener owner' @(@{ process = $null; listeners = @($foreignListener) }) $false '共享端口被另一个进程占用*' 1
Invoke-WaitCase 'Refuse reused process identity' @(@{ process = $reusedProcess; listeners = @() }) $false '原后台的进程编号已被其他进程使用*' 1
Invoke-WaitCase 'Report timeout when original process remains' @(@{ process = $oldProcess; listeners = @($staleListener) }) $false '等待*秒后，共享后台或端口仍未退出*'
Invoke-WaitCase 'Do not treat query failures as an empty port' @($absent) $false 'Simulated TCP query failure' -QueryFailure
