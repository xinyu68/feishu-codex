[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WsUrl,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath
)

# Production launcher for the Microsoft Store Codex desktop. The outer
# PowerShell is hidden by the desktop host; the package-context child uses
# wscript.exe so automatic launch does not create a console window.
$ErrorActionPreference = 'Stop'

function Write-LaunchJson([string]$Path, $Value) {
    $temporaryPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporaryPath, ($Value | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Get-AbsolutePath([string]$Value, [string]$Label) {
    if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw "$Label 必须填写 Windows 绝对路径。" }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-CodexClosed {
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop)) {
        if (-not $candidate.ExecutablePath -or -not $candidate.CommandLine) {
            throw "无法确认 ChatGPT.exe 进程（PID $($candidate.ProcessId)）的身份；未重复启动 Codex。"
        }
        if ($candidate.ExecutablePath -match '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$' -and
            $candidate.CommandLine -notmatch '(?i)(?:^|\s|"|\x27)--type(?:=|\s)') {
            throw "Codex 桌面仍在运行（PID $($candidate.ProcessId)），未重复启动。"
        }
    }
}

$report = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString('o')
    started = $false
    pid = $null
    exe = $null
    packageFullName = $null
    launchMethod = 'Invoke-CommandInDesktopPackage + wscript'
    error = $null
}
$resultPathValidated = $false
$pidFile = $null

try {
    if ($WsUrl -notmatch '\Aws://127\.0\.0\.1:([0-9]{1,5})/?\z' -or [int]$Matches[1] -lt 1024 -or [int]$Matches[1] -gt 65535) {
        throw '共享模式的 WsUrl 必须为 ws://127.0.0.1:<1024-65535>，不能包含账号密码、路径、查询参数或片段。'
    }
    $ResultPath = Get-AbsolutePath $ResultPath 'ResultPath'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($ResultPath))
    $resultPathValidated = $true
    Assert-CodexClosed

    $helper = Join-Path $PSScriptRoot 'launch-packaged-shared.vbs'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw '无窗口启动组件缺失，请重新安装 Feishu Codex。' }
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
    if (-not $package) { throw '未找到已安装的商店版 Codex（OpenAI.Codex）。' }
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml') -Raw
    $application = @($manifest.Package.Applications.Application | Where-Object { $_.Executable -match '(?i)(?:^|[\\/])ChatGPT\.exe$' })
    if ($application.Count -ne 1) { throw '无法从安装包清单中唯一确定 ChatGPT.exe 启动入口。' }
    $executable = Join-Path $package.InstallLocation ([string]$application[0].Executable)
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '未找到 Codex 桌面的可执行文件。' }
    [void](Get-Command Invoke-CommandInDesktopPackage -ErrorAction Stop)

    $report.exe = $executable
    $report.packageFullName = [string]$package.PackageFullName
    Write-LaunchJson $ResultPath $report
    $pidFile = Join-Path ([IO.Path]::GetTempPath()) ('feishu-codex-launch-' + [Guid]::NewGuid().ToString('N') + '.txt')
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $arguments = '//B //NoLogo "' + $helper + '" "' + $executable + '" "' + $WsUrl + '" "' + $pidFile + '"'
    Invoke-CommandInDesktopPackage -PackageFamilyName $package.PackageFamilyName -AppId $application[0].Id -Command $wscript -Args $arguments -PreventBreakaway | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (Test-Path -LiteralPath $pidFile -PathType Leaf) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { throw '等待 30 秒仍未收到 Codex 启动结果。' }
    $pidText = [IO.File]::ReadAllText($pidFile).Trim()
    if ($pidText -notmatch '\A[1-9][0-9]*\z') { throw '无窗口启动组件未能创建 Codex 进程。' }
    $processId = [int]$pidText
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    if (-not $process -or $process.ExecutablePath -ine $executable) { throw 'Codex 进程身份与商店安装包不匹配。' }
    $report.pid = $processId
    $report.started = $true
} catch {
    $report.error = $_.Exception.Message
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    if ($resultPathValidated) { Write-LaunchJson $ResultPath $report }
    if ($pidFile -and (Test-Path -LiteralPath $pidFile)) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
}

$report | ConvertTo-Json -Depth 6
if ($report.error) { throw [InvalidOperationException]::new([string]$report.error) }
