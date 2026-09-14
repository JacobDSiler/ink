' InkWatch - silent launcher. Double-click to start ink-watch.ps1 with no console window.
' The install script puts a shortcut to this in your Startup folder so it runs at login.
Dim WshShell
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\dev\ink\scripts\ink-watch.ps1""", 0, False
Set WshShell = Nothing
