$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# Zip entries use forward slashes and keep the source folder as the top level.
function New-Package($source, $destination) {
    # Use a unique intermediate filename so a failed build keeps the previous installer.
    $temporary = Join-Path $PSScriptRoot ('package-' + [guid]::NewGuid().ToString('N') + '.zip')
    $parent = Split-Path -Parent $source
    $zip = [IO.Compression.ZipFile]::Open($temporary, 'Create')
    try {
        foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
            $entry = $file.FullName.Substring($parent.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry)
        }
    } finally {
        $zip.Dispose()
    }
    Move-Item -LiteralPath $temporary -Destination $destination -Force
}

$pluginDirectory = Join-Path $PSScriptRoot 'com.minimalhandle.sleekmeeter.sdPlugin'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $pluginDirectory 'manifest.json') | ConvertFrom-Json
if ($manifest.UUID -ne 'com.minimalhandle.sleekmeeter' -or $manifest.Actions.Count -ne 20) {
    throw 'Unexpected plugin identity or action count; refusing to package.'
}
foreach ($requiredFile in @('bin\plugin.js', 'bin\ws.js', 'bin\studio.js', 'bin\media-session.js', 'bin\media-session.ps1', 'bin\symbols.json', 'ui\pi.html', 'layouts\channel.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDirectory $requiredFile))) { throw "Missing $requiredFile" }
}
New-Package $pluginDirectory (Join-Path $PSScriptRoot 'Sleekmeeter-Studio.streamDeckPlugin')
Write-Output "Packaged Sleekmeeter-Studio.streamDeckPlugin (version $($manifest.Version))"

$iconDirectory = Join-Path $PSScriptRoot 'icons\com.minimalhandle.studio.apps.sdIconPack'
$iconManifest = Get-Content -Raw -LiteralPath (Join-Path $iconDirectory 'manifest.json') | ConvertFrom-Json
$iconCount = (Get-ChildItem -LiteralPath (Join-Path $iconDirectory 'icons') -File).Count
if ($iconCount -ne 486) { throw "Expected 486 icons, found $iconCount; refusing to package." }
New-Package $iconDirectory (Join-Path $PSScriptRoot 'Sleekmeeter-Studio-Icons.streamDeckIconPack')
Write-Output "Packaged Sleekmeeter-Studio-Icons.streamDeckIconPack (version $($iconManifest.Version), $iconCount icons)"
