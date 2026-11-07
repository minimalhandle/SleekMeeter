//! Checks GitHub for a newer Sleekmeeter release.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const REPO: &str = "minimalhandle/SleekMeeter";
/// Test versions for people who opted in (Settings → Updates → Also offer test versions).
/// Only copies with that setting look here, so nobody else is ever offered these.
pub const BETA_REPO: &str = "minimalhandle/SleekMeeter-beta";
pub const CURRENT: &str = env!("CARGO_PKG_VERSION");

pub(crate) fn parts(v: &str) -> Vec<u64> {
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
        .map_err(|e| match e {
            // GitHub allows 60 unsigned API calls an hour per internet connection, shared by
            // everything on it. Say so plainly instead of blaming the connection.
            ureq::Error::Status(403 | 429, ref r)
                if r.header("x-ratelimit-remaining") == Some("0") =>
            {
                rate_limited(r.header("x-ratelimit-reset"))
            }
            ureq::Error::Status(code, _) => {
                format!("GitHub answered with an error ({code}). Try again later.")
            }
            ureq::Error::Transport(_) => {
                "Couldn't reach GitHub. Check your internet connection and try again.".into()
            }
        })?
        .into_string()
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("Couldn't read the update info: {e}"))
}

/// The message for GitHub's hourly limit. `reset` is the Unix time it lifts.
fn rate_limited(reset: Option<&str>) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mins = reset
        .and_then(|r| r.trim().parse::<u64>().ok())
        .map(|r| r.saturating_sub(now).div_ceil(60).max(1));
    match mins {
        Some(1) => "GitHub's hourly limit for update checks on this internet connection is used up. Try again in a minute.".into(),
        Some(m) => format!("GitHub's hourly limit for update checks on this internet connection is used up. Try again in {m} minutes."),
        None => "GitHub's hourly limit for update checks on this internet connection is used up. Try again later.".into(),
    }
}

fn releases(repo: &str) -> Result<Vec<Value>, String> {
    let list = get_json(&format!(
        "https://api.github.com/repos/{repo}/releases?per_page=20"
    ))?;
    Ok(list.as_array().cloned().unwrap_or_default())
}

/// The newest published release. With `beta` (Settings → Updates → test versions), the main
/// repo's pre-releases and the beta repo's releases count too. GitHub's /releases/latest
/// can't make that choice, so we read the lists.
fn newest_release(beta: bool) -> Result<Value, String> {
    let (main, api) = match releases(REPO) {
        Ok(list) => (list, true),
        // GitHub's API failed (usually its hourly limit): read the plain release pages, which
        // that limit doesn't cover. If those fail too, report the API's reason.
        Err(e) => match web_releases(REPO, beta) {
            Ok(list) => {
                log_info!("Update check: {e} Used GitHub's release pages instead");
                (list, false)
            }
            Err(_) => return Err(e),
        },
    };
    // The beta repo may be empty or unreachable: then only the main releases count.
    let test = if !beta {
        Vec::new()
    } else if api {
        releases(BETA_REPO)
            .or_else(|_| web_releases(BETA_REPO, true))
            .unwrap_or_default()
    } else {
        web_releases(BETA_REPO, true).unwrap_or_default()
    };
    pick(main, test, beta).ok_or_else(|| "No releases published yet".to_string())
}

/* ---------------- without the API ---------------- */

fn web_get(url: &str) -> Result<ureq::Response, String> {
    ureq::get(url)
        .set(
            "User-Agent",
            concat!("Sleekmeeter/", env!("CARGO_PKG_VERSION")),
        )
        .timeout(Duration::from_secs(8))
        .call()
        .map_err(|e| e.to_string())
}

/// Releases read from github.com's pages instead of the API, in the API's shape.
/// The Atom feed has no pre-release flag, so without `all` only /releases/latest is used
/// (GitHub points it at the newest full release). The feed covers everything for opted-in copies.
fn web_releases(repo: &str, all: bool) -> Result<Vec<Value>, String> {
    let tags = if all {
        let feed = web_get(&format!("https://github.com/{repo}/releases.atom"))?
            .into_string()
            .map_err(|e| e.to_string())?;
        feed_tags(repo, &feed)
    } else {
        let resp = web_get(&format!("https://github.com/{repo}/releases/latest"))?;
        tag_from_url(repo, resp.get_url()).into_iter().collect()
    };
    Ok(tags.iter().map(|t| web_release(repo, t)).collect())
}

/// The tag in a `https://github.com/{repo}/releases/tag/{tag}` link.
fn tag_from_url(repo: &str, url: &str) -> Option<String> {
    let prefix = format!("https://github.com/{repo}/releases/tag/").to_lowercase();
    if !url.to_lowercase().starts_with(&prefix) {
        return None;
    }
    let tag = url[prefix.len()..].split(['?', '#', '/', '"']).next()?;
    (!tag.is_empty()).then(|| tag.to_string())
}

/// Every release tag linked from a releases.atom feed.
fn feed_tags(repo: &str, feed: &str) -> Vec<String> {
    let mut tags: Vec<String> = feed
        .split("href=\"")
        .skip(1)
        .filter_map(|s| tag_from_url(repo, s.split('"').next().unwrap_or("")))
        .collect();
    tags.dedup();
    tags
}

/// A release in the API's shape, with its files named the way scripts/package.ps1 names them.
/// The pages give no checksums, so these downloads aren't checked against one.
fn web_release(repo: &str, tag: &str) -> Value {
    let ver = tag.trim_start_matches(['v', 'V']);
    let assets: Vec<Value> = [
        format!("Sleekmeeter-{ver}-setup.exe"),
        format!("Sleekmeeter-{ver}.msi"),
        format!("Sleekmeeter-{ver}-portable.zip"),
    ]
    .into_iter()
    .map(|name| {
        json!({
            "browser_download_url": format!("https://github.com/{repo}/releases/download/{tag}/{name}"),
            "name": name,
        })
    })
    .collect();
    json!({
        "tag_name": tag,
        "prerelease": false,
        "draft": false,
        "html_url": format!("https://github.com/{repo}/releases/tag/{tag}"),
        "assets": assets,
    })
}

/// The newest of the releases this copy may take. On a tie the main repo's release wins.
fn pick(main: Vec<Value>, test: Vec<Value>, beta: bool) -> Option<Value> {
    test.into_iter()
        .chain(
            main.into_iter()
                .filter(|r| beta || !r["prerelease"].as_bool().unwrap_or(false)),
        )
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .max_by_key(|r| parts(r["tag_name"].as_str().unwrap_or("")))
}

/// Release pages and downloads come only from Sleekmeeter's own repos.
fn ours(url: &str, tail: &str) -> bool {
    let url = url.to_lowercase();
    [REPO, BETA_REPO]
        .iter()
        .any(|r| url.starts_with(&format!("https://github.com/{r}/{tail}").to_lowercase()))
}

/// { current, latest, newer, url } for the newest published release.
pub fn latest(beta: bool) -> Result<Value, String> {
    let release = newest_release(beta)?;
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
    if !ours(url, "") {
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
    release["assets"].as_array()?.iter().find_map(|a| {
        let name = a["name"].as_str()?;
        let url = a["browser_download_url"].as_str()?;
        if !name.to_lowercase().ends_with(ends_with) || !ours(url, "releases/download/") {
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
        asset(release, "-setup.exe")
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
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW alone: it still outlives this process. Adding DETACHED_PROCESS makes
        // PowerShell exit at once without running the script.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the update: {e}"))?;
    // The script waits for this process, so ending now means it failed. Stay open if so.
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(800) {
        if let Ok(Some(_)) = child.try_wait() {
            return Err("Couldn't start the update. Use the download page instead".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
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
    let beta = crate::settings::flag(
        &app.state::<crate::Settings>().0.lock().unwrap(),
        "betaUpdates",
    );
    let release = newest_release(beta)?;
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
        // place and keeps the settings (they live in %APPDATA%). /UPDATE stops the old
        // uninstaller from removing the start-with-Windows entry and the shortcuts.
        format!(
            "$setup = {setup}\n$exe = {exe}\n\
             try {{ Wait-Process -Id {pid} -Timeout 30 }} catch {{ }}\n\
             try {{ Start-Process $setup -ArgumentList '/S /UPDATE' -Wait }} catch {{ }}\n\
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_opted_in_copies_see_test_versions() {
        let rel =
            |tag: &str, pre: bool| json!({ "tag_name": tag, "prerelease": pre, "draft": false });
        let main = || vec![rel("v0.15.3", false), rel("v0.15.5", true)];
        let test = vec![rel("v0.15.4", false)];
        assert_eq!(
            pick(main(), Vec::new(), false).unwrap()["tag_name"],
            "v0.15.3"
        );
        assert_eq!(
            pick(main(), test.clone(), true).unwrap()["tag_name"],
            "v0.15.5"
        );
        assert_eq!(
            pick(vec![rel("v0.15.3", false)], test, true).unwrap()["tag_name"],
            "v0.15.4"
        );
        assert!(ours(
            "https://github.com/minimalhandle/SleekMeeter-beta/releases/download/v0.15.4/x.exe",
            "releases/download/"
        ));
        assert!(!ours(
            "https://github.com/someone/else/releases/download/v1/x.exe",
            "releases/download/"
        ));
    }

    #[test]
    fn release_pages_stand_in_for_the_api() {
        let feed = r#"<feed><link rel="alternate" href="https://github.com/minimalhandle/SleekMeeter-beta/releases"/>
<entry><link rel="alternate" type="text/html" href="https://github.com/minimalhandle/SleekMeeter-beta/releases/tag/v0.17.1"/></entry>
<entry><link rel="alternate" type="text/html" href="https://github.com/minimalhandle/SleekMeeter-beta/releases/tag/v0.15.7"/></entry>
<entry><link href="https://github.com/someone/else/releases/tag/v9.9.9"/></entry></feed>"#;
        assert_eq!(feed_tags(BETA_REPO, feed), vec!["v0.17.1", "v0.15.7"]);
        assert_eq!(
            tag_from_url(
                REPO,
                "https://github.com/minimalhandle/SleekMeeter/releases/tag/v0.17.0"
            ),
            Some("v0.17.0".into())
        );
        // /releases/latest with no release stays on the list page.
        assert_eq!(
            tag_from_url(
                REPO,
                "https://github.com/minimalhandle/SleekMeeter/releases"
            ),
            None
        );
        let rel = web_release(BETA_REPO, "v0.17.1");
        let setup = asset(&rel, "-setup.exe").unwrap();
        assert_eq!(setup.name, "Sleekmeeter-0.17.1-setup.exe");
        assert!(setup
            .url
            .ends_with("/SleekMeeter-beta/releases/download/v0.17.1/Sleekmeeter-0.17.1-setup.exe"));
        assert!(setup.sha256.is_none());
        assert!(asset(&rel, ".msi").is_some() && asset(&rel, "-portable.zip").is_some());
        let main = vec![web_release(REPO, "v0.17.0")];
        assert_eq!(pick(main, vec![rel], true).unwrap()["tag_name"], "v0.17.1");
    }
}
