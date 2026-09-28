function Get-DesktopEnvironmentBackup {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    try {
        $exists = $key -and @($key.GetValueNames()) -contains 'CODEX_APP_SERVER_WS_URL'
        return @{ exists = [bool]$exists; value = $(if ($exists) { $key.GetValue('CODEX_APP_SERVER_WS_URL', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }); kind = $(if ($exists) { [string]$key.GetValueKind('CODEX_APP_SERVER_WS_URL') } else { $null }) }
    } finally { if ($key) { $key.Dispose() } }
}

function Set-DesktopEnvironmentBackup($Backup) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        if ($Backup.exists) { $key.SetValue('CODEX_APP_SERVER_WS_URL', $Backup.value, [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$Backup.kind)) }
        else { $key.DeleteValue('CODEX_APP_SERVER_WS_URL', $false) }
    } finally { $key.Dispose() }
    Send-DesktopEnvironmentChanged
}

function Send-DesktopEnvironmentChanged {
    if (-not ('FeishuCodexEnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FeishuCodexEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $result = [UIntPtr]::Zero
    [void][FeishuCodexEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}

function Stop-DesktopVerifiedProcess($Process, [int]$Port, [string]$TemporaryDirectory) {
    $identity = @{ pid = [int]$Process.ProcessId; exe = $Process.ExecutablePath; startedAt = $Process.CreationDate.ToUniversalTime().ToString('o') }
    $file = Join-Path $TemporaryDirectory ('stop-' + [Guid]::NewGuid().ToString('N') + '.json')
    Write-CodexRuntimeJson $file $identity
    try { & (Join-Path $PSScriptRoot 'desktop-stop-owned.ps1') -IdentityFile $file -Port $Port }
    finally { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}

function Test-DesktopRecordedIdentity($Candidate, $Identity) {
    if (-not $Candidate -or $Candidate.CreationDate.ToUniversalTime().ToString('o') -ne $Identity.startedAt) { return $false }
    $resolvedPath = [string]$Candidate.ExecutablePath
    if (-not $resolvedPath) {
        $handle = Get-Process -Id $Candidate.ProcessId -ErrorAction Stop
        $ticks = $handle.StartTime.ToUniversalTime().Ticks
        if (($ticks - ($ticks % 10)) -ne $Candidate.CreationDate.ToUniversalTime().Ticks) { return $false }
        $resolvedPath = [string]$handle.Path
    }
    return $resolvedPath -ieq $Identity.exe
}
