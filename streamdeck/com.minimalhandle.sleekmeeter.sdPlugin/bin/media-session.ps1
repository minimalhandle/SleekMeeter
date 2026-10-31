param([switch]$Once, [switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Operation($Operation, [Type]$ResultType) {
    $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(5000)) { throw 'Windows media request timed out' }
    return $task.GetAwaiter().GetResult()
}
$script:artCache = @{}
function Close-Resource($Resource) {
    if ($Resource -is [IDisposable]) { try { $null=[IDisposable].GetMethod('Dispose').Invoke($Resource,@()) } catch { } }
}
function Read-Art($Properties, [string]$Source) {
    $identity = "$($Properties.Title)|$($Properties.Artist)|$($Properties.AlbumTitle)"
    if ($script:artCache.ContainsKey($Source) -and $script:artCache[$Source].identity -eq $identity) { return $script:artCache[$Source].art }
    $art = ''
    if ($Properties.Thumbnail) {
        $stream = $null; $reader = $null; $memory = $null; $image = $null; $bitmap = $null; $graphics = $null; $output = $null
        try {
            $stream = Await-Operation ($Properties.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            # PowerShell does not expose inherited WinRT interface members on this COM result.
            $randomAccessType = [Windows.Storage.Streams.IRandomAccessStream]
            $size = $randomAccessType.GetProperty('Size').GetValue($stream)
            if ($size -gt 0 -and $size -le 5242880) {
                $inputStream = $randomAccessType.GetMethod('GetInputStreamAt').Invoke($stream,@([uint64]0))
                $reader = [Windows.Storage.Streams.DataReader]::new($inputStream)
                $loaded = Await-Operation ($reader.LoadAsync([uint32]$size)) ([uint32])
                $bytes = [byte[]]::new($loaded); $reader.ReadBytes($bytes)
                $memory = [System.IO.MemoryStream]::new($bytes, $false)
                $image = [System.Drawing.Image]::FromStream($memory)
                $bitmap = [System.Drawing.Bitmap]::new(96,96)
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $side = [Math]::Min($image.Width,$image.Height)
                $graphics.DrawImage($image,[System.Drawing.Rectangle]::new(0,0,96,96),[int](($image.Width-$side)/2),[int](($image.Height-$side)/2),$side,$side,[System.Drawing.GraphicsUnit]::Pixel)
                $output = [System.IO.MemoryStream]::new()
                $bitmap.Save($output,[System.Drawing.Imaging.ImageFormat]::Png)
                $art = 'data:image/png;base64,' + [Convert]::ToBase64String($output.ToArray())
            }
        } catch { $script:artError = $_.Exception.Message; $art = '' }
        finally { foreach ($resource in @($graphics,$bitmap,$image,$memory,$output,$reader,$stream)) { Close-Resource $resource } }
    }
    $script:artCache[$Source] = @{ identity=$identity; art=$art }
    return $art
}
function Snapshot($Session, [string]$Source) {
    if (-not $Session) { return @{ available=$false; source=$Source; reason='No media session' } }
    try {
        $properties = Await-Operation ($Session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $timeline = $Session.GetTimelineProperties(); $playback = $Session.GetPlaybackInfo()
        $duration = [Math]::Max(0,($timeline.EndTime-$timeline.StartTime).TotalSeconds)
        $position = [Math]::Max(0,($timeline.Position-$timeline.StartTime).TotalSeconds)
        $playing = $playback.PlaybackStatus.ToString() -eq 'Playing'
        if ($playing) { $position += [Math]::Max(0,([DateTimeOffset]::UtcNow-$timeline.LastUpdatedTime).TotalSeconds) * $(if ($playback.PlaybackRate) { [double]$playback.PlaybackRate } else { 1 }) }
        if ($duration -gt 0) { $position=[Math]::Min($duration,$position) }
        return @{ available=$true; source=$Session.SourceAppUserModelId; title=[string]$properties.Title; artist=[string]$properties.Artist; album=[string]$properties.AlbumTitle; playing=$playing; position=$position; duration=$duration; capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); art=(Read-Art $properties $Source) }
    } catch { return @{ available=$false; source=$Source; reason='Media information unavailable' } }
}
if ($FunctionsOnly) { return }
try {
    $manager = Await-Operation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    # Console.In is a synchronized reader: ReadLineAsync can block before returning.
    # Keep blocking stdin reads on a managed background thread, away from media polling.
    if (-not $Once) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;
public static class SleekMediaInbox {
    private static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent Arrived = new AutoResetEvent(false);
    public static volatile bool Closed;
    public static void Start() {
        var thread = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line.Length <= 256 && Lines.Count < 32) { Lines.Enqueue(line); Arrived.Set(); }
                }
            } catch { } finally { Closed = true; Arrived.Set(); }
        });
        thread.IsBackground = true;
        thread.Start();
    }
    public static void Wait(int milliseconds) { Arrived.WaitOne(milliseconds); }
    public static string Next() {
        string line;
        return Lines.TryDequeue(out line) ? line : null;
    }
}
'@
        [SleekMediaInbox]::Start()
    }
    $quickChecks = 0
    while ($true) {
        $spotify = @($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'spotify' }) | Select-Object -First 1
        $current = $manager.GetCurrentSession()
        if (-not $Once -and [SleekMediaInbox]::Closed) { break }
        $line = if (-not $Once) { [SleekMediaInbox]::Next() } else { $null }
        if ($null -ne $line) {
            $quickChecks = 3
            try {
                $command = $line | ConvertFrom-Json
                $session = if ($command.source -eq 'auto') { $current } else { $spotify }
                if ($session) {
                    switch ($command.command) {
                        'playpause' { $null=Await-Operation ($session.TryTogglePlayPauseAsync()) ([bool]) }
                        'next' { $null=Await-Operation ($session.TrySkipNextAsync()) ([bool]) }
                        'previous' { $null=Await-Operation ($session.TrySkipPreviousAsync()) ([bool]) }
                    }
                }
            } catch { }
        }
        $spotifyState = Snapshot $spotify 'spotify'
        $currentState = if ($current -and $spotify -and $current.SourceAppUserModelId -eq $spotify.SourceAppUserModelId) { $spotifyState } else { Snapshot $current 'auto' }
        [Console]::WriteLine((@{ players=@{ spotify=$spotifyState; auto=$currentState } } | ConvertTo-Json -Depth 5 -Compress))
        if ($Once) { break }
        # A key press ends the wait at once. Players take a moment to report a change, so look again soon after one.
        $wait = 750
        if ($quickChecks -gt 0) { $quickChecks--; $wait = 150 }
        [SleekMediaInbox]::Wait($wait)
    }
} catch {
    if ($Once) { [Console]::Error.WriteLine($_.Exception.Message) }
    [Console]::WriteLine((@{ players=@{ spotify=@{available=$false;reason='Windows media service unavailable'};auto=@{available=$false;reason='Windows media service unavailable'} } } | ConvertTo-Json -Depth 5 -Compress))
    exit 1
}
