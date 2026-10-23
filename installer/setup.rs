//! Sleekmeeter-Setup.exe: installs Voicemeeter first if it's missing, then Sleekmeeter's MSI.
//!
//! Voicemeeter is never bundled. If it's missing, the official installer is downloaded from
//! vb-audio.com (the page is read for the current file name) and run by the user, then the
//! Sleekmeeter MSI (embedded in this exe) is installed. Standard library only, and no console
//! window: questions are Windows message boxes and the MSI shows its own progress bar.

#![windows_subsystem = "windows"]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

static MSI: &[u8] = include_bytes!("Sleekmeeter.msi");

const KEY: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
const PAGE: &str = "https://vb-audio.com/Voicemeeter/banana.htm";
const TITLE: &str = "Sleekmeeter setup";
/// Run console tools (reg, powershell) without flashing a window.
const NO_WINDOW: u32 = 0x0800_0000;

/// Downloads and starts VB-Audio's installer, waiting until it closes. Exit code 0 on success.
const FETCH: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://download.vb-audio.com/Download_CABLE/'
$name = 'VoicemeeterSetup_v2130.zip'
try {
  $html = (Invoke-WebRequest -UseBasicParsing 'https://vb-audio.com/Voicemeeter/banana.htm').Content
  if ($html -match 'VoicemeeterSetup_v\d+\.zip') { $name = $Matches[0] }
} catch { }
$dir = Join-Path $env:TEMP 'Sleekmeeter-Voicemeeter'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $dir | Out-Null
$zip = Join-Path $dir $name
Invoke-WebRequest -UseBasicParsing ($base + $name) -OutFile $zip
Expand-Archive $zip -DestinationPath $dir -Force
$exe = Get-ChildItem $dir -Recurse -Filter 'VoicemeeterSetup*.exe' | Where-Object { $_.Name -notmatch 'ARM' } | Select-Object -First 1
if (-not $exe) { throw 'The download did not contain an installer' }
$p = Start-Process $exe.FullName -Verb RunAs -Wait -PassThru
exit 0
"#;

/// Runs elevated (one Windows prompt). Removes any Sleekmeeter already installed (by its
/// uninstall entries, and by this MSI's own product code), then installs this MSI. Removing
/// first means a new version always replaces the old one, whatever Windows thinks of the
/// two MSIs. Settings live in %APPDATA% and are kept. Exits with msiexec's code.
const INSTALL: &str = r#"
$msi = '__MSI__'
$roots = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
foreach ($k in $roots) {
  if (Test-Path $k) {
    Get-ChildItem $k | ForEach-Object {
      $n = $_.PSChildName
      $d = (Get-ItemProperty $_.PSPath).DisplayName
      if ($d -eq 'Sleekmeeter' -and $n -match '^\{[0-9A-Fa-f-]+\}$') {
        Start-Process msiexec -Wait -ArgumentList ('/x ' + $n + ' /qn /norestart')
      }
    }
  }
}
Start-Process msiexec -Wait -ArgumentList ('/x "' + $msi + '" /qn /norestart')
$p = Start-Process msiexec -Wait -PassThru -ArgumentList ('/i "' + $msi + '" /passive /norestart')
exit $p.ExitCode
"#;

/// Starts INSTALL elevated and hidden; 1602 (cancelled) if the Windows prompt is declined.
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

fn open_sleekmeeter() {
    let base = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let exe = PathBuf::from(base)
        .join("Sleekmeeter")
        .join("Sleekmeeter.exe");
    if exe.exists() {
        let _ = Command::new(exe).spawn();
    } else {
        info("Open Sleekmeeter from the Start menu.");
    }
}

fn main() {
    let mut reboot = false;
    if !voicemeeter_installed() {
        if ask(
            "Sleekmeeter needs Voicemeeter (Banana or Potato), a free mixer made by VB-Audio, \
             and it isn't installed.\n\nDownload and install it now?\n\nIt downloads in the \
             background (about a minute), then VB-Audio's installer opens: click Install and \
             say yes to the Windows prompt.",
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
    let msi = dir.join("Sleekmeeter-setup.msi");
    if std::fs::write(&msi, MSI).is_err() {
        warn("Couldn't unpack the installer into your temp folder.");
        return;
    }
    let inner = dir.join("sleekmeeter-install.ps1");
    let wrote = std::fs::write(&inner, INSTALL.replace("__MSI__", &ps_quote(&msi))).is_ok();
    let code = if wrote {
        run_script(
            "sleekmeeter-elevate.ps1",
            &ELEVATE.replace("__INNER__", &ps_quote(&inner)),
        )
    } else {
        None
    };
    let _ = std::fs::remove_file(&inner);
    let _ = std::fs::remove_file(&msi);
    match code {
        Some(0) | Some(3010) => {
            if reboot {
                info(
                    "Sleekmeeter is installed.\n\nRestart your PC once so Voicemeeter's audio \
                     drivers start working, then open Sleekmeeter from the Start menu.",
                );
            } else if ask("Sleekmeeter is installed. Open it now?") {
                open_sleekmeeter();
            }
        }
        Some(1602) => {} // cancelled by the user
        _ => warn("Sleekmeeter wasn't installed (an error). Try running the setup again."),
    }
}
