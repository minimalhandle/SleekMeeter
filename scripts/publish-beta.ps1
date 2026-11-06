# Publishes the build in dist\release as a test version (beta) to minimalhandle/SleekMeeter-beta.
# Only copies of Sleekmeeter with Settings -> Updates -> "Also offer test versions" turned on look
# there, so nobody else is offered it. The release notes are the top section of CHANGELOG.md.
# Run from the repo root after `npm run package`:  powershell -File scripts\publish-beta.ps1
# Not 'Stop': in Windows PowerShell, anything gh or git writes to stderr (even progress) would
# then end the script. Each step checks $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$repo = 'minimalhandle/SleekMeeter-beta'
$ver = (Get-Content package.json | ConvertFrom-Json).version
$files = @("Sleekmeeter-$ver-setup.exe", "Sleekmeeter-$ver.msi", "Sleekmeeter-$ver-portable.zip") | ForEach-Object { Join-Path 'dist\release' $_ }
foreach ($f in $files) { if (-not (Test-Path $f)) { throw "Missing $f. Run npm run package first." } }
$files += 'streamdeck\Sleekmeeter-Studio.streamDeckPlugin'

# The beta repo needs one commit before it can hold releases: create it the first time.
# It's public so Sleekmeeter can download from it without signing in.
gh repo view $repo --json name 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating $repo..."
    $seed = Join-Path ([IO.Path]::GetTempPath()) ('sleekmeeter-beta-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $seed -ErrorAction Stop | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'beta-README.md') (Join-Path $seed 'README.md') -ErrorAction Stop
    git -C $seed init -q -b main
    git -C $seed add README.md
    # Same author as this repo's commits: the identity may be set only for this repo, not globally.
    $name = git -C $root config user.name
    $email = git -C $root config user.email
    git -C $seed -c "user.name=$name" -c "user.email=$email" commit -q -m 'Sleekmeeter test versions'
    if ($LASTEXITCODE -ne 0) { throw "Couldn't prepare the first commit for $repo" }
    gh repo create $repo --public --description 'Test versions (betas) of Sleekmeeter. Only for people who want to test new features early.' --source $seed --push
    if ($LASTEXITCODE -ne 0) { throw "Couldn't create $repo" }
}

# Notes: the top section of the changelog, with how to install it the first time.
$log = (Get-Content CHANGELOG.md -Raw -Encoding UTF8) -replace "`r`n", "`n"
$top = [regex]::Match($log, '(?s)\n## [^\n]*\n(.*?)(?=\n## |\z)').Groups[1].Value.Trim()
# Windows PowerShell reads this file as ANSI, so the arrow is written by its code.
$arrow = [char]0x2192
$body = "**Test version.** Only for people who turned on **Settings $arrow Updates $arrow Also offer test versions**. It may have more bugs than a full release.`n`n$top`n`n**Installing it the first time:** run ``Sleekmeeter-$ver-setup.exe`` below; your settings are kept. After that, test versions arrive through the update button."
$notesFile = Join-Path ([IO.Path]::GetTempPath()) "sleekmeeter-beta-notes-$ver.md"
[IO.File]::WriteAllText($notesFile, $body, (New-Object Text.UTF8Encoding $false))

gh release create "v$ver" --repo $repo --title "Sleekmeeter $ver (test version)" --target main --notes-file $notesFile @files
if ($LASTEXITCODE -ne 0) { throw 'Publishing the test version failed' }
Write-Host "Published test version ${ver}: https://github.com/$repo/releases/tag/v$ver"
