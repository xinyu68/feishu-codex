param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
$candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
if (-not $candidate -or $candidate.ExecutablePath -notmatch '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$') { throw '未找到可切换的 Codex 窗口。' }
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($ProcessId)) { throw 'Codex 窗口尚未就绪，请从任务栏打开。' }
