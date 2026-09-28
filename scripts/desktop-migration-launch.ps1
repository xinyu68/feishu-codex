param(
    [Parameter(Mandatory=$true)][string]$ProductRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$DataDir,
    [Parameter(Mandatory=$true)][string]$StatusFile,
    [Parameter(Mandatory=$true)][string]$RunId,
    [switch]$NonInteractive,
    [switch]$WaitForDesktopExit
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$startedAt = [DateTime]::UtcNow.ToString('o')
$requestFile = $null

function Publish-LaunchStatus([string]$Status, [string]$Message) {
    $record = @{ runId = $RunId; status = $Status; state = $Status; phase = 'permissions'; message = $Message; pid = $PID; startedAt = $startedAt; updatedAt = [DateTime]::UtcNow.ToString('o'); changed = $false }
    $temporary = $StatusFile + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $StatusFile -Force
    Write-Output $Message
}

try {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StatusFile))
    $migrationScript = Join-Path $ProductRoot 'scripts\desktop-migrate.ps1'
    $preflightFile = Join-Path $DataDir 'desktop\migration-preflight.json'
    $expectedUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Publish-LaunchStatus 'running' '正在检查旧服务身份和接管权限；无需先关闭 Codex。'
    & $migrationScript -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir -NonInteractive -CheckOnly -PreflightFile $preflightFile -ExpectedUserSid $expectedUserSid
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $preflightFile)) { throw '接管预检查未完成，请查看日志。' }
    $preflight = [IO.File]::ReadAllText($preflightFile) | ConvertFrom-Json
    if ($preflight.requiresElevation) {
        Publish-LaunchStatus 'waiting_for_elevation' '旧服务以管理员权限运行，本次接管需要管理员授权。请在 Windows 权限提示中选择“是”；日常应用和新后台仍以普通权限运行。'
        $requestFile = Join-Path $DataDir ('desktop\elevated-migration-' + [Guid]::NewGuid().ToString('N') + '.json')
        $request = @{ script = $migrationScript; productRoot = $ProductRoot; nodePath = $NodePath; dataDir = $DataDir; statusFile = $StatusFile; runId = $RunId; expectedUserSid = $expectedUserSid }
        [IO.File]::WriteAllText($requestFile, ($request | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        $command = @'
$ErrorActionPreference = 'Stop'
$request = [IO.File]::ReadAllText('__REQUEST_FILE__') | ConvertFrom-Json
& $request.script -ProductRoot $request.productRoot -NodePath $request.nodePath -DataDir $request.dataDir -StatusFile $request.statusFile -RunId $request.runId -ExpectedUserSid $request.expectedUserSid -NonInteractive -WaitForDesktopExit
exit $LASTEXITCODE
'@
        $command = $command.Replace('__REQUEST_FILE__', $requestFile.Replace("'", "''"))
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        try {
            $process = Start-Process -FilePath $powershellPath -Verb RunAs -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -WindowStyle Hidden -Wait -PassThru
            $process.WaitForExit()
            $process.Refresh()
            $code = $process.ExitCode
            if ($null -eq $code) { throw '管理员接管进程没有返回退出状态。' }
        } catch {
            if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { throw '管理员授权已取消，尚未更改现有服务。可以重新点击接管。' }
            throw
        }
        if ($code -ne 0) { exit $code }
    } else {
        if ($preflight.blocked) {
            $reasons = @($preflight.checks | Where-Object { $_.status -in @('failed', 'blocked') } | ForEach-Object { $_.message })
            throw ('接管预检查未通过：' + ($reasons -join '；'))
        }
        & $migrationScript -ProductRoot $ProductRoot -NodePath $NodePath -DataDir $DataDir -StatusFile $StatusFile -RunId $RunId -ExpectedUserSid $expectedUserSid -NonInteractive -WaitForDesktopExit
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} catch {
    Publish-LaunchStatus 'failed' $_.Exception.Message
    exit 1
} finally {
    if ($requestFile -and (Test-Path -LiteralPath $requestFile)) { Remove-Item -LiteralPath $requestFile -Force }
}
exit 0
