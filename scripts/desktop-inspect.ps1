param([string]$Ports = '8790,18791,18792', [string]$ProcessIds = '', [switch]$Server, [switch]$ProgressOutput)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'desktop-tcp-snapshot.ps1')

function Write-InspectionStage([string]$Stage) {
    if ($Server -and $ProgressOutput -and $script:inspectionId) {
        [Console]::Out.WriteLine((@{ id = $script:inspectionId; stage = $Stage } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    }
}

function Get-DesktopInspection([string]$PortText, [string]$ProcessIdText) {
    Write-InspectionStage 'processes'
    $filter = "Name = 'ChatGPT.exe' OR Name = 'Codex.exe' OR Name = 'node.exe'"
    if ($ProcessIdText) {
        foreach ($value in $ProcessIdText.Split(',')) {
            $processNumber = [uint32]$value
            if ($processNumber -gt 0) { $filter += " OR ProcessId = $processNumber" }
        }
    }
    $all = @(Get-CimInstance Win32_Process -Filter $filter -OperationTimeoutSec 10 -ErrorAction Stop)
    $processes = @($all | ForEach-Object {
        $resolvedPath = [string]$_.ExecutablePath
        if (-not $resolvedPath -and $_.CreationDate) {
            try {
                $handle = Get-Process -Id $_.ProcessId -ErrorAction Stop
                $ticks = $handle.StartTime.ToUniversalTime().Ticks
                if (($ticks - ($ticks % 10)) -eq $_.CreationDate.ToUniversalTime().Ticks) { $resolvedPath = [string]$handle.Path }
            } catch { }
        }
        @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; exe = $resolvedPath; commandLine = [string]$_.CommandLine; startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) }
    })
    $desktopRoots = @($processes | Where-Object {
        $_.exe -match '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:ChatGPT|Codex)\.exe$' -and $_.commandLine -notmatch '(?i)(?:^|\s|"|\x27)--type(?:=|\s)'
    })
    $unknown = @($processes | Where-Object { $_.name -ieq 'ChatGPT.exe' -and -not $_.exe }).Count -gt 0
    $portNumbers = @($PortText.Split(',') | ForEach-Object { $number = [int]$_; if ($number -lt 1024 -or $number -gt 65535) { throw '端口超出允许范围。' }; $number })
    Write-InspectionStage 'connections'
    $connections = @([FeishuCodex.TcpSnapshot]::Read([int[]]$portNumbers))
    Write-InspectionStage 'binaries'
    $binaries = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $candidate = Join-Path $_.FullName 'codex.exe'; if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
    } | Sort-Object LastWriteTime -Descending)
    $mcpBinaries = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $candidate = Join-Path $_.FullName 'bin\node.exe'; if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
    } | Sort-Object LastWriteTime -Descending)
    return @{ processes = $processes; desktopRoots = $desktopRoots; unknownDesktop = $unknown; connections = $connections; nativeCodexPath = $(if ($binaries.Count) { $binaries[0].FullName } else { $null }); mcpNodePath = $(if ($mcpBinaries.Count) { $mcpBinaries[0].FullName } else { $null }) }
}

if ($Server) {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if (-not $line) { continue }
        $id = $null
        try {
            $request = $line | ConvertFrom-Json -ErrorAction Stop
            $id = [string]$request.id
            $script:inspectionId = $id
            if (-not $id -or [string]$request.ports -notmatch '^\d+(?:,\d+)*$' -or ([string]$request.processIds -and [string]$request.processIds -notmatch '^\d+(?:,\d+)*$')) { throw '检查请求格式无效。' }
            $result = Get-DesktopInspection ([string]$request.ports) ([string]$request.processIds)
            [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 8 -Compress))
        } catch {
            [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
        }
        [Console]::Out.Flush()
    }
    exit 0
}

Get-DesktopInspection $Ports $ProcessIds | ConvertTo-Json -Depth 7 -Compress
