<#
.SYNOPSIS
    Install (or -Uninstall) the InkWatch auto-start shortcut in the user's Startup folder; -StartNow launches it.
#>
param([switch]$Uninstall, [switch]$StartNow)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$watchPs1 = Join-Path $scriptDir 'ink-watch.ps1'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'InkWatch.lnk'
Write-Host ""; Write-Host "=== InkWatch installer ===" -ForegroundColor Cyan
if ($Uninstall) {
    if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Write-Host "Removed $shortcut" } else { Write-Host "No Startup shortcut found." }
    Write-Host "If InkWatch is running, right-click its tray icon > Quit."; exit 0
}
if (-not (Test-Path $watchPs1)) { Write-Host "ERROR: $watchPs1 not found" -ForegroundColor Red; exit 1 }
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchPs1`""
$lnk.WorkingDirectory = 'C:\dev\ink'
$lnk.WindowStyle = 7
$lnk.Description = 'InkWatch - deploys Ink when .deploy-tick is bumped'
$lnk.IconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
$lnk.Save()
Write-Host "[OK] Startup shortcut: $shortcut" -ForegroundColor Green
if ($StartNow) {
    Start-Process powershell.exe -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $watchPs1) -WindowStyle Hidden
    Write-Host "[OK] InkWatch launched - look for the green dot with an I in the tray (click ^ to expand hidden icons)." -ForegroundColor Green
}
