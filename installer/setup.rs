//! Sleekmeeter-Setup.exe: installs Voicemeeter first if it's missing, then Sleekmeeter.
//!
//! Voicemeeter is never bundled. If it's missing, the official installer is downloaded from
//! vb-audio.com (with a progress window) and run by the user (it needs administrator rights
//! for its audio drivers). Then Sleekmeeter's per-user setup (embedded in this exe) runs as a
//! normal installer window; Sleekmeeter itself needs no administrator rights. The only other
//! prompt is removing an older all-users (Program Files) copy. Standard library only, no
//! console window: questions are Windows message boxes.

#![windows_subsystem = "windows"]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

static SETUP: &[u8] = include_bytes!("Sleekmeeter-user-setup.exe");

const KEY: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
const PAGE: &str = "https://vb-audio.com/Voicemeeter/banana.htm";
const TITLE: &str = "Sleekmeeter setup";
/// Run console tools (reg, powershell) without flashing a window.
const NO_WINDOW: u32 = 0x0800_0000;

/// Downloads and starts VB-Audio's installer, waiting until it closes, with a small progress
/// window. Exit code 0 on success.
const FETCH: &str = r#"
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object Windows.Forms.Form
$f.Text = 'Sleekmeeter setup'
$f.ClientSize = New-Object Drawing.Size(420, 110)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ControlBox = $false
$f.TopMost = $true
$l = New-Object Windows.Forms.Label
$l.Location = New-Object Drawing.Point(20, 18)
$l.Size = New-Object Drawing.Size(380, 36)
$l.Text = 'Getting Voicemeeter...'
$bar = New-Object Windows.Forms.ProgressBar
$bar.Location = New-Object Drawing.Point(20, 62)
$bar.Size = New-Object Drawing.Size(380, 22)
$f.Controls.Add($l)
$f.Controls.Add($bar)
$f.Show()
function Pump { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }
function Say($t) { $l.Text = $t; Pump }
try {
  $base = 'https://download.vb-audio.com/Download_CABLE/'
  $name = 'VoicemeeterSetup_v2130.zip'
  $bar.Style = 'Marquee'
  Say 'Looking for the current version...'
  try {
    $wc = New-Object Net.WebClient
    $html = $wc.DownloadString('https://vb-audio.com/Voicemeeter/banana.htm')
    if ($html -match 'VoicemeeterSetup_v\d+\.zip') { $name = $Matches[0] }
  } catch { }
  $dir = Join-Path $env:TEMP 'Sleekmeeter-Voicemeeter'
  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $dir | Out-Null
  $zip = Join-Path $dir $name
  $bar.Style = 'Continuous'
  Say 'Downloading Voicemeeter from vb-audio.com...'
  $wc = New-Object Net.WebClient
  $script:done = $false
  $script:err = $null
  $wc.add_DownloadProgressChanged({ param($s, $e) $bar.Value = $e.ProgressPercentage })
  $wc.add_DownloadFileCompleted({ param($s, $e) $script:done = $true; $script:err = $e.Error })
  $wc.DownloadFileAsync([Uri]($base + $name), $zip)
  while (-not $script:done) { Pump }
  if ($script:err) { throw $script:err }
  Say 'Unpacking...'
  $bar.Style = 'Marquee'
  Expand-Archive $zip -DestinationPath $dir -Force
  $exe = Get-ChildItem $dir -Recurse -Filter 'VoicemeeterSetup*.exe' | Where-Object { $_.Name -notmatch 'ARM' } | Select-Object -First 1
  if (-not $exe) { throw 'The download did not contain an installer' }
  Say "VB-Audio's installer is open. Click Install in it and say yes to the Windows prompt."
  $p = Start-Process $exe.FullName -Verb RunAs -PassThru
  while (-not $p.HasExited) { Pump }
} finally {
  $f.Close()
}
exit 0
"#;

/// Runs elevated (one Windows prompt). Removes an older system-wide (Program Files) Sleekmeeter
/// so it doesn't sit next to the new per-user one. Settings live in %APPDATA% and are kept.
const REMOVE_OLD: &str = r#"
$roots = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
foreach ($k in $roots) {
  if (Test-Path $k) {
    Get-ChildItem $k | ForEach-Object {
      $n = $_.PSChildName
      $d = (Get-ItemProperty $_.PSPath).DisplayName
      if ($d -eq 'Sleekmeeter' -and $n -match '^\{[0-9A-Fa-f-]+\}$') {
        Start-Process msiexec -Wait -ArgumentList ('/x ' + $n + ' /qb /norestart')
      }
    }
  }
}
"#;

/// Starts REMOVE_OLD elevated and hidden; 1602 (cancelled) if the Windows prompt is declined.
const ELEVATE: &str = r#"
try {
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '__INNER__')
  exit $p.ExitCode
} catch { exit 1602 }
"#;

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

fn message(text: &str, kind: u32) -> i32 {
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let (t, c) = (wide(text), wide(TITLE));
    // MB_SETFOREGROUND so the box isn't hidden behind other windows.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            t.as_ptr(),
            c.as_ptr(),
            kind | 0x0001_0000,
        )
    }
}
fn ask(question: &str) -> bool {
    message(question, 0x04 | 0x20) == 6 // MB_YESNO | MB_ICONQUESTION -> IDYES
}
fn info(text: &str) {
    message(text, 0x40);
}
fn warn(text: &str) {
    message(text, 0x30);
}

fn hidden(program: &str) -> Command {
    let mut c = Command::new(program);
    c.creation_flags(NO_WINDOW);
    c
}

/// Writes a PowerShell script to TEMP, runs it hidden and returns its exit code.
fn run_script(name: &str, body: &str) -> Option<i32> {
    let path: PathBuf = std::env::temp_dir().join(name);
    std::fs::write(&path, body).ok()?;
    let code = hidden("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .status()
        .ok()
        .and_then(|s| s.code());
    let _ = std::fs::remove_file(&path);
    code
}

fn ps_quote(p: &std::path::Path) -> String {
    p.display().to_string().replace('\'', "''")
}

fn voicemeeter_installed() -> bool {
    ["/reg:64", "/reg:32"].iter().any(|view| {
        hidden("reg")
            .args(["query", KEY, "/v", "UninstallString", view])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

fn old_system_copy() -> bool {
    let base = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    PathBuf::from(base)
        .join("Sleekmeeter")
        .join("Sleekmeeter.exe")
        .exists()
}

fn main() {
    let mut reboot = false;
    if !voicemeeter_installed() {
        if ask(
            "Sleekmeeter needs Voicemeeter (Banana or Potato), a free mixer made by VB-Audio, \
             and it isn't installed.\n\nDownload and install it now?\n\nA progress window \
             shows the download, then VB-Audio's own installer opens. Voicemeeter installs audio \
             drivers, so that part asks for Windows' permission.",
        ) {
            if run_script("sleekmeeter-get-voicemeeter.ps1", FETCH) == Some(0)
                && voicemeeter_installed()
            {
                reboot = true;
            } else {
                let _ = hidden("cmd").args(["/c", "start", "", PAGE]).status();
                if !ask(&format!(
                    "Voicemeeter didn't install. You can get it yourself from {PAGE} \
                     (opened in your browser).\n\nInstall Sleekmeeter anyway?"
                )) {
                    return;
                }
            }
        } else if !ask("Install Sleekmeeter without Voicemeeter? It won't do anything until Voicemeeter is installed.") {
            return;
        }
    }

    let dir = std::env::temp_dir();

    // An older version installed for all users (Program Files) needs administrator rights to
    // remove. Sleekmeeter itself doesn't, so this is the only time we ask.
    if old_system_copy()
        && ask(
            "An older all-users copy of Sleekmeeter is installed. This version installs just for \
             you and needs no administrator rights, so the old copy should be removed first \
             (your settings are kept).\n\nRemove it now? Windows will ask for permission once.",
        )
    {
        let inner = dir.join("sleekmeeter-remove-old.ps1");
        if std::fs::write(&inner, REMOVE_OLD).is_ok() {
            run_script(
                "sleekmeeter-elevate.ps1",
                &ELEVATE.replace("__INNER__", &ps_quote(&inner)),
            );
            let _ = std::fs::remove_file(&inner);
        }
    }

    // The per-user setup is a normal installer window with its own progress bar and a
    // "Run Sleekmeeter" box at the end. It never asks for administrator rights.
    let setup = dir.join("Sleekmeeter-user-setup.exe");
    if std::fs::write(&setup, SETUP).is_err() {
        warn("Couldn't unpack the installer into your temp folder.");
        return;
    }
    let code = Command::new(&setup).status().ok().and_then(|s| s.code());
    let _ = std::fs::remove_file(&setup);
    match code {
        Some(0) => {
            if reboot {
                info(
                    "Sleekmeeter is installed.\n\nRestart your PC once so Voicemeeter's audio \
                     drivers start working, then open Sleekmeeter from the Start menu.",
                );
            }
        }
        Some(1) => {} // closed or cancelled by the user
        _ => warn("Sleekmeeter wasn't installed (an error). Try running the setup again."),
    }
}
