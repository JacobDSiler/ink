<#
.SYNOPSIS
    InkWatch - system-tray deployer for C:\dev\ink, driven by a canary file.

.DESCRIPTION
    Sits in the Windows system tray and polls C:\dev\ink\.deploy-tick every 15 seconds.
    When that file's modification time changes (Claude "ticks the canary" after a substantial
    change), InkWatch waits a short settle period and runs scripts\ink-push.ps1:
    commit + push (GitHub Pages), Firestore rules, Cloudflare Worker.

    It deliberately does NOT react to every file save - only to the canary - so half-finished
    edits never go live, and git's own writes never trigger loops.

    TRAY ICON      GREEN idle - YELLOW tick seen, settling - BLUE deploying - RED failed/held - GRAY paused
    RIGHT-CLICK    Deploy now / Pause / Show log / Test canary / Diagnostics / Anomaly report / Open repo / Quit
    DOUBLE-CLICK   Deploy now
    STATE + LOG    %LOCALAPPDATA%\InkWatch\  (state.json, ink-watch.log, anomaly-detected.txt)

    Install the login auto-start with scripts\ink-watch-install.cmd (Startup-folder shortcut, no admin).
    ASCII-only source for PowerShell 5.1.
#>

$RepoRoot     = 'C:\dev\ink'
$DeployScript = Join-Path $RepoRoot 'scripts\ink-push.ps1'
$CanaryPath   = Join-Path $RepoRoot '.deploy-tick'
$PollMs       = 15000
$SettleMs     = 20000    # after a tick: wait for any files still being written (Claude commits several files in a row)
$StateDir     = Join-Path $env:LOCALAPPDATA 'InkWatch'
$StateFile    = Join-Path $StateDir 'state.json'
$LogFile      = Join-Path $StateDir 'ink-watch.log'
$CanaryState  = Join-Path $StateDir 'canary-mtime.txt'
$AnomalyFile  = Join-Path $StateDir 'anomaly-detected.txt'
$AppName      = 'InkWatch'

if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }

# Singleton
$script:Mutex = New-Object System.Threading.Mutex($false, 'Global\InkWatchSingleton')
$acquired = $false
try { $acquired = $script:Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace WinAPI -Name User32 -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    public static extern bool DestroyIcon(System.IntPtr hIcon);
'@

function Write-WatchLog { param([string]$Message, [string]$Level = 'INFO')
    $line = "[{0}] {1} {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile "$LogFile.old" -Force }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch { }
    Write-Host $line
}
Write-WatchLog "InkWatch starting (PID $PID)"

function Load-State {
    if (-not (Test-Path $StateFile)) { return @{ totalDeploys = 0; lastDeployAt = $null; lastResult = $null; lastError = $null; paused = $false; recentDeploys = @() } }
    try { $obj = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json; $ht = @{}; foreach ($p in $obj.PSObject.Properties) { $ht[$p.Name] = $p.Value }; if (-not $ht.recentDeploys) { $ht.recentDeploys = @() }; return $ht }
    catch { return @{ totalDeploys = 0; recentDeploys = @(); paused = $false } }
}
function Save-State { param($State)
    try { if ($State.recentDeploys.Count -gt 20) { $State.recentDeploys = @($State.recentDeploys | Select-Object -Last 20) }; $State | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding UTF8 } catch { }
}
$script:State = Load-State

# -- icons: coloured disc with an "I" ------------------------------------------------------
$script:_icons = @{}
function New-InkIcon { param([string]$Key, [byte]$R, [byte]$G, [byte]$B)
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gfx.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $R, $G, $B))
    $gfx.FillEllipse($brush, 2, 2, 28, 28)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 20, 20, 20)), 2
    $gfx.DrawEllipse($pen, 2, 2, 28, 28)
    $font = New-Object System.Drawing.Font 'Georgia', 17, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $tb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 20, 20))
    $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $gfx.DrawString('I', $font, $tb, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $fmt)
    $gfx.Dispose(); $brush.Dispose(); $pen.Dispose(); $tb.Dispose(); $font.Dispose()
    $h = $bmp.GetHicon(); $icon = [System.Drawing.Icon]::FromHandle($h)
    $script:_icons[$Key] = @{ bitmap = $bmp; icon = $icon; hIcon = $h }
    return $icon
}
try {
    $IconIdle = New-InkIcon 'idle' 50 180 80; $IconTick = New-InkIcon 'tick' 220 180 40
    $IconBusy = New-InkIcon 'busy' 60 130 220; $IconErr = New-InkIcon 'err' 200 60 60; $IconPause = New-InkIcon 'pause' 140 140 140
} catch {
    Write-WatchLog "Custom icons failed ($_); using system icons" 'WARN'
    $IconIdle = [System.Drawing.SystemIcons]::Information; $IconTick = [System.Drawing.SystemIcons]::Warning
    $IconBusy = [System.Drawing.SystemIcons]::Asterisk; $IconErr = [System.Drawing.SystemIcons]::Error; $IconPause = [System.Drawing.SystemIcons]::Shield
}

$Tray = New-Object System.Windows.Forms.NotifyIcon
$Tray.Icon = $IconIdle; $Tray.Text = "$AppName - idle"; $Tray.Visible = $true
function Set-TrayState { param([string]$S, [string]$Tip)
    switch ($S) { 'idle' { $Tray.Icon = $IconIdle } 'tick' { $Tray.Icon = $IconTick } 'busy' { $Tray.Icon = $IconBusy } 'err' { $Tray.Icon = $IconErr } 'pause' { $Tray.Icon = $IconPause } }
    $t = "$AppName - $Tip"; if ($t.Length -gt 60) { $t = $t.Substring(0, 60) + '...' }; $Tray.Text = $t
}
function Show-Balloon { param([string]$Title, [string]$Msg, [string]$Level = 'Info')
    try { $Tray.BalloonTipTitle = $Title; $Tray.BalloonTipText = $Msg
        $Tray.BalloonTipIcon = switch ($Level) { 'Error' { 'Error' } 'Warn' { 'Warning' } default { 'Info' } }
        $Tray.ShowBalloonTip(4500) } catch { }
}

# -- deploy ---------------------------------------------------------------------------------
$script:Busy = $false
function Run-Deploy {
    if ($script:Busy) { Write-WatchLog "Deploy already running - skipped"; return }
    if (-not (Test-Path $DeployScript)) { Set-TrayState 'err' 'ink-push.ps1 missing'; Show-Balloon 'InkWatch' "Missing $DeployScript" 'Error'; return }
    $script:Busy = $true
    Set-TrayState 'busy' 'deploying...'
    $t0 = Get-Date
    Write-WatchLog "Deploy starting"
    try {
        $env:INK_WATCH_AUTO = '1'
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $DeployScript 2>&1 | Out-String
        Remove-Item Env:INK_WATCH_AUTO -ErrorAction SilentlyContinue
        $code = $LASTEXITCODE; $ok = ($code -eq 0 -or $null -eq $code)
        $ms = [int](New-TimeSpan -Start $t0 -End (Get-Date)).TotalMilliseconds
        $commit = ''; try { Push-Location $RepoRoot; $commit = (& git rev-parse --short HEAD 2>$null); Pop-Location } catch { }
        $entry = @{ at = (Get-Date -Format 'o'); commit = $commit; durationMs = $ms; result = $(if ($ok) { 'success' } else { 'error' }) }
        $script:State.recentDeploys = @($script:State.recentDeploys) + $entry
        $script:State.totalDeploys = ([int]$script:State.totalDeploys) + 1
        $script:State.lastDeployAt = $entry.at; $script:State.lastResult = $entry.result
        if ($ok) {
            $script:State.lastError = $null; Save-State $script:State
            if (Test-Path $AnomalyFile) { Remove-Item $AnomalyFile -Force -ErrorAction SilentlyContinue }
            Write-WatchLog "Deploy OK in ${ms}ms (commit $commit)"
            Set-TrayState 'idle' "last deploy OK ($commit)"
            Show-Balloon 'Ink deployed' "Commit $commit is live: site, rules and Worker. ${ms}ms." 'Info'
        } elseif ($code -eq 2) {
            $script:State.lastError = 'held by safety guard'; Save-State $script:State
            Write-WatchLog "Deploy HELD by safety guard" 'WARN'
            Set-TrayState 'err' 'HELD - core file shrank'
            Show-Balloon 'InkWatch held a deploy' 'A core file shrank by more than half. Nothing was pushed. Right-click > Show anomaly report.' 'Warn'
        } else {
            $tail = ($out -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 6) -join "`n"
            $script:State.lastError = $tail; Save-State $script:State
            Write-WatchLog "Deploy FAILED (exit $code):`n$tail" 'ERROR'
            Set-TrayState 'err' 'deploy failed (see log)'
            Show-Balloon 'Ink deploy failed' 'Right-click the tray icon > Show log.' 'Error'
        }
    } catch {
        Write-WatchLog "Deploy exception: $_" 'ERROR'; $script:State.lastError = "$_"; Save-State $script:State
        Set-TrayState 'err' 'deploy exception'; Show-Balloon 'Ink deploy exception' "$_" 'Error'
    } finally { $script:Busy = $false }
}

# -- settle timer: fires the deploy a little after the tick -------------------------------------
$script:Settle = New-Object System.Windows.Forms.Timer
$script:Settle.Interval = $SettleMs
$script:Settle.Add_Tick({ $script:Settle.Stop(); Run-Deploy })
function Trigger-Deploy { param([string]$Why)
    if ($script:State.paused) { Write-WatchLog "Tick ignored - paused ($Why)"; return }
    if ($script:Busy) { Write-WatchLog "Tick during deploy - will run again after ($Why)"; $script:Settle.Stop(); $script:Settle.Start(); return }
    $script:Settle.Stop(); $script:Settle.Start()
    Set-TrayState 'tick' "tick: $Why - deploying in $($SettleMs/1000)s"
    Write-WatchLog "Tick: $Why - settling ${SettleMs}ms"
}

# -- canary poll ----------------------------------------------------------------------------
$script:LastMtime = if (Test-Path $CanaryPath) { (Get-Item $CanaryPath).LastWriteTimeUtc } else { [DateTime]::MinValue }
try {
    if (Test-Path $CanaryState) {
        $prior = [DateTime]::Parse((Get-Content $CanaryState -Raw).Trim(), [System.Globalization.CultureInfo]::InvariantCulture)
        if ($script:LastMtime -gt $prior) { Write-WatchLog "Startup catch-up: canary changed while InkWatch was down"; Start-Sleep -Milliseconds 400; Trigger-Deploy 'startup catch-up' }
    }
} catch { }
$script:LastBeat = [DateTime]::MinValue
$script:Poll = New-Object System.Windows.Forms.Timer
$script:Poll.Interval = $PollMs
$script:Poll.Add_Tick({
    try {
        if (-not (Test-Path $CanaryPath)) { return }
        $m = (Get-Item $CanaryPath).LastWriteTimeUtc
        if (([DateTime]::UtcNow - $script:LastBeat).TotalSeconds -ge 300) { Write-WatchLog "alive - canary $($m.ToString('o'))"; $script:LastBeat = [DateTime]::UtcNow }
        if ($m -gt $script:LastMtime) {
            Write-WatchLog "CANARY CHANGED $($script:LastMtime.ToString('o')) -> $($m.ToString('o'))"
            $script:LastMtime = $m
            try { Set-Content -Path $CanaryState -Value $m.ToString('o') } catch { }
            Trigger-Deploy 'canary'
        }
    } catch { Write-WatchLog "poll error: $($_.Exception.Message)" 'WARN' }
})
$script:Poll.Start()
Write-WatchLog "Polling $CanaryPath every $($PollMs/1000)s"

# -- menu -----------------------------------------------------------------------------------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$mi = $menu.Items.Add('&Deploy now'); $mi.Add_Click({ Write-WatchLog "Manual deploy"; Run-Deploy })
$miPause = $menu.Items.Add('&Pause watching'); $miPause.Add_Click({
    if ($script:State.paused) { $script:State.paused = $false; $miPause.Text = '&Pause watching'; Set-TrayState 'idle' 'watching'; Write-WatchLog "resumed" }
    else { $script:State.paused = $true; $miPause.Text = '&Resume watching'; $script:Settle.Stop(); Set-TrayState 'pause' 'paused'; Write-WatchLog "paused" }
    Save-State $script:State
})
if ($script:State.paused) { $miPause.Text = '&Resume watching'; Set-TrayState 'pause' 'paused' }
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$mi = $menu.Items.Add('Show &log'); $mi.Add_Click({ if (Test-Path $LogFile) { Start-Process notepad.exe -ArgumentList $LogFile } })
$mi = $menu.Items.Add('&Test canary (bump .deploy-tick)'); $mi.Add_Click({
    try { $ts = (Get-Date).ToUniversalTime().ToString('o')
        Set-Content -Path $CanaryPath -Value "# Ink deploy canary`nlast_tick: $ts`nsubject: Manual deploy from InkWatch tray`nbody:" -Encoding UTF8
        Show-Balloon 'InkWatch' 'Canary bumped - deploy within about 35 seconds.' } catch { Show-Balloon 'InkWatch' "Bump failed: $($_.Exception.Message)" 'Error' }
})
$mi = $menu.Items.Add('Show &diagnostics'); $mi.Add_Click({
    $onDisk = if (Test-Path $CanaryPath) { (Get-Item $CanaryPath).LastWriteTimeUtc.ToString('o') } else { 'MISSING' }
    $lines = @("InkWatch diagnostics", "", "Repo:            $RepoRoot", "Canary on disk:  $onDisk", "Last seen:       $($script:LastMtime.ToString('o'))",
        "Paused:          $($script:State.paused)", "Last deploy:     $($script:State.lastDeployAt)", "Last result:     $($script:State.lastResult)", "", "Log: $LogFile", "PID: $PID")
    [System.Windows.Forms.MessageBox]::Show(($lines -join "`r`n"), 'InkWatch', 'OK', 'Information') | Out-Null
})
$mi = $menu.Items.Add('Show &anomaly report'); $mi.Add_Click({ if (Test-Path $AnomalyFile) { Start-Process notepad.exe -ArgumentList $AnomalyFile } else { Show-Balloon 'InkWatch' 'No anomaly on record.' } })
$mi = $menu.Items.Add('&Force deploy (override safety guard)'); $mi.Add_Click({ $env:INK_PUSH_FORCE = '1'; try { Run-Deploy } finally { Remove-Item Env:INK_PUSH_FORCE -ErrorAction SilentlyContinue } })
$mi = $menu.Items.Add('Open &Ink repo'); $mi.Add_Click({ Start-Process explorer.exe $RepoRoot })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$mi = $menu.Items.Add('&Quit InkWatch'); $mi.Add_Click({ $script:Poll.Stop(); $script:Settle.Stop(); $Tray.Visible = $false; $Tray.Dispose(); [System.Windows.Forms.Application]::Exit() })
$Tray.ContextMenuStrip = $menu
$Tray.Add_MouseDoubleClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Run-Deploy } })

if (-not $script:State.paused) { Set-TrayState 'idle' 'watching .deploy-tick' }
Show-Balloon 'InkWatch started' 'Deploys C:\dev\ink whenever .deploy-tick is bumped.'
try { [System.Windows.Forms.Application]::Run() }
finally {
    try { $Tray.Visible = $false; $Tray.Dispose() } catch { }
    foreach ($kv in $script:_icons.GetEnumerator()) { try { $kv.Value.icon.Dispose(); $kv.Value.bitmap.Dispose(); [WinAPI.User32]::DestroyIcon($kv.Value.hIcon) | Out-Null } catch { } }
    try { $script:Mutex.ReleaseMutex(); $script:Mutex.Dispose() } catch { }
    Write-WatchLog "InkWatch exiting"
}
