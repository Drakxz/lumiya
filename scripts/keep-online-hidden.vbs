Option Explicit

' Use wscript.exe (GUI host) so no console is created by Task Scheduler.
' Wait for PowerShell to finish so the task's overlap policy stays effective.
Dim shell, files, script, powershell, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "keep-online.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = """" & powershell & """ -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
