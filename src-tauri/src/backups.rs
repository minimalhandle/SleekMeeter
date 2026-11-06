//! Automatic copies of Voicemeeter's whole setup (its own .xml, the same as Save Settings), so
//! a setup that got messed up can be put back. One a day, plus one before risky changes
//! (loading a scene, the setup assistant, restoring a backup). Kept in the "backups" folder
//! next to the settings.

use crate::{settings, Vm};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

/// Daily copies kept, and "before" copies kept.
const KEEP_DAILY: usize = 14;
const KEEP_BEFORE: usize = 10;
/// At most one "before" copy in this time, so automatic scene switching doesn't fill the folder.
const BEFORE_GAP: Duration = Duration::from_secs(600);
static LAST_BEFORE: Mutex<Option<Instant>> = Mutex::new(None);

fn dir() -> PathBuf {
    settings::app_dir().join("backups")
}

/// Local date and time from the Windows clock, without a date library: YYYY-MM-DD, HH.MM.
fn now_local() -> (String, String) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        let t = unsafe {
            let mut t = std::mem::zeroed();
            GetLocalTime(&mut t);
            t
        };
        (
            format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay),
            format!("{:02}.{:02}", t.wHour, t.wMinute),
        )
    }
    #[cfg(not(windows))]
    {
        let s = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        (
            format!("day-{}", s / 86_400),
            format!("{}", s % 86_400 / 60),
        )
    }
}

fn connected(app: &AppHandle) -> bool {
    app.state::<Vm>().last.lock().unwrap()["connected"]
        .as_bool()
        .unwrap_or(false)
}

fn save_as(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let api = app
        .state::<Vm>()
        .api
        .clone()
        .ok_or("Voicemeeter isn't installed")?;
    if !connected(app) {
        return Err("Voicemeeter isn't running".into());
    }
    std::fs::create_dir_all(dir()).map_err(|e| format!("Couldn't make the backups folder: {e}"))?;
    let path = dir().join(name);
    api.set_string("Command.Save", &path.to_string_lossy())?;
    Ok(path)
}

/// Keep only the newest `keep` files whose names start with `prefix`.
fn prune(prefix: &str, keep: usize) {
    let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// Today's copy, if there isn't one yet.
fn daily(app: &AppHandle) {
    let (day, _) = now_local();
    let name = format!("daily {day}.xml");
    if dir().join(&name).exists() || !connected(app) {
        return;
    }
    match save_as(app, &name) {
        Ok(_) => {
            log_info!("Saved today's Voicemeeter backup");
            prune("daily ", KEEP_DAILY);
        }
        Err(e) => log_warn!("Voicemeeter backup not saved: {e}"),
    }
}

/// A copy before something that changes a lot at once. Skipped if one was made recently.
pub fn before(app: &AppHandle, why: &str) {
    {
        let mut last = LAST_BEFORE.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < BEFORE_GAP) {
            return;
        }
        *last = Some(Instant::now());
    }
    let (day, time) = now_local();
    let clean: String = why
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .take(40)
        .collect();
    let name = format!("before {day} {time} {}.xml", clean.trim());
    match save_as(app, &name) {
        Ok(_) => prune("before ", KEEP_BEFORE),
        Err(e) => log_warn!("Voicemeeter backup before {why} not saved: {e}"),
    }
}

/// The backups, newest first: { file, label }.
pub fn list() -> Vec<Value> {
    let mut files: Vec<(SystemTime, String)> = std::fs::read_dir(dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            (name.ends_with(".xml") && (name.starts_with("daily ") || name.starts_with("before ")))
                .then(|| Some((e.metadata().ok()?.modified().ok()?, name)))
                .flatten()
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .map(|(_, f)| json!({ "file": f, "label": label(&f) }))
        .collect()
}

/// "daily 2026-11-06.xml" → "6 Nov 2026 (daily)"; "before 2026-11-06 14.05 scene Gaming.xml"
/// → "6 Nov 2026, 14:05, before scene Gaming".
fn label(file: &str) -> String {
    let stem = file.trim_end_matches(".xml");
    let date = |d: &str| -> String {
        let mut p = d.split('-');
        let (y, m, dd) = (p.next(), p.next(), p.next());
        const M: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        match (
            y,
            m.and_then(|m| m.parse::<usize>().ok()),
            dd.and_then(|d| d.parse::<u32>().ok()),
        ) {
            (Some(y), Some(m), Some(d)) if (1..=12).contains(&m) => format!("{d} {} {y}", M[m - 1]),
            _ => d.to_string(),
        }
    };
    if let Some(d) = stem.strip_prefix("daily ") {
        return format!("{} (daily)", date(d));
    }
    if let Some(rest) = stem.strip_prefix("before ") {
        let mut p = rest.splitn(3, ' ');
        let (d, t, why) = (
            p.next().unwrap_or(""),
            p.next().unwrap_or(""),
            p.next().unwrap_or(""),
        );
        return format!("{}, {}, before {why}", date(d), t.replace('.', ":"));
    }
    stem.to_string()
}

/// Put a backup back. Saves the current setup first, so the restore can be undone.
pub fn restore(app: &AppHandle, file: &str) -> Result<(), String> {
    if file.contains(['/', '\\']) || file.contains("..") || !file.ends_with(".xml") {
        return Err("That isn't one of the backups".into());
    }
    let path = dir().join(file);
    if !path.exists() {
        return Err("That backup is gone".into());
    }
    *LAST_BEFORE.lock().unwrap() = None;
    before(app, "restoring a backup");
    let api = app
        .state::<Vm>()
        .api
        .clone()
        .ok_or("Voicemeeter isn't installed")?;
    api.set_string("Command.Load", &path.to_string_lossy())?;
    log_info!("Restored Voicemeeter backup {file}");
    Ok(())
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        // Give Voicemeeter time to settle after it starts.
        std::thread::sleep(Duration::from_secs(90));
        daily(&app);
        std::thread::sleep(Duration::from_secs(20 * 60));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backups_have_readable_names() {
        assert_eq!(label("daily 2026-11-06.xml"), "6 Nov 2026 (daily)");
        assert_eq!(
            label("before 2026-11-06 14.05 scene Gaming.xml"),
            "6 Nov 2026, 14:05, before scene Gaming"
        );
    }
}
