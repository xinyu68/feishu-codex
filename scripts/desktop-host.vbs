Option Explicit

Dim arguments, productRoot, nodePath, dataDir, entry, shell, command, exitCode
Set arguments = WScript.Arguments
If arguments.Count <> 3 Then WScript.Quit 2

productRoot = arguments.Item(0)
nodePath = arguments.Item(1)
dataDir = arguments.Item(2)
entry = productRoot & "\desktop\host.mjs"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = productRoot
command = Quote(nodePath) & " " & Quote(entry) & " --root " & Quote(productRoot) & " --data-dir " & Quote(dataDir)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
