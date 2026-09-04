@echo off
title Ink - set Worker secrets
cd /d "%~dp0"
echo.
echo  This sets the five secrets the Ink Worker needs. Each prompt waits for you
echo  to paste the value and press Enter (nothing is echoed). Run it once; re-run
echo  any time to rotate a value. Press Enter on an empty line to skip a secret.
echo.
echo  1/5 FIREBASE_SERVICE_ACCOUNT - Firebase console ^> Project settings ^> Service accounts
echo      ^> Generate new private key. Open the JSON, copy ALL of it, paste as one line.
call npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
echo.
echo  2/5 RESEND_API_KEY - resend.com ^> API Keys
call npx wrangler secret put RESEND_API_KEY
echo.
echo  3/5 RESEND_WEBHOOK_SECRET - resend.com ^> Webhooks ^> your Ink webhook ^> Signing secret (whsec_...)
call npx wrangler secret put RESEND_WEBHOOK_SECRET
echo.
echo  4/5 GEMINI_API_KEY - aistudio.google.com ^> Get API key
call npx wrangler secret put GEMINI_API_KEY
echo.
echo  5/5 INK_SIGNING_SECRET - any long random string (signs unsubscribe/confirm/approve links).
echo      A fresh one is suggested below; paste it or use your own.
for /f "delims=" %%R in ('powershell -NoProfile -Command "-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | %% {[char]$_})"') do set "SUGGEST=%%R"
echo      %SUGGEST%
call npx wrangler secret put INK_SIGNING_SECRET
echo.
echo  Secrets now on the Worker:
call npx wrangler secret list
echo.
echo  Done. Press any key to close.
pause >nul
