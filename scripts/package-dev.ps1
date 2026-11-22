# Build and package a portable local test build into dist\dev. This script has no publishing step.
# Run from the repo root:  npm run package:dev
# The build is stamped <version>-dev (for example 0.22.0-beta.1-dev) so it can't be mistaken
# for an official release, and so the in-app updater sees the published version as newer and
# moves it on once that's out. The version files are put back afterwards.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
$base = (Get-Content -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
if ($base -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "package.json has an unexpected version: $base" }
$ver = if ($base.EndsWith('-dev')) { $base } else { "$base-dev" }

# Stamp the -dev version into every place the build reads it from, then restore them.
$stamped = @{
    'package.json'              = '("version":\s*")[^"]+(")'
    'src-tauri\tauri.conf.json' = '("version":\s*")[^"]+(")'
    'src-tauri\Cargo.toml'      = '(?m)(^version\s*=\s*")[^"]+(")'
    'src-tauri\Cargo.lock'      = '(name = "sleekmeeter"\r?\nversion = ")[^"]+(")'
}
$saved = @{}
foreach ($f in $stamped.Keys) {
    $path = Join-Path $root $f
    $saved[$path] = [IO.File]::ReadAllBytes($path)
    $text = [IO.File]::ReadAllText($path)
    $new = [regex]::new($stamped[$f]).Replace($text, "`${1}$ver`${2}", 1)
    if ($new -eq $text -and -not $text.Contains($ver)) { throw "Couldn't stamp the version in $f" }
    [IO.File]::WriteAllText($path, $new, [Text.UTF8Encoding]::new($false))
}
try {
    # Only the per-user installer: the MSI format can't carry a version like 0.22.0-beta.1-dev.
    Remove-Item (Join-Path $root 'src-tauri\target\release\bundle\nsis\*.exe') -Force -ErrorAction SilentlyContinue
    & (Join-Path $root 'node_modules\.bin\tauri.cmd') build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'The local build failed.' }
} finally {
    foreach ($path in $saved.Keys) { [IO.File]::WriteAllBytes($path, $saved[$path]) }
}

$out = Join-Path $root 'dist\dev'
New-Item -ItemType Directory -Path $out -Force | Out-Null
Get-ChildItem $out -Force | Remove-Item -Recurse -Force   # only the newest dev build is kept

# The installer: per-user, no administrator rights, and the in-app updater can move it on.
$nsis = Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter "*_$($ver)_*-setup.exe" | Select-Object -First 1
if (-not $nsis) { throw "No setup for version $ver was produced" }
$setup = Join-Path $out "Sleekmeeter-$ver-setup.exe"
Copy-Item -LiteralPath $nsis.FullName -Destination $setup

$portable = Join-Path $out "Sleekmeeter-$ver-portable"
New-Item -ItemType Directory -Path $portable -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'src-tauri\target\release\sleekmeeter.exe') -Destination (Join-Path $portable 'Sleekmeeter.exe') -Force
Copy-Item -LiteralPath (Join-Path $root 'docs\dev-build-readme.md') -Destination (Join-Path $portable 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'docs\third-party\nnnoiseless.txt') -Destination (Join-Path $portable 'THIRD-PARTY-NOTICES.txt') -Force
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $portable 'LICENSE.txt') -Force

# Include only distribution files, never settings or recordings from a prior test run.
$files = @('Sleekmeeter.exe', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'LICENSE.txt') | ForEach-Object { Join-Path $portable $_ }
$zip = Join-Path $out "Sleekmeeter-$ver-portable.zip"
Compress-Archive -LiteralPath $files -DestinationPath $zip -Force
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zip.sha256" -Value "$hash  $(Split-Path $zip -Leaf)" -Encoding ascii
Remove-Item -LiteralPath $portable -Recurse -Force
Write-Host "Local test build ($ver)"
Write-Host "Setup: $setup"
Write-Host "Portable zip: $zip"
Write-Host "SHA256 (zip): $hash"
