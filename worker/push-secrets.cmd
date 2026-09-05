@echo off
title Ink - push secrets from .dev.vars
cd /d "%~dp0"
echo.
if not exist ".dev.vars" (
  echo  No .dev.vars file found next to this script.
  echo  Copy .dev.vars.example to .dev.vars, fill in the values, then run this again.
  echo.
  pause
  exit /b 1
)
echo  Uploading every secret in .dev.vars to the ink-worker...
echo  (blank values are skipped; existing secrets with the same name are replaced)
echo.
powershell -NoProfile -Command "Get-Content .dev.vars | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S' } | Set-Content -Encoding ASCII .dev.vars.tmp"
call npx wrangler secret bulk .dev.vars.tmp
del .dev.vars.tmp >nul 2>nul
echo.
echo  Secrets now on the Worker:
call npx wrangler secret list
echo.
echo  Done. Press any key to close.
pause >nul
