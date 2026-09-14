@echo off
REM Ink push - double-click launcher for ink-push.ps1 (commit, push, deploy rules + worker).
setlocal
set "PS1=%~dp0ink-push.ps1"
if not exist "%PS1%" ( echo Could not find ink-push.ps1 next to this launcher. & pause & exit /b 1 )
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
if errorlevel 1 ( echo. & echo PowerShell exited with code %errorlevel%. & pause )
endlocal
