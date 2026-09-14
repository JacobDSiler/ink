<#
.SYNOPSIS
    Ink push - commit + push the repo, deploy Firestore rules and the Cloudflare Worker.

.DESCRIPTION
    Run from anywhere: it finds C:\dev\ink (or the repo this script lives in).
      1. Reads the commit message from .deploy-tick (subject:/body: lines) or COMMIT_MESSAGE.txt.
      2. Safety guard: refuses to deploy if a core file shrank by more than half (a sign that a
         truncated write landed). Set INK_PUSH_FORCE=1 or pass -Force to override.
      3. git add -A / commit / push origin main   (GitHub Pages republishes ink.jacobsiler.com)
      4. firebase deploy --only firestore:rules    (shared rules file: Boxes + Folio + Ink)
      5. npx wrangler deploy in worker\            (retries once; Cloudflare API hiccups are common)

    Interactive by default (holds the window open). InkWatch runs it with INK_WATCH_AUTO=1, which
    skips the prompts. ASCII-only so PowerShell 5.1 does not choke on encoding.
#>
param([switch]$Force)

$script:AutoRun = ($env:INK_WATCH_AUTO -eq '1')
$HOLD_OPEN = -not $script:AutoRun
$ForceDeploy = $Force -or ($env:INK_PUSH_FORCE -eq '1')

function Stop-Here([int]$code = 0) {
    if ($HOLD_OPEN) { Write-Host ""; Write-Host "Press Enter to close..." -ForegroundColor DarkGray; Read-Host | Out-Null }
    exit $code
}
function Step([string]$s) { Write-Host ""; Write-Host "-- $s" -ForegroundColor Cyan }

try {
    $ErrorActionPreference = 'Stop'
    Write-Host ""; Write-Host "=== Ink push ===" -ForegroundColor Cyan

    # -- repo root --------------------------------------------------------
    $repoRoot = 'C:\dev\ink'
    $here = Split-Path -Parent $MyInvocation.MyCommand.Definition
    if (Test-Path (Join-Path (Split-Path -Parent $here) '.git')) { $repoRoot = Split-Path -Parent $here }
    if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Write-Host "Not a git repo: $repoRoot" -ForegroundColor Red; Stop-Here 1 }
    Set-Location $repoRoot
    Write-Host "Repo: $repoRoot"

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "git is not on PATH." -ForegroundColor Red; Stop-Here 1 }

    # -- commit message ---------------------------------------------------
    $subject = $null; $bodyLines = @()
    $tick = Join-Path $repoRoot '.deploy-tick'
    if (Test-Path $tick) {
        $inBody = $false
        foreach ($line in (Get-Content $tick -Encoding UTF8)) {
            if ($line -match '^subject:\s*(.+)$') { $subject = $Matches[1].Trim(); $inBody = $false; continue }
            if ($line -match '^body:\s*(.*)$') { $inBody = $true; if ($Matches[1].Trim()) { $bodyLines += $Matches[1].Trim() }; continue }
            if ($inBody -and $line -notmatch '^\s*#' -and $line -notmatch '^(last_tick|subject):') { $bodyLines += $line }
        }
    }
    if (-not $subject -and (Test-Path 'COMMIT_MESSAGE.txt')) {
        $all = Get-Content 'COMMIT_MESSAGE.txt' -Encoding UTF8 | Where-Object { $_.Trim() }
        if ($all) { $subject = $all[0].Trim(); $bodyLines = @($all | Select-Object -Skip 1) }
    }
    if (-not $subject) { $subject = "Ink update " + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
    $msgFile = Join-Path $env:TEMP 'ink-commit-msg.txt'
    $msg = $subject
    $trimmed = @($bodyLines | ForEach-Object { $_.TrimEnd() })
    while ($trimmed.Count -and -not $trimmed[-1]) { $trimmed = @($trimmed | Select-Object -First ($trimmed.Count - 1)) }
    if ($trimmed.Count) { $msg += "`n`n" + ($trimmed -join "`n") }
    [System.IO.File]::WriteAllText($msgFile, $msg + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Commit: $subject"

    # -- safety guard: a core file that shrank by > 50% is almost certainly a truncated write --
    Step "safety check"
    $core = @('index.html', 'worker\src\index.js', 'shared\render.js', 'shared\templates.js', 'firestore.rules')
    $suspicious = @()
    foreach ($f in $core) {
        if (-not (Test-Path $f)) { continue }
        $headSize = 0
        try { $blob = & git cat-file -s ("HEAD:" + ($f -replace '\\', '/')) 2>$null; if ($blob) { $headSize = [int]$blob } } catch {}
        $nowSize = (Get-Item $f).Length
        if ($headSize -gt 2000 -and $nowSize -lt ($headSize * 0.5)) { $suspicious += ("{0}: {1} -> {2} bytes" -f $f, $headSize, $nowSize) }
    }
    if ($suspicious.Count -and -not $ForceDeploy) {
        Write-Host "DEPLOY HELD - core files shrank by more than half:" -ForegroundColor Yellow
        $suspicious | ForEach-Object { Write-Host "   $_" -ForegroundColor Yellow }
        Write-Host "If this is intentional, run again with -Force (or set INK_PUSH_FORCE=1)." -ForegroundColor Yellow
        $stateDir = Join-Path $env:LOCALAPPDATA 'InkWatch'; if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
        Set-Content -Path (Join-Path $stateDir 'anomaly-detected.txt') -Value (@("Held at " + (Get-Date -Format 'o')) + $suspicious) -Encoding UTF8
        Stop-Here 2
    }
    Write-Host "ok"

    # -- git --------------------------------------------------------------
    Step "git add / commit / push"
    & git add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }
    & git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        & git commit -F $msgFile | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
    } else { Write-Host "nothing new to commit - pushing anyway" }
    & git push origin main | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    Write-Host "pushed. GitHub Pages republishes ink.jacobsiler.com in about a minute."

    # -- firestore rules --------------------------------------------------
    Step "firestore rules"
    if (Get-Command firebase -ErrorAction SilentlyContinue) {
        & firebase deploy --only firestore:rules --project miscellaneous-117e9 --non-interactive | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "firebase rules deploy failed (run: firebase login)" }
    } else { Write-Host "firebase CLI not found - skipped (npm i -g firebase-tools)" -ForegroundColor Yellow }

    # -- worker -----------------------------------------------------------
    Step "cloudflare worker"
    if (Test-Path 'worker\wrangler.toml') {
        Push-Location 'worker'
        try {
            & npm install --no-audit --no-fund --loglevel=error | Out-Host
            & npx wrangler deploy | Out-Host
            if ($LASTEXITCODE -ne 0) {
                Write-Host "first attempt failed - retrying in 5s" -ForegroundColor Yellow
                Start-Sleep -Seconds 5
                & npx wrangler deploy | Out-Host
                if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed (run: npx wrangler login)" }
            }
        } finally { Pop-Location }
    } else { Write-Host "worker\wrangler.toml not found - skipped" -ForegroundColor Yellow }

    Write-Host ""; Write-Host "=== Ink push complete ===" -ForegroundColor Green
    Stop-Here 0
} catch {
    Write-Host ""; Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Stop-Here 1
}
