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
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null

Write-Host "Building Sleekmeeter $ver (exe and MSI)..."
npx tauri build
if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }

$exe = 'src-tauri\target\release\sleekmeeter.exe'
$msi = Get-ChildItem 'src-tauri\target\release\bundle\msi' -Filter '*.msi' | Select-Object -First 1
if (-not $msi) { throw 'No MSI was produced' }

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
