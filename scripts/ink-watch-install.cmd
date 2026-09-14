@echo off
REM InkWatch - double-click to install the login auto-start AND start the tray watcher now.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ink-watch-install.ps1" -StartNow
pause
