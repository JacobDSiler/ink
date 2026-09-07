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
powershell -NoProfile -Command "Get-Content .dev.vars | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S' -and $_ -notmatch '^\s*FIREBASE_SERVICE_ACCOUNT\s*=' } | Set-Content -Encoding ASCII .dev.vars.tmp"
call npx wrangler secret bulk .dev.vars.tmp
del .dev.vars.tmp >nul 2>nul
echo.
if exist "service-account.json" (
  echo  Found service-account.json - uploading it base64-encoded as FIREBASE_SERVICE_ACCOUNT_B64
  echo  ^(no quotes to lose; this replaces any pasted FIREBASE_SERVICE_ACCOUNT^)...
  powershell -NoProfile -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes('service-account.json'))" > .sa.b64.tmp
  call npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_B64 < .sa.b64.tmp
  del .sa.b64.tmp >nul 2>nul
  call npx wrangler secret delete FIREBASE_SERVICE_ACCOUNT --force >nul 2>nul
) else (
  echo  Tip: save the Firebase service-account key file as  service-account.json  in this folder
  echo  and re-run - it is uploaded safely without pasting. ^(The file is git-ignored.^)
)
echo.
echo  Secrets now on the Worker:
call npx wrangler secret list
echo.
echo  Done. Press any key to close.
pause >nul
