Option Explicit

Const TASK_STATE_RUNNING = 4
Const TASK_CREATE_OR_UPDATE = 6
Const TASK_LOGON_INTERACTIVE_TOKEN = 3
Dim arguments, productRoot, nodePath, dataDir, hostScript, expectedExecutable, expectedArguments
Dim legacyHostScript, legacyExecutable, legacyArguments
Dim scheduler, folder, task, definition, action, runningTask, shell, wasRunning

Set arguments = WScript.Arguments
If arguments.Count <> 3 Then WScript.Quit 2
productRoot = arguments.Item(0)
nodePath = arguments.Item(1)
dataDir = arguments.Item(2)
hostScript = productRoot & "\scripts\desktop-host.vbs"

Set shell = CreateObject("WScript.Shell")
expectedExecutable = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
expectedArguments = "//B //NoLogo " & Quote(hostScript) & " " & Quote(productRoot) & " " & Quote(nodePath) & " " & Quote(dataDir)
legacyHostScript = productRoot & "\scripts\desktop-host.ps1"
legacyExecutable = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
legacyArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(legacyHostScript) & " -ProductRoot " & Quote(productRoot) & " -NodePath " & Quote(nodePath) & " -DataDir " & Quote(dataDir)

On Error Resume Next
Set scheduler = CreateObject("Schedule.Service")
scheduler.Connect
Set folder = scheduler.GetFolder("\")
Set task = folder.GetTask("Feishu Codex Desktop Host")
If Err.Number <> 0 Then WScript.Quit 3
On Error GoTo 0

Set definition = task.Definition
wasRunning = (task.State = TASK_STATE_RUNNING)
If definition.Triggers.Count <> 0 Then WScript.Quit 4
If definition.Actions.Count <> 1 Then WScript.Quit 5
Set action = definition.Actions.Item(1)
If StrComp(action.WorkingDirectory, productRoot, vbTextCompare) <> 0 Then WScript.Quit 8

If StrComp(action.Path, expectedExecutable, vbTextCompare) <> 0 Or StrComp(action.Arguments, expectedArguments, vbBinaryCompare) <> 0 Then
  If StrComp(action.Path, legacyExecutable, vbTextCompare) <> 0 Then WScript.Quit 6
  If StrComp(action.Arguments, legacyArguments, vbBinaryCompare) <> 0 Then WScript.Quit 7
  action.Path = expectedExecutable
  action.Arguments = expectedArguments
  On Error Resume Next
  Set task = folder.RegisterTaskDefinition("Feishu Codex Desktop Host", definition, TASK_CREATE_OR_UPDATE, definition.Principal.UserId, Empty, TASK_LOGON_INTERACTIVE_TOKEN)
  If Err.Number <> 0 Then
    If wasRunning Then WScript.Quit 0
    WScript.Quit 10
  End If
  On Error GoTo 0
End If

If task.State <> TASK_STATE_RUNNING Then
  On Error Resume Next
  Set runningTask = task.Run(Empty)
  If Err.Number <> 0 Then WScript.Quit 9
  On Error GoTo 0
End If
WScript.Quit 0

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
