Option Explicit

'=====================================================================
' youtube98 - protocol handler shim for Win98SE
'
' Registered against the "youtube98:" URL scheme by youtube98.reg.
'
' Why this exists: Windows passes a protocol handler the WHOLE url as %1,
' e.g.  youtube98:Z:\youtube98\abc12345678.mpg
' No media player can open that, so this strips the scheme and launches
' the player with the bare path.
'
' Install:  copy this file to C:\youtube98\play.vbs, then run youtube98.reg
'=====================================================================

Dim raw, p, sh, fso, i, candidates, player

If WScript.Arguments.Count = 0 Then
  MsgBox "No URL supplied.", 16, "youtube98"
  WScript.Quit 1
End If

raw = WScript.Arguments(0)
p = raw

' --- strip the scheme -----------------------------------------------
If LCase(Left(p, 10)) = "youtube98:" Then p = Mid(p, 11)
If Left(p, 2) = "//" Then p = Mid(p, 3)

' IE may percent-encode parts of the path, and may hand back forward
' slashes or a trailing separator.
p = Replace(p, "%5C", "\")
p = Replace(p, "%5c", "\")
p = Replace(p, "%20", " ")
p = Replace(p, "/", "\")
Do While Len(p) > 0 And Right(p, 1) = "\"
  p = Left(p, Len(p) - 1)
Loop

If Len(p) = 0 Then
  MsgBox "Could not parse a path out of:" & vbCrLf & raw, 16, "youtube98"
  WScript.Quit 1
End If

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

If Not fso.FileExists(p) Then
  MsgBox "File not found:" & vbCrLf & p & vbCrLf & vbCrLf & _
         "Is the Z: drive mapped to \\phobos\archive ?", 16, "youtube98"
  WScript.Quit 1
End If

' --- find a player ---------------------------------------------------
' Prefer Media Player Classic wherever it happens to live; otherwise hand
' the file to whatever .mpg is associated with.
candidates = Array( _
  "C:\Program Files\Media Player Classic\mplayerc.exe", _
  "C:\Program Files\Media Player Classic\mpc-hc.exe", _
  "C:\Program Files\MPC\mplayerc.exe", _
  "C:\Program Files\K-Lite Codec Pack\Media Player Classic\mplayerc.exe", _
  "C:\MPC\mplayerc.exe", _
  "C:\mplayerc.exe")

player = ""
For i = 0 To UBound(candidates)
  If player = "" Then
    If fso.FileExists(candidates(i)) Then player = candidates(i)
  End If
Next

If player <> "" Then
  sh.Run """" & player & """ """ & p & """", 1, False
Else
  ' No MPC found - use the shell association for .mpg instead of failing.
  On Error Resume Next
  CreateObject("Shell.Application").ShellExecute p
  If Err.Number <> 0 Then
    MsgBox "No player found and the shell refused to open:" & vbCrLf & p, _
           16, "youtube98"
    WScript.Quit 1
  End If
End If
