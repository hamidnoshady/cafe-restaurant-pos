' Start-CafePOS.vbs  (Phase 12)
'
' Invisible launcher — runs Start-CafePOS.bat with no console window so the
' staff never sees a black terminal flash on screen.
'
' This is what the desktop shortcut and the Startup folder entry point to.
' The .bat does all the real work; this wrapper just hides the window.

Dim sh
Set sh = CreateObject("WScript.Shell")

' Build the path to the .bat sitting next to this .vbs file.
Dim here
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' 0 = hidden window, False = don't wait for it to finish (fire and forget).
sh.Run "cmd /c """ & here & "Start-CafePOS.bat""", 0, False

Set sh = Nothing
