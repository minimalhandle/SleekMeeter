//! Checks GitHub for a newer Sleekmeeter release.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "minimalhandle/SleekMeeter";
pub const CURRENT: &str = env!("CARGO_PKG_VERSION");

fn parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(|c: char| c == '.' || c == '-')
        .map_while(|p| p.parse::<u64>().ok())
        .collect()
}

fn get_json(url: &str) -> Result<Value, String> {
    let body = ureq::get(url)
        .set(
            "User-Agent",
            concat!("Sleekmeeter/", env!("CARGO_PKG_VERSION")),
        )
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(8))
        .call()
        .map_err(|e| format!("Couldn't check for updates: {e}"))?
        .into_string()
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("Couldn't read the update info: {e}"))
}

/// The newest published release, counting pre-releases too: GitHub's
/// /releases/latest skips anything marked "Pre-release", so we read the list.
fn newest_release() -> Result<Value, String> {
    let list = get_json(&format!(
        "https://api.github.com/repos/{REPO}/releases?per_page=20"
    ))?;
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .max_by_key(|r| parts(r["tag_name"].as_str().unwrap_or("")))
        .cloned()
        .ok_or_else(|| "No releases published yet".to_string())
}

/// { current, latest, newer, url } for the newest published release.
pub fn latest() -> Result<Value, String> {
    let release = newest_release()?;
    let tag = release["tag_name"].as_str().unwrap_or("");
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    Ok(json!({
        "current": CURRENT,
        "latest": latest,
        "newer": !latest.is_empty() && parts(&latest) > parts(CURRENT),
        "url": release["html_url"],
        "canInstall": newer_assets(&release).is_some(),
    }))
}

/// Open a release page in the default browser. Only links into this repo are allowed.
pub fn open(url: &str) -> Result<(), String> {
    let allowed = format!("https://github.com/{REPO}/").to_lowercase();
    if !url.to_lowercase().starts_with(&allowed) {
        return Err("That link isn't a Sleekmeeter release".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open the browser: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err("Only available on Windows".into())
    }
}

/* ---------------- installing the update ---------------- */

struct Asset {
    url: String,
    name: String,
    sha256: Option<String>,
}

fn asset(release: &Value, ends_with: &str) -> Option<Asset> {
    let allowed = format!("https://github.com/{REPO}/releases/download/").to_lowercase();
    release["assets"].as_array()?.iter().find_map(|a| {
        let name = a["name"].as_str()?;
        let url = a["browser_download_url"].as_str()?;
        if !name.to_lowercase().ends_with(ends_with) || !url.to_lowercase().starts_with(&allowed) {
            return None;
        }
        Some(Asset {
            url: url.to_string(),
            name: name.to_string(),
            sha256: a["digest"]
                .as_str()
                .and_then(|d| d.strip_prefix("sha256:"))
                .map(|d| d.to_lowercase()),
        })
    })
}

/// The file this copy of Sleekmeeter updates itself with: the MSI if it was installed with one,
/// the portable zip otherwise.
fn newer_assets(release: &Value) -> Option<Asset> {
    if user_installed() {
        asset(release, "-user-setup.exe")
    } else if installed() {
        asset(release, ".msi")
    } else {
        asset(release, "-portable.zip")
    }
}

/// True when this copy was put in the user's own folder by the per-user setup (its uninstaller
/// sits next to the exe). Updating it needs no administrator rights.
pub fn user_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("uninstall.exe").exists()))
        .unwrap_or(false)
}

/// True when this exe sits in Program Files, i.e. it was put there by the MSI.
fn installed() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = exe.to_string_lossy().to_lowercase();
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .any(|dir| !dir.is_empty() && exe.starts_with(&dir.to_lowercase()))
}

fn download(app: &AppHandle, a: &Asset, dest: &Path) -> Result<(), String> {
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build()
        .get(&a.url)
        .set(
            "User-Agent",
            concat!("Sleekmeeter/", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(|e| format!("Couldn't download the update: {e}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file =
        std::fs::File::create(dest).map_err(|e| format!("Couldn't save the update: {e}"))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut done, mut last) = (0u64, Instant::now());
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("The download was interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| format!("Couldn't save the update: {e}"))?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(200) {
            last = Instant::now();
            let pct = if total > 0 { done * 100 / total } else { 0 };
            let _ = app.emit("update-progress", json!({ "percent": pct }));
        }
    }
    drop(file);
    let _ = app.emit("update-progress", json!({ "percent": 100 }));
    if let Some(want) = &a.sha256 {
        let got = format!("{:x}", hash.finalize());
        if &got != want {
            let _ = std::fs::remove_file(dest);
            return Err(
                "The downloaded update didn't match GitHub's checksum, so it wasn't installed"
                    .into(),
            );
        }
    }
    Ok(())
}

/// A PowerShell string literal.
/// Runs elevated: removes any installed Sleekmeeter (by its uninstall entries and by the new
/// MSI's own product code), then installs the new MSI. `__MSI__` is a quoted path.
const INSTALL_MSI: &str = r#"$msi = __MSI__
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
Start-Process msiexec -Wait -ArgumentList ('/i "' + $msi + '" /passive /norestart')
"#;

fn ps(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "''"))
}

/// Start a hidden script that waits for this process to exit, swaps in the new version and
/// starts Sleekmeeter again.
fn run_after_exit(script: &str) -> Result<(), String> {
    let path: PathBuf = std::env::temp_dir().join("sleekmeeter-update.ps1");
    std::fs::write(&path, script).map_err(|e| format!("Couldn't prepare the update: {e}"))?;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
    ])
    .arg(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS: no console, and it outlives this process.
        cmd.creation_flags(0x0800_0008);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't start the update: {e}"))
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// Download the newest version and set up its installation. On Ok the caller must exit the app:
/// a hidden script then installs the update and starts Sleekmeeter again.
pub fn install(app: &AppHandle) -> Result<(), String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("An update is already downloading".into());
    }
    let result = install_inner(app);
    if result.is_err() {
        BUSY.store(false, Ordering::SeqCst);
    }
    result
}

fn install_inner(app: &AppHandle) -> Result<(), String> {
    let release = newest_release()?;
    let tag = release["tag_name"].as_str().unwrap_or("");
    if parts(tag) <= parts(CURRENT) {
        return Err("You already have the newest version".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let user = user_installed();
    let msi = !user && installed();
    if !msi && !user {
        let dir = exe.parent().unwrap_or(Path::new("."));
        let probe = dir.join(".sleekmeeter-update-test");
        if std::fs::write(&probe, b"").is_err() {
            return Err("Sleekmeeter can't change files in its own folder, so it can't update itself here. Use the download page instead".into());
        }
        let _ = std::fs::remove_file(&probe);
    }
    let a = newer_assets(&release)
        .ok_or("This release has no file for in-app updates. Use the download page instead")?;
    let dir = std::env::temp_dir().join("Sleekmeeter-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't prepare the update: {e}"))?;
    let file = dir.join(&a.name);
    log_info!("Updating to {tag}: downloading {}", a.name);
    download(app, &a, &file)?;

    let pid = std::process::id();
    let script = if user {
        // The per-user setup runs silently without any Windows prompt, replaces the files in
        // place and keeps the settings (they live in %APPDATA%).
        format!(
            "$setup = {setup}\n$exe = {exe}\n\
             try {{ Wait-Process -Id {pid} -Timeout 30 }} catch {{ }}\n\
             try {{ Start-Process $setup -ArgumentList '/S' -Wait }} catch {{ }}\n\
             Start-Process $exe\n",
            setup = ps(&file),
            exe = ps(&exe),
        )
    } else if msi {
        // Removing the old copy first (with this MSI's own product code) and then installing
        // means it doesn't matter whether Windows sees the new MSI as an upgrade or as the
        // same product: the install always ends up on the new version. Settings live in
        // %APPDATA%, so they are kept. Both steps run in one elevated script (one prompt).
        let inner = dir.join("install.ps1");
        let body = INSTALL_MSI.replace("__MSI__", &ps(&file));
        std::fs::write(&inner, body).map_err(|e| format!("Couldn't prepare the update: {e}"))?;
        format!(
            "$inner = {inner}\n$exe = {exe}\n\
             try {{ Wait-Process -Id {pid} -Timeout 30 }} catch {{ }}\n\
             try {{ Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $inner) }} catch {{ }}\n\
             Start-Process $exe\n",
            inner = ps(&inner),
            exe = ps(&exe),
        )
    } else {
        format!(
            "$zip = {zip}\n$exe = {exe}\n$tmp = {tmp}\n\
             try {{ Wait-Process -Id {pid} -Timeout 30 }} catch {{ }}\n\
             try {{\n\
               Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force\n\
               $new = Join-Path $tmp 'Sleekmeeter.exe'\n\
               for ($i = 0; $i -lt 20; $i++) {{\n\
                 try {{ Copy-Item -LiteralPath $new -Destination $exe -Force -ErrorAction Stop; break }} catch {{ Start-Sleep -Milliseconds 500 }}\n\
               }}\n\
             }} catch {{ }}\n\
             Start-Process $exe\n",
            zip = ps(&file),
            exe = ps(&exe),
            tmp = ps(&dir.join("unzipped")),
        )
    };
    run_after_exit(&script)
}
