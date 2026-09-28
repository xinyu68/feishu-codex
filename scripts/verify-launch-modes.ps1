param([string]$DataDir, [string]$Recover)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shared-codex.ps1')

# Interactive acceptance test, run from a normal external PowerShell window.
# Never closes a desktop process. Configuration changes are backed up and restored.
function Send-LaunchEnvironmentChanged {
  if (-not ('FeishuLaunchProbe.EnvironmentBroadcast' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FeishuLaunchProbe {
  public static class EnvironmentBroadcast {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
    public static void Notify() { UIntPtr r; SendMessageTimeout(new IntPtr(0xffff), 0x001a, UIntPtr.Zero, "Environment", 2, 3000, out r); }
  }
}
'@
  }
  [FeishuLaunchProbe.EnvironmentBroadcast]::Notify()
}

function Get-LaunchProbeDesktopState {
  param([int]$SharedPort)
  $desktopProcesses = @(Get-CodexDesktopProcesses)
  $allProcesses = @(Get-CimInstance Win32_Process)
  $desktopIds = @($desktopProcesses | ForEach-Object { [int]$_.ProcessId })
  $roots = @($desktopProcesses | Where-Object { $desktopIds -notcontains [int]$_.ParentProcessId })
  $ownedIds = @($desktopIds)
  do {
    $moreIds = @($allProcesses | Where-Object { $ownedIds -contains [int]$_.ParentProcessId -and $ownedIds -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
    $ownedIds += $moreIds
  } while ($moreIds.Count)
  $connections = @(Get-NetTCPConnection -State Established -RemotePort $SharedPort -ErrorAction SilentlyContinue | Where-Object { $ownedIds -contains [int]$_.OwningProcess -and $_.RemoteAddress -eq '127.0.0.1' })
  $ownBackends = @($allProcesses | Where-Object { $ownedIds -contains [int]$_.ProcessId -and $_.Name -ieq 'codex.exe' -and $_.CommandLine -match '\bapp-server\b' })
  return [pscustomobject]@{
    rootIds = @($roots | ForEach-Object { [int]$_.ProcessId })
    appProcessCount = $desktopIds.Count
    localBackendIds = @($ownBackends | ForEach-Object { [int]$_.ProcessId })
    sharedConnectionPids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
  }
}

function Wait-LaunchProbeDesktopExit {
  param([int]$Seconds = 180)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-CodexDesktopProcesses).Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'Codex 聊天窗口仍在运行。请从应用菜单选择退出；本脚本不会替你强制关闭窗口。'
}

function Wait-LaunchProbeRuntimeExit {
  param(
    [int]$RuntimeProcessId,
    [string]$StartedAt,
    [int]$Port,
    [System.Collections.IDictionary]$Trace,
    [int]$TimeoutSeconds = 20
  )
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $clearSamples = 0
  $Trace.samples = @()
  $Trace.released = $false
  try {
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $RuntimeProcessId" -ErrorAction Stop
      # Query the table without a port filter: a query failure must not be
      # mistaken for an absent listener, and an empty match is a valid result.
      $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port -and $_.State -eq 'Listen' })
      $sample = [pscustomobject]@{
        elapsedMs = $watch.ElapsedMilliseconds
        originalPidPresent = [bool]$candidate
        listeners = @($listeners | ForEach-Object { [pscustomobject]@{ address = $_.LocalAddress; pid = [int]$_.OwningProcess } })
      }
      $Trace.samples += $sample
      $Trace.lastState = $sample
      if ($candidate -and -not (Test-CodexProcessStartTime $candidate $StartedAt)) {
        throw '原后台的进程编号已被其他进程使用，已中止验证，没有关闭其他进程。'
      }
      if (@($listeners | Where-Object { [int]$_.OwningProcess -ne $RuntimeProcessId }).Count) {
        throw '共享端口被另一个进程占用，已中止验证，没有关闭该进程。'
      }
      if (-not $candidate -and $listeners.Count -eq 0) { $clearSamples++ } else { $clearSamples = 0 }
      if ($clearSamples -ge 2) {
        $Trace.released = $true
        $Trace.clearSamples = $clearSamples
        return
      }
      Start-Sleep -Milliseconds 250
    }
    throw "等待 $TimeoutSeconds 秒后，共享后台或端口仍未退出。详细状态已记录到结果文件。"
  } finally {
    $watch.Stop()
    $Trace.elapsedMs = $watch.ElapsedMilliseconds
  }
}

function Restore-LaunchProbeState {
  param([object]$Backup)
  if ($Backup.purpose -ne 'feishu-launch-mode-verification') { throw '这不是有效的启动验证备份，未执行恢复。' }
  $current = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
  if ($current -and $current -ne $Backup.userEnvironment.value) { throw '共享地址已被其他操作修改，为避免覆盖新设置，本次没有恢复该地址。' }
  $registry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    if ($Backup.userEnvironment.existed) {
      $kind = [Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$Backup.userEnvironment.kind))
      $registry.SetValue('CODEX_APP_SERVER_WS_URL', [string]$Backup.userEnvironment.value, $kind)
      $env:CODEX_APP_SERVER_WS_URL = [string]$Backup.userEnvironment.value
    } else {
      $registry.DeleteValue('CODEX_APP_SERVER_WS_URL', $false)
      Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
    }
  } finally { $registry.Dispose() }
  Send-LaunchEnvironmentChanged
  $runtimeConfig = Read-CodexRuntimeConfig $Backup.dataRoot
  if ($Backup.sharedWasRunning) { $null = Start-SharedCodex $Backup.dataRoot $runtimeConfig }
  if ($Backup.bridgeWasRunning) { & (Join-Path $PSScriptRoot 'start.ps1') -Port 8790 -DataDir $Backup.dataRoot | Out-Null }
}

function Read-LaunchProbeInput {
  param([string]$Prompt)
  $answer = Read-Host ($Prompt + '（输入“取消”可结束验证）')
  if ($answer.Trim() -in @('取消', '退出', 'cancel')) {
    throw [OperationCanceledException]::new('你已取消验证，脚本将恢复本次临时更改的设置。')
  }
  return $answer
}

function Show-LaunchProbeError {
  param([string]$Message)
  if ($Message -match '[\u4e00-\u9fff]') {
    Write-Warning ("验证未完成：$Message")
  } else {
    # Preserve the original technical error in JSON; the console stays usable
    # even when an imported helper or Windows component returns English text.
    Write-Warning '执行当前步骤时出现错误，详细原因已写入结果文件；请把结果交给 Codex 查看。'
  }
}

try { $Host.UI.RawUI.WindowTitle = 'Codex 启动验证 - 请保留此 PowerShell 窗口' } catch { }

if ($Recover) {
  $savedBackup = Get-Content -LiteralPath $Recover -Encoding UTF8 -Raw | ConvertFrom-Json
  Restore-LaunchProbeState $savedBackup
  Write-Host '原配置和之前运行的服务已恢复，没有关闭或重启 Codex 聊天窗口。'
  return
}

$dataRoot = Get-FeishuCodexDataRoot $DataDir
$runtimeConfig = Read-CodexRuntimeConfig $dataRoot
if ($runtimeConfig.mode -ne 'shared') { throw '当前没有使用共享后台配置，无法执行这次验证。' }
$endpoint = Get-CodexWebSocketUri $runtimeConfig.wsUrl
if ($endpoint.Port -ne 18791) { throw '本次验证仅适用于当前配置的共享后台端口 18791。' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$helper = Join-Path $PSScriptRoot 'launch-packaged-probe.ps1'
$idleProbe = Join-Path $PSScriptRoot 'probe-runtime-idle.mjs'
if (-not (Test-Path -LiteralPath $helper) -or -not (Test-Path -LiteralPath $idleProbe)) { throw '缺少验证需要的辅助脚本，请交给 Codex 检查。' }
if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Machine')) { throw '检测到系统级共享地址，本次验证不会修改它，请交给 Codex 检查。' }
foreach ($scope in @('User', 'Machine')) {
  $forceCli = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_FORCE_CLI', $scope)
  if ($forceCli -and $forceCli -notin @('0', 'false', 'no')) { throw '检测到强制独立后台的环境设置，请交给 Codex 检查后再验证。' }
}
$registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
try {
  $exists = $registry -and $registry.GetValueNames() -contains 'CODEX_APP_SERVER_WS_URL'
  $savedValue = if ($exists) { $registry.GetValue('CODEX_APP_SERVER_WS_URL', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
  $savedKind = if ($exists) { $registry.GetValueKind('CODEX_APP_SERVER_WS_URL').ToString() } else { 'String' }
} finally { if ($registry) { $registry.Dispose() } }
if ($savedValue -and $savedValue -ne $runtimeConfig.wsUrl) { throw '用户设置中的共享地址与本项目不同，没有修改该设置。' }
$runDirectory = Join-Path $dataRoot ('launch-verification\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$backupPath = Join-Path $runDirectory 'backup.json'
$resultPath = Join-Path $runDirectory 'result.json'
$backup = [pscustomobject]@{
  purpose = 'feishu-launch-mode-verification'; dataRoot = $dataRoot
  userEnvironment = @{ existed = [bool]$exists; value = $savedValue; kind = $savedKind }
  sharedWasRunning = [bool](Get-NetTCPConnection -State Listen -LocalPort 18791 -ErrorAction SilentlyContinue)
  bridgeWasRunning = [bool](Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
}
if (-not $backup.sharedWasRunning -or -not $backup.bridgeWasRunning) {
  throw '请先让现有共享后台和飞书服务恢复运行，再执行验证；本次没有修改设置。'
}
Write-CodexRuntimeJson $backupPath $backup
$report = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); scope = 'interactive original-icon and per-launch shared-mode verification'; passed = $false; stage = 'waiting-for-desktop-exit'; backupPath = $backupPath }
Write-CodexRuntimeJson $resultPath $report
$changed = $false
try {
  Write-Host ''
  Write-Host 'Codex 启动验证（中文引导）' -ForegroundColor Cyan
  Write-Host '请一直保留这个 PowerShell 验证窗口，不要关闭它。'
  Write-Host '下面会提示你两次退出 Codex：退出的是带聊天界面的 Codex 桌面应用。'
  Write-Host '测试会暂时停用飞书和旧的共享地址，结束或取消时恢复原配置。'
  Write-Host '不会更改开机自启，也不会修改已有对话。测试期间请不要发送飞书消息。'
  Write-Host "备份文件：$backupPath"
  Write-Host '如果误关了本验证窗口，可重新打开 PowerShell，执行下面的恢复命令：'
  Write-Host ("& '{0}' -Recover '{1}'" -f $PSCommandPath, $backupPath)
  Write-Host ''
  Write-Host '第 1 步 / 共 4 步：退出当前 Codex 聊天窗口' -ForegroundColor Cyan
  Write-Host '先等所有任务结束，再从 Codex 应用菜单选择“退出”，不要只最小化。'
  Write-Host '如果已经退出，直接继续即可；不要关闭当前 PowerShell 窗口。'
  $null = Read-LaunchProbeInput '完成后回到这里，按回车继续'
  Write-Host '正在确认 Codex 已退出，并检查是否还有未完成的任务……'
  Wait-LaunchProbeDesktopExit
  if ($backup.bridgeWasRunning) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 8790 | Select-Object -First 1
    Assert-FeishuCodexProcess $listener.OwningProcess $dataRoot (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\server.js')
    $bridgeState = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/state' -TimeoutSec 5
    if (@($bridgeState.conversations | Where-Object { $_.busy -or $_.queued -gt 0 }).Count) { throw '飞书还有正在执行或排队的任务，请等任务完成后再验证。' }
  }
  if ($backup.sharedWasRunning) {
    $idleJson = & $node $idleProbe $runtimeConfig.wsUrl
    if ($LASTEXITCODE -ne 0) { throw '共享后台仍有任务，或暂时无法确认它是否空闲；本次不继续停止后台。' }
    $report.initialIdle = $idleJson | ConvertFrom-Json
  }
  # This is a last-minute snapshot, not an atomic intake pause. The operator
  # must keep Feishu and other clients idle for the duration of this test.
  $bridgeState = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/state' -TimeoutSec 5
  if (@($bridgeState.conversations | Where-Object { $_.busy -or $_.queued -gt 0 }).Count) { throw '准备期间飞书收到了新任务，没有停止服务，请等任务完成后再验证。' }
  $report.stage = 'pausing-feishu-bridge'
  Write-CodexRuntimeJson $resultPath $report
  $changed = $true
  Write-Host '正在暂时停止飞书服务和共享后台，并等待端口释放，请稍候……'
  if ($backup.bridgeWasRunning) { & (Join-Path $PSScriptRoot 'stop.ps1') -Port 8790 -DataDir $dataRoot | Out-Null }
  if ($backup.sharedWasRunning) {
    $idleJson = & $node $idleProbe $runtimeConfig.wsUrl
    if ($LASTEXITCODE -ne 0) { throw '共享后台收到了新任务，没有停止它，本次验证中止。' }
    $owned = Get-OwnedSharedCodexProcess $dataRoot $runtimeConfig.wsUrl (Resolve-SharedCodexPath $runtimeConfig.codexPath)
    $listener = Get-NetTCPConnection -State Listen -LocalPort 18791 | Select-Object -First 1
    if (-not $owned -or $listener.OwningProcess -ne $owned.ProcessId -or $listener.LocalAddress -ne '127.0.0.1') { throw '无法确认共享后台的进程身份，没有停止该进程。' }
    $report.stage = 'waiting-for-shared-runtime-exit'
    $report.runtimeStop = [ordered]@{
      processId = [int]$owned.ProcessId
      startedAt = $owned.CreationDate.ToUniversalTime().ToString('o')
      stopRequestedAt = [DateTime]::UtcNow.ToString('o')
      port = 18791
    }
    Write-CodexRuntimeJson $resultPath $report
    Stop-Process -Id $owned.ProcessId -ErrorAction Stop
    Wait-LaunchProbeRuntimeExit -RuntimeProcessId $owned.ProcessId -StartedAt $report.runtimeStop.startedAt -Port 18791 -Trace $report.runtimeStop
    Write-CodexRuntimeJson $resultPath $report
  }
  if (Get-NetTCPConnection -State Listen -LocalPort 18791 -ErrorAction SilentlyContinue) { throw '共享端口仍在监听，暂时不能验证独立启动，原设置将恢复。' }
  [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
  Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
  Send-LaunchEnvironmentChanged
  $report.stage = 'original-icon-with-shared-offline'
  Write-CodexRuntimeJson $resultPath $report
  $normalMarker = 'NORMAL' + (Get-Random -Minimum 10000 -Maximum 99999)
  Write-Host ''
  Write-Host '第 2 步 / 共 4 步：用原来的 Codex 图标打开，验证独立运行' -ForegroundColor Cyan
  Write-Host '共享后台已停止。请点击你原来使用的“Codex”图标，不要点“Codex 共享会话”。'
  Write-Host '在打开的 Codex 中新建一个测试任务，复制并发送下面这句话：'
  Write-Host ("只回复 {0}，不要使用任何工具。" -f $normalMarker) -ForegroundColor Yellow
  Write-Host '收到回复后，回到这个 PowerShell 窗口，粘贴 Codex 实际回复的编号。'
  Write-Host '如果打不开或没有回复，请输入“失败”并回车，脚本会恢复原配置。'
  $normalReply = Read-LaunchProbeInput '请粘贴实际回复的编号，或输入“失败”'
  if ($normalReply.Trim() -ne $normalMarker) { throw '没有确认原图标能正常对话，本次验证未通过，原配置将恢复。' }
  $normalState = Get-LaunchProbeDesktopState 18791
  if ($normalState.rootIds.Count -ne 1 -or $normalState.localBackendIds.Count -lt 1 -or $normalState.sharedConnectionPids.Count -ne 0) { throw '没有确认 Codex 使用自己的独立后台，不能将本步记为通过。' }
  if (Get-NetTCPConnection -State Listen -LocalPort 18791 -ErrorAction SilentlyContinue) { throw '测试期间共享后台被重新启动，本次无法证明独立运行。' }
  $report.independent = @{ passed = $true; actualReply = $normalReply.Trim(); processState = $normalState; sharedListenerAbsent = $true; userConfirmedOriginalIcon = $true }
  $report.stage = 'waiting-for-independent-exit'
  Write-CodexRuntimeJson $resultPath $report
  Write-Host ''
  Write-Host '独立启动验证通过。' -ForegroundColor Green
  Write-Host '第 3 步 / 共 4 步：退出刚才测试的 Codex，准备切换到共享模式' -ForegroundColor Cyan
  Write-Host '请再次退出带聊天界面的 Codex，继续保留这个 PowerShell 窗口。'
  $null = Read-LaunchProbeInput '退出 Codex 后，回到这里按回车继续'
  Wait-LaunchProbeDesktopExit
  if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')) { throw '全局共享地址被其他操作重新写入，本次无法验证只对这次启动生效。' }
  Write-Host '正在启动共享后台，并自动打开连接它的 Codex；请不要自行点击其他 Codex 图标……'
  $service = Start-SharedCodex $dataRoot $runtimeConfig
  $launchResultPath = Join-Path $runDirectory 'shared-launch.json'
  & $helper -Mode Shared -WsUrl $service.wsUrl -ResultPath $launchResultPath -ShowWindow | Out-Null
  $launchResult = Get-Content -LiteralPath $launchResultPath -Encoding UTF8 -Raw | ConvertFrom-Json
  if (-not $launchResult.started -or $launchResult.error -or -not $launchResult.pid) { throw '没有确认 Codex 启动成功，详细信息已记录，原配置将恢复。' }
  $report.stage = 'per-launch-shared-mode'
  Write-CodexRuntimeJson $resultPath $report
  $sharedMarker = 'SHARED' + (Get-Random -Minimum 10000 -Maximum 99999)
  Write-Host ''
  Write-Host '第 4 步 / 共 4 步：在自动打开的 Codex 中验证共享运行' -ForegroundColor Cyan
  Write-Host '新建一个测试任务，复制并发送下面这句话：'
  Write-Host ("只回复 {0}，不要使用任何工具。" -f $sharedMarker) -ForegroundColor Yellow
  Write-Host '把 Codex 实际回复的编号粘贴回这里；打不开或没有回复时输入“失败”。'
  $sharedReply = Read-LaunchProbeInput '请粘贴实际回复的编号，或输入“失败”'
  if ($sharedReply.Trim() -ne $sharedMarker) { throw '没有确认共享模式能正常对话，本次验证未通过。' }
  $sharedState = Get-LaunchProbeDesktopState 18791
  if ($sharedState.rootIds.Count -ne 1 -or $sharedState.sharedConnectionPids.Count -lt 1 -or $sharedState.localBackendIds.Count -ne 0) { throw '没有确认 Codex 只使用指定的共享后台，本次验证未通过。' }
  if ($sharedState.rootIds[0] -ne $launchResult.pid) { throw '当前 Codex 不是本脚本刚启动的窗口，本次无法确认启动结果。' }
  if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')) { throw '启动过程中出现了全局共享地址，未通过只对本次启动生效的检查。' }
  $report.shared = @{ passed = $true; actualReply = $sharedReply.Trim(); processState = $sharedState; userEndpointAbsent = $true }
  $report.stage = 'restoring-original-setup'
  Write-CodexRuntimeJson $resultPath $report
  $report.passed = $true
} catch {
  $report.failedAtStage = $report.stage
  $report.error = $_.Exception.Message
  $report.cancelled = $_.Exception -is [OperationCanceledException]
  $report.passed = $false
  Show-LaunchProbeError $_.Exception.Message
} finally {
  if ($changed) {
    Write-Host '正在恢复测试前的配置和飞书服务，请保留这个窗口……'
    try { Restore-LaunchProbeState $backup; $report.originalSetupRestored = $true }
    catch { $report.originalSetupRestored = $false; $report.restoreError = $_.Exception.Message; $report.passed = $false; Write-Warning "恢复未完成，请执行开头显示的恢复命令，或把这个备份路径交给 Codex：$backupPath" }
  }
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  $report.stage = if ($report.passed) { 'completed' } else { 'incomplete' }
  Write-CodexRuntimeJson $resultPath $report
  $artifacts = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts'
  New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
  Copy-Item -LiteralPath $resultPath -Destination (Join-Path $artifacts 'launch-modes-interactive-latest.json') -Force
}
Write-Host ''
if ($report.passed) { Write-Host '验证结果：通过。两个启动方式均已完成本次验证。' -ForegroundColor Green }
elseif ($report.cancelled) { Write-Host '验证结果：已取消。' -ForegroundColor Yellow }
else { Write-Host '验证结果：未通过或未完成，请回到原来的 Codex 任务，让它查看日志。' -ForegroundColor Yellow }
Write-Host "结果文件：$resultPath"
if (-not $changed) { Write-Host '本次没有更改环境设置或停止服务。' }
elseif ($report.originalSetupRestored) { Write-Host '原配置和飞书服务已恢复。这次只是验证，尚未更换正式启动方式。' }
else { Write-Warning '原配置尚未完全恢复，请使用上方的恢复命令，或请 Codex 协助恢复。' }
$null = Read-Host '请记下上面的验证结果。现在可以按回车结束'
if ($report.passed) { exit 0 } else { exit 1 }
