$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$directory = Join-Path $PSScriptRoot 'com.minimalhandle.sleekmeeter.sdPlugin'
$plugin = Get-Content -Raw -LiteralPath (Join-Path $directory 'manifest.json') | ConvertFrom-Json
$folder = Join-Path $directory 'profiles'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$model = '20GBD9901' # Stream Deck +
$profile = '027e1dc1-0c14-4c5d-89e2-1d668ba1738a'
$page = '51bdad73-8a11-4ff7-8f0c-2c66b70e8cb6'
$profilePath = "Profiles/$($profile.ToUpperInvariant()).sdProfile"
$name = 'Sleekmeeter Studio Plus'

function Action($id, $settings, $slot) {
    $uuid = "$($plugin.UUID).$id"
    $action = $plugin.Actions | Where-Object UUID -eq $uuid | Select-Object -First 1
    if (-not $action) { throw "Unknown action $uuid" }
    @{
        ActionID = "3f21b86c-5f8d-4590-a02d-$('{0:D12}' -f $slot)"
        LinkedTitle = $true; Name = $action.Name; UUID = $uuid; State = 0
        Plugin = @{ Name = $plugin.Name; UUID = $plugin.UUID; Version = $plugin.Version }
        Settings = $settings; States = @(@{}); Resources = $null
    }
}

$dials = [ordered]@{}
$keys = [ordered]@{}
$roles = @('mic', 'game', 'chat', 'music')
for ($i = 0; $i -lt $roles.Count; $i++) {
    $dials["$i,0"] = Action 'channel' @{ channelRole = $roles[$i]; press = 'mute'; tap = 'mute' } ($i + 1)
    $keys["$i,0"] = Action 'mute' @{ channelRole = $roles[$i] } ($i + 5)
}
$keys['0,1'] = Action 'scene' @{ sceneRole = 'gaming' } 9
$keys['1,1'] = Action 'scene' @{ sceneRole = 'streaming' } 10
$keys['2,1'] = Action 'brb' @{} 11
$keys['3,1'] = Action 'output' @{ profile = '' } 12

$archive = Join-Path $folder "$name.streamDeckProfile"
$temporary = Join-Path $folder ("profile-" + [guid]::NewGuid().ToString('N') + ".zip")
$zip = [IO.Compression.ZipFile]::Open($temporary, 'Create')
function Write-Entry($path, $data) {
    $entry = $zip.CreateEntry($path)
    $entry.LastWriteTime = [DateTimeOffset]::new(2026, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write(($data | ConvertTo-Json -Depth 12 -Compress)) } finally { $writer.Dispose() }
}
try {
    Write-Entry 'package.json' @{
        AppVersion = '7.0.0'; DeviceModel = $model; DeviceSettings = $null
        FormatVersion = 1; OSType = 'Windows'; OSVersion = '10.0'; RequiredPlugins = @($plugin.UUID)
    }
    Write-Entry "$profilePath/manifest.json" @{
        Name = $name; Version = '3.0'; Device = @{ Model = $model; UUID = $profile }
        Pages = @{ Current = '00000000-0000-0000-0000-000000000000'; Default = $page; Pages = @($page) }
    }
    Write-Entry "$profilePath/Profiles/$($page.ToUpperInvariant())/manifest.json" @{
        Controllers = @(@{ Type = 'Keypad'; Actions = $keys }, @{ Type = 'Encoder'; Actions = $dials })
    }
} finally { $zip.Dispose() }
Move-Item -LiteralPath $temporary -Destination $archive -Force
