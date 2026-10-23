# Builds everything you'd put on a GitHub release, into dist\release:
#   Sleekmeeter-Setup.exe        installer: installs Voicemeeter first if it's missing, then Sleekmeeter
#   Sleekmeeter-<ver>.msi        the plain MSI (for people who already have Voicemeeter)
#   Sleekmeeter-<ver>-portable.zip   Sleekmeeter.exe + README, no install
# Run from the repo root:  npm run package
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$ver = (Get-Content package.json | ConvertFrom-Json).version
$out = Join-Path $root 'dist\release'
New-Item -ItemType Directory $out -Force | Out-Null
Get-ChildItem $out -Force | ForEach-Object {
    try { Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop }
    catch { throw "Couldn't clear $($_.FullName). Close anything using it (a running Setup.exe, Explorer preview, antivirus scan) and run again." }
}

# Old MSIs from earlier versions pile up in the bundle folder; clear them so only this
# build's MSI can be picked up.
Remove-Item 'src-tauri\target\release\bundle\msi\*.msi' -Force -ErrorAction SilentlyContinue

Write-Host "Building Sleekmeeter $ver (exe and MSI)..."
npx tauri build
if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }

$exe = 'src-tauri\target\release\sleekmeeter.exe'
$msi = Get-ChildItem 'src-tauri\target\release\bundle\msi' -Filter "*_$($ver)_*.msi" | Select-Object -First 1
if (-not $msi) { throw "No MSI for version $ver was produced" }

# Double-check the MSI really is this version before it goes into the installer.
$wi = New-Object -ComObject WindowsInstaller.Installer
$db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @($msi.FullName, 0))
$view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Value FROM Property WHERE Property='ProductVersion'"))
$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
$rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
$msiVer = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1)
$view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($db) | Out-Null
if ($msiVer -ne $ver) { throw "The MSI says version $msiVer but package.json says $ver" }
Write-Host "MSI: $($msi.Name) (version $msiVer)"

Copy-Item $msi.FullName (Join-Path $out "Sleekmeeter-$ver.msi")

Write-Host 'Building the installer that checks for Voicemeeter...'
Copy-Item $msi.FullName 'installer\Sleekmeeter.msi' -Force
rustc --edition 2021 -O installer\setup.rs -o (Join-Path $out 'Sleekmeeter-Setup.exe')
$rc = $LASTEXITCODE
Remove-Item 'installer\Sleekmeeter.msi' -Force
if ($rc -ne 0) { throw 'Could not build the installer' }

Write-Host 'Making the portable zip...'
$tmp = Join-Path $out 'portable'
New-Item -ItemType Directory $tmp | Out-Null
Copy-Item $exe (Join-Path $tmp 'Sleekmeeter.exe')
Copy-Item README.md $tmp
Compress-Archive "$tmp\*" (Join-Path $out "Sleekmeeter-$ver-portable.zip")
Remove-Item $tmp -Recurse -Force

Write-Host "`nDone. Files in $out :"
Get-ChildItem $out | ForEach-Object { '  ' + $_.Name }
