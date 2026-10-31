$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\com.minimalhandle.sleekmeeter.sdPlugin\bin\media-session.ps1') -FunctionsOnly
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.RandomAccessStreamReference,Windows.Storage.Streams,ContentType=WindowsRuntime]
$bitmap=[System.Drawing.Bitmap]::new(180,120)
$g=[System.Drawing.Graphics]::FromImage($bitmap);$g.Clear([System.Drawing.Color]::CornflowerBlue)
$png=[System.IO.MemoryStream]::new();$bitmap.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
$stream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
$writer=[Windows.Storage.Streams.DataWriter]::new($stream)
$writer.WriteBytes($png.ToArray());$null=Await-Operation ($writer.StoreAsync()) ([uint32]);$null=$writer.DetachStream();$stream.Seek(0)
$properties=[pscustomobject]@{Title='Artwork test';Artist='Local test';AlbumTitle='Test';Thumbnail=[Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromStream($stream)}
Write-Output "Source stream size: $($stream.Size); thumbnail present: $([bool]$properties.Thumbnail)"
$art=Read-Art $properties 'test'
if(-not $art.StartsWith('data:image/png;base64,')){throw "WinRT thumbnail conversion failed: $script:artError"}
$decoded=[System.IO.MemoryStream]::new([Convert]::FromBase64String($art.Substring(22)))
$result=[System.Drawing.Image]::FromStream($decoded)
if($result.Width -ne 96 -or $result.Height -ne 96){throw 'Thumbnail must be 96x96'}
if((Read-Art $properties 'test') -ne $art){throw 'Artwork cache did not return the same image'}
Write-Output 'PASS: WinRT thumbnail stream decoded, cropped to 96x96, encoded and cached.'
foreach($item in @($result,$decoded,$writer,$stream,$png,$g,$bitmap)){Close-Resource $item}
