' ============================================================
'  Swaraj AI — Stop (double-click to quit the hidden server)
' ============================================================
Option Explicit

Dim fso, sh, appDir, pidFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
pidFile = fso.BuildPath(appDir, "swaraj.pid")

Dim stopped : stopped = False

' 1. PID file (written by SwarajAI.vbs).
On Error Resume Next
If fso.FileExists(pidFile) Then
  Dim t, pid
  Set t = fso.OpenTextFile(pidFile, 1)
  pid = CLng(Trim(t.ReadAll()))
  t.Close
  If pid > 0 Then stopped = KillPid(pid) Or stopped
  fso.DeleteFile pidFile, True
End If

' 2. Fallback: any node.exe running THIS app's server.js.
Dim svc, procs, p, q
Set svc = GetObject("winmgmts:\\.\root\cimv2")
Set procs = svc.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
For Each p In procs
  q = LCase("" & p.CommandLine)
  If InStr(q, "server.js") > 0 And (InStr(q, "swarajai") > 0 Or InStr(q, LCase(appDir)) > 0) Then
    If KillPid(p.ProcessId) Then stopped = True
  End If
Next
On Error GoTo 0

If stopped Then
  MsgBox "Swaraj AI has been stopped.", 64, "Swaraj AI"
Else
  MsgBox "Swaraj AI does not appear to be running.", 64, "Swaraj AI"
End If

Function KillPid(pid)
  On Error Resume Next
  Dim svc2, found, x
  Set svc2 = GetObject("winmgmts:\\.\root\cimv2")
  Set found = svc2.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & CLng(pid))
  KillPid = False
  For Each x In found
    x.Terminate
    KillPid = True
  Next
  On Error GoTo 0
End Function
