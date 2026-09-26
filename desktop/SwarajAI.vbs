' ============================================================
'  Swaraj AI — Desktop Launcher (double-click, no black window)
'  Starts the entire Swaraj AI agent hidden in the background
'  and opens it like a desktop app. Errors appear as message
'  boxes — never a flashing console.
'
'  First time? Run Setup-SwarajAI.bat once (installs Node.js,
'  Ollama and the 3 local models automatically).
'  To quit the app later, double-click Stop-SwarajAI.
' ============================================================
Option Explicit

Dim fso, sh, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)

Dim serverJs, logFile, pidFile
serverJs = fso.BuildPath(appDir, "src\server.js")
logFile = fso.BuildPath(appDir, "server.log")
pidFile = fso.BuildPath(appDir, "swaraj.pid")

' ---- 0. Sanity: complete package? (running from inside the ZIP fails) ----
If Not fso.FileExists(serverJs) Then
  MsgBox "Swaraj AI files not found." & vbCrLf & vbCrLf & _
    "You may be running this from inside the ZIP preview." & vbCrLf & _
    "Right-click the ZIP > Extract All, then double-click SwarajAI inside the extracted folder.", _
    48, "Swaraj AI — extract the ZIP first"
  WScript.Quit 1
End If

' ---- 1. Already running? Just open it. ----
Dim readyUrl : readyUrl = FindReadyUrl()
If readyUrl <> "" Then
  OpenBrowser readyUrl
  MsgBox "Swaraj AI is already running." & vbCrLf & vbCrLf & _
    "Workbench: " & readyUrl & "/workbench.html" & vbCrLf & _
    "To stop it, double-click Stop-SwarajAI.", 64, "Swaraj AI"
  WScript.Quit 0
End If
KillStalePidFile

' ---- 2. Node.js present? ----
Dim nodeExe : nodeExe = FindNode()
If nodeExe = "" Then
  MsgBox "Node.js 18 or newer is required but was not found on this PC." & vbCrLf & vbCrLf & _
    "EASY FIX — pick one:" & vbCrLf & _
    "  1. Double-click Setup-SwarajAI.bat (installs Node.js + Ollama + models automatically), or" & vbCrLf & _
    "  2. Install Node.js LTS from https://nodejs.org , then double-click SwarajAI again.", _
    48, "Swaraj AI — Node.js missing"
  WScript.Quit 1
End If

' ---- 3. Start the server hidden (no console window) ----
Dim pid : pid = StartHidden("cmd /c """"" & nodeExe & """ """ & serverJs & """ >> """ & logFile & """ 2>&1""", appDir)
If pid <= 0 Then
  MsgBox "Could not start the Swaraj AI server." & vbCrLf & vbCrLf & _
    "See the end of server.log in this folder for details.", 16, "Swaraj AI — start failed"
  WScript.Quit 1
End If
WritePid pid

' ---- 4. Wait until it answers ----
readyUrl = WaitReady()
If readyUrl = "" Then
  StopPid pid
  MsgBox "The server did not become ready in time." & vbCrLf & vbCrLf & _
    "Possible causes:" & vbCrLf & _
    "  • Another program uses ports 8080-8089 (close it and retry)" & vbCrLf & _
    "  • Antivirus blocked Node.js (allow it once)" & vbCrLf & _
    "Details are at the end of server.log in this folder.", 16, "Swaraj AI — not ready"
  WScript.Quit 1
End If

' ---- 5. Open + confirm ----
OpenBrowser readyUrl
MsgBox "Swaraj AI is running!" & vbCrLf & vbCrLf & _
  "Website:   " & readyUrl & "/" & vbCrLf & _
  "Workbench: " & readyUrl & "/workbench.html" & vbCrLf & vbCrLf & _
  "It runs hidden in the background." & vbCrLf & _
  "To stop it, double-click Stop-SwarajAI.", 64, "Swaraj AI — ready"

' ================= helpers =================

Function FindNode()
  FindNode = ""
  Dim cand, p
  ' Well-known install locations first (no console flash needed).
  cand = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"))
  For Each p In cand
    If fso.FileExists(p) Then FindNode = p : Exit Function
  Next
  ' Then every directory on PATH.
  Dim pathEnv, dirs, d, exe
  On Error Resume Next
  pathEnv = sh.Environment("PROCESS")("PATH")
  On Error GoTo 0
  If pathEnv = "" Then Exit Function
  dirs = Split(pathEnv, ";")
  For Each d In dirs
    d = Trim(d)
    If d <> "" Then
      exe = fso.BuildPath(d, "node.exe")
      If fso.FileExists(exe) Then FindNode = exe : Exit Function
    End If
  Next
End Function

Function StartHidden(cmd, workDir)
  On Error Resume Next
  Dim svc, startup, cfg, proc, pid, rc
  Set svc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
  Set startup = GetObject("winmgmts:\\.\root\cimv2:Win32_ProcessStartup")
  Set cfg = startup.SpawnInstance_
  cfg.ShowWindow = 0 ' hidden — this is what kills the black window
  Set proc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
  rc = proc.Create(cmd, workDir, cfg, pid)
  If Err.Number <> 0 Or rc <> 0 Then StartHidden = -1 Else StartHidden = pid
  On Error GoTo 0
End Function

Sub WritePid(pid)
  On Error Resume Next
  Dim t : Set t = fso.CreateTextFile(pidFile, True)
  t.WriteLine CStr(pid)
  t.Close
End Sub

Sub KillStalePidFile()
  On Error Resume Next
  If Not fso.FileExists(pidFile) Then Exit Sub
  Dim t, oldPid
  Set t = fso.OpenTextFile(pidFile, 1)
  oldPid = CLng(Trim(t.ReadAll()))
  t.Close
  If oldPid > 0 Then StopPid oldPid
  fso.DeleteFile pidFile, True
  On Error GoTo 0
End Sub

Sub StopPid(pid)
  On Error Resume Next
  Dim svc, procs, p
  Set svc = GetObject("winmgmts:\\.\root\cimv2")
  Set procs = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & CLng(pid))
  For Each p In procs
    p.Terminate
  Next
  On Error GoTo 0
End Sub

Function HttpOk(url)
  On Error Resume Next
  Dim h
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 1500, 1500, 1500, 1500
  h.open "GET", url & "/api/health", False
  h.send
  HttpOk = (Err.Number = 0 And h.status = 200)
  On Error GoTo 0
End Function

Function FindReadyUrl()
  FindReadyUrl = ""
  Dim port
  For port = 8080 To 8089
    If HttpOk("http://127.0.0.1:" & port) Then
      FindReadyUrl = "http://127.0.0.1:" & port
      Exit Function
    End If
  Next
End Function

Function WaitReady()
  ' ~30s grace: quick scan, then patient polling on each port.
  WaitReady = FindReadyUrl()
  If WaitReady <> "" Then Exit Function
  Dim i
  For i = 1 To 25
    WScript.Sleep 1000
    WaitReady = FindReadyUrl()
    If WaitReady <> "" Then Exit Function
  Next
  WaitReady = ""
End Function

Sub OpenBrowser(url)
  Dim edge, chrome, profile
  edge = sh.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")
  If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")
  chrome = sh.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe")
  If Not fso.FileExists(chrome) Then chrome = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe")
  profile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\SwarajAI\WebApp")
  On Error Resume Next
  If fso.FileExists(edge) Then
    sh.Run """" & edge & """ --app=""" & url & "/workbench.html"" --user-data-dir=""" & profile & """", 1, False
  ElseIf fso.FileExists(chrome) Then
    sh.Run """" & chrome & """ --app=""" & url & "/workbench.html"" --user-data-dir=""" & profile & """", 1, False
  Else
    sh.Run url & "/workbench.html", 1, False ' default browser
  End If
  On Error GoTo 0
End Sub
