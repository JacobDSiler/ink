@echo off
setlocal EnableDelayedExpansion
title Ink - deploy
cd /d "%~dp0"

echo.
echo  ====================================================
echo   INK  ^|  add + commit + push  ^|  rules  ^|  worker
echo  ====================================================
echo.

:: -- 1. Commit message ---------------------------------------------
if not exist "COMMIT_MESSAGE.txt" (
  echo  COMMIT_MESSAGE.txt is missing. Create it next to this file and put
  echo  your message in it ^(first line = subject^). Aborting.
  goto :end
)
set "MSG="
for /f "usebackq delims=" %%L in ("COMMIT_MESSAGE.txt") do (
  if not defined MSG set "MSG=%%L"
)
if not defined MSG (
  echo  COMMIT_MESSAGE.txt is empty. Aborting.
  goto :end
)
echo  Commit message: "!MSG!"
echo.

:: -- 2. Git: add, commit, push -------------------------------------
echo  [git] adding changes...
git add -A
if errorlevel 1 goto :gitfail

git diff --cached --quiet
if errorlevel 1 (
  echo  [git] committing...
  git commit -F COMMIT_MESSAGE.txt
  if errorlevel 1 goto :gitfail
) else (
  echo  [git] nothing new to commit - pushing anyway.
)

echo  [git] pushing to origin main...
git push origin main
if errorlevel 1 goto :gitfail
echo  [git] done. GitHub Pages will republish ink.jacobsiler.com in a minute.
echo.

:: -- 3. Firestore rules --------------------------------------------
where firebase >nul 2>nul
if errorlevel 1 (
  echo  [rules] firebase CLI not found - skipping. Install with: npm i -g firebase-tools
) else (
  echo  [rules] deploying firestore.rules to miscellaneous-117e9...
  call firebase deploy --only firestore:rules --project miscellaneous-117e9 --non-interactive
  if errorlevel 1 (
    echo  [rules] FAILED. If you are not logged in, run:  firebase login
  ) else (
    echo  [rules] done.
  )
)
echo.

:: -- 4. Cloudflare Worker ------------------------------------------
if not exist "worker\wrangler.toml" (
  echo  [worker] worker\wrangler.toml not found - skipping.
  goto :end
)
pushd worker
if not exist "node_modules\.bin\wrangler.cmd" (
  echo  [worker] installing wrangler ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [worker] npm install FAILED - is Node.js installed?
    popd
    goto :end
  )
)
echo  [worker] deploying ink-worker...
call npx wrangler deploy
if errorlevel 1 (
  echo  [worker] FAILED. If you are not logged in, run:  npx wrangler login
  echo  [worker] Secrets are set once with:  npx wrangler secret put NAME
) else (
  echo  [worker] done.
)
popd
goto :end

:gitfail
echo.
echo  [git] FAILED - see the message above. Nothing else was deployed.

:end
echo.
echo  ----------------------------------------------------
echo   Finished. Press any key to close.
echo  ----------------------------------------------------
pause >nul
