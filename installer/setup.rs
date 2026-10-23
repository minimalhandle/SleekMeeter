//! Sleekmeeter-Setup.exe: installs Voicemeeter first if it's missing, then Sleekmeeter's MSI.
//!
//! Voicemeeter is never bundled. If it's missing, the official installer is downloaded from
//! vb-audio.com (the page is read for the current file name) and run by the user, then the
//! Sleekmeeter MSI (embedded in this exe) is installed. Standard library only.

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;

static MSI: &[u8] = include_bytes!("Sleekmeeter.msi");

const KEY: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
const PAGE: &str = "https://vb-audio.com/Voicemeeter/banana.htm";

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
Write-Host "Downloading $name ..."
Invoke-WebRequest -UseBasicParsing ($base + $name) -OutFile $zip
Expand-Archive $zip -DestinationPath $dir -Force
$exe = Get-ChildItem $dir -Recurse -Filter 'VoicemeeterSetup*.exe' | Where-Object { $_.Name -notmatch 'ARM' } | Select-Object -First 1
if (-not $exe) { throw 'The download did not contain an installer' }
Write-Host 'Starting the Voicemeeter installer. Click Install, and say yes to the Windows prompt.'
$p = Start-Process $exe.FullName -Verb RunAs -Wait -PassThru
exit 0
"#;

fn voicemeeter_installed() -> bool {
    ["/reg:64", "/reg:32"].iter().any(|view| {
        Command::new("reg")
            .args(["query", KEY, "/v", "UninstallString", view])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

fn ask(question: &str) -> bool {
    print!("{question} [Y/n] ");
    let _ = io::stdout().flush();
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    !line.trim().to_lowercase().starts_with('n')
}

fn pause(message: &str) {
    println!("{message}");
    print!("Press Enter to close. ");
    let _ = io::stdout().flush();
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
}

fn install_voicemeeter() -> bool {
    let script: PathBuf = std::env::temp_dir().join("sleekmeeter-get-voicemeeter.ps1");
    if std::fs::write(&script, FETCH).is_err() {
        return false;
    }
    let ok = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&script);
    ok
}

/// Product codes of any Sleekmeeter already installed through an MSI.
fn installed_codes() -> Vec<String> {
    let script = "$r = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')\n\
        foreach ($k in $r) { if (Test-Path $k) { Get-ChildItem $k | ForEach-Object { $n = $_.PSChildName; $d = (Get-ItemProperty $_.PSPath).DisplayName; if ($d -eq 'Sleekmeeter' -and $n -match '^\\{[0-9A-Fa-f-]+\\}$') { $n } } } }\n";
    let ps1 = std::env::temp_dir().join("sleekmeeter-check.ps1");
    if std::fs::write(&ps1, script).is_err() {
        return Vec::new();
    }
    let out = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&ps1)
        .output();
    let _ = std::fs::remove_file(&ps1);
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| l.starts_with('{') && l.ends_with('}'))
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn main() {
    println!("Sleekmeeter setup\n");
    let mut reboot = false;
    if voicemeeter_installed() {
        println!("Voicemeeter is already installed.");
    } else {
        println!("Sleekmeeter needs Voicemeeter (Banana or Potato), which isn't installed.");
        println!("It's made by VB-Audio and is free to download from {PAGE}");
        if ask("Download and install it now?") {
            if install_voicemeeter() && voicemeeter_installed() {
                println!("Voicemeeter installed.");
                reboot = true;
            } else {
                println!("Voicemeeter didn't install. You can get it yourself from {PAGE}");
                let _ = Command::new("cmd").args(["/c", "start", "", PAGE]).status();
                if !ask("Install Sleekmeeter anyway?") {
                    return;
                }
            }
        } else if !ask("Install Sleekmeeter without it?") {
            return;
        }
    }

    let msi = std::env::temp_dir().join("Sleekmeeter-setup.msi");
    if std::fs::write(&msi, MSI).is_err() {
        pause("Couldn't unpack the installer into your temp folder.");
        return;
    }
    println!("\nInstalling Sleekmeeter ...");
    // Remove any earlier Sleekmeeter first (settings live in %APPDATA% and are
    // kept), so an upgrade never lands on Windows' Change/Repair/Remove screen.
    let old = installed_codes();
    if !old.is_empty() {
        println!("Replacing your existing Sleekmeeter ...");
        for code in &old {
            let _ = Command::new("msiexec")
                .args(["/x", code.as_str(), "/passive", "/norestart"])
                .status();
        }
    }
    let status = Command::new("msiexec")
        .arg("/i")
        .arg(&msi)
        .args(["/passive", "/norestart"])
        .status();
    let _ = std::fs::remove_file(&msi);
    match status {
        Ok(s) if s.success() => {
            if reboot {
                pause("\nDone. Restart your PC once so Voicemeeter's audio drivers start working, then open Sleekmeeter.");
            } else {
                pause("\nDone. Open Sleekmeeter from the Start menu.");
            }
        }
        _ => pause("\nSleekmeeter wasn't installed (cancelled, or an error)."),
    }
}
