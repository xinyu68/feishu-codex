Option Explicit

Dim arguments, executable, wsUrl, resultPath, shell, environment, fileSystem, process, command
Set arguments = WScript.Arguments
If arguments.Count <> 3 Then WScript.Quit 2

executable = arguments.Item(0)
wsUrl = arguments.Item(1)
resultPath = arguments.Item(2)

On Error Resume Next
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("PROCESS")
environment.Remove "CODEX_APP_SERVER_WS_URL"
environment.Remove "CODEX_APP_SERVER_FORCE_CLI"
environment.Remove "CODEX_ELECTRON_USER_DATA_PATH"
environment.Remove "ELECTRON_RUN_AS_NODE"
environment("CODEX_APP_SERVER_WS_URL") = wsUrl

Set fileSystem = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fileSystem.GetParentFolderName(executable)
command = Chr(34) & Replace(executable, Chr(34), Chr(34) & Chr(34)) & Chr(34)
Set process = shell.Exec(command)
If Err.Number <> 0 Then
  WriteResult resultPath, "ERROR|" & CStr(Err.Number)
  WScript.Quit 3
End If

WriteResult resultPath, CStr(process.ProcessID)
WScript.Quit 0

Sub WriteResult(path, value)
  Dim temporaryPath, output
  temporaryPath = path & "." & Replace(CStr(Timer), ".", "") & ".tmp"
  Set output = fileSystem.CreateTextFile(temporaryPath, True, False)
  output.Write value
  output.Close
  If fileSystem.FileExists(path) Then fileSystem.DeleteFile path, True
  fileSystem.MoveFile temporaryPath, path
End Sub
