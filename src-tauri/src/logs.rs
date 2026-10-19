//! A plain-text log, `logs/sleekmeeter.log` next to the exe, for bug reports.
//!
//! One line per event with the local time and a level. When the file passes 1 MB it becomes
//! `sleekmeeter.old.log` and a new one starts, so the folder never grows past about 2 MB.
//! The same message repeated within a minute is written once, with a count, so a problem
//! that happens 30 times a second can't flood the file.
//! Use the macros: `log_info!("Loaded scene {name}")`, `log_warn!(..)`, `log_error!(..)`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_BYTES: u64 = 1024 * 1024;
const QUIET_REPEATS: Duration = Duration::from_secs(60);

struct Log {
    dir: PathBuf,
    last: Option<(String, Instant)>,
    repeats: u32,
}

static LOG: Mutex<Option<Log>> = Mutex::new(None);

macro_rules! log_info { ($($t:tt)*) => { $crate::logs::write("INFO", &format!($($t)*)) } }
macro_rules! log_warn { ($($t:tt)*) => { $crate::logs::write("WARN", &format!($($t)*)) } }
macro_rules! log_error { ($($t:tt)*) => { $crate::logs::write("ERROR", &format!($($t)*)) } }

fn file(dir: &Path) -> PathBuf {
    dir.join("sleekmeeter.log")
}

/// A folder we can write to: `logs` next to the exe, or `%LOCALAPPDATA%\Sleekmeeter\logs`
/// when the exe sits somewhere read-only (like Program Files).
fn pick_dir(app_dir: &Path) -> Option<PathBuf> {
    let mut candidates = vec![app_dir.join("logs")];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Sleekmeeter").join("logs"));
    }
    candidates.into_iter().find(|d| {
        fs::create_dir_all(d).is_ok()
            && OpenOptions::new()
                .create(true)
                .append(true)
                .open(file(d))
                .is_ok()
    })
}

/// Start logging. Call once, first thing.
pub fn init(app_dir: &Path) {
    let Some(dir) = pick_dir(app_dir) else { return };
    rotate_if_big(&dir);
    *LOG.lock().unwrap_or_else(|e| e.into_inner()) = Some(Log {
        dir,
        last: None,
        repeats: 0,
    });
    // Panics end up in the log too, with where they happened.
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("ERROR", &format!("Crash: {info}"));
        default(info);
    }));
}

/// The folder the log is in, if logging started.
pub fn dir() -> Option<PathBuf> {
    LOG.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|l| l.dir.clone())
}

fn rotate_if_big(dir: &Path) {
    let path = file(dir);
    if fs::metadata(&path)
        .map(|m| m.len() > MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, dir.join("sleekmeeter.old.log"));
    }
}

pub fn write(level: &str, message: &str) {
    let mut guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    let Some(log) = guard.as_mut() else { return };
    let now = Instant::now();
    let message = message.replace(['\r', '\n'], " ");
    let line = format!("{level} {message}");
    if let Some((last, at)) = &log.last {
        if *last == line && now.duration_since(*at) < QUIET_REPEATS {
            log.repeats += 1;
            return;
        }
    }
    let mut text = String::new();
    if log.repeats > 0 {
        text.push_str(&format!(
            "{} INFO (the line before repeated {} more times)\r\n",
            timestamp(),
            log.repeats
        ));
        log.repeats = 0;
    }
    text.push_str(&format!("{} {line}\r\n", timestamp()));
    log.last = Some((line, now));
    rotate_if_big(&log.dir);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(file(&log.dir))
    {
        let _ = f.write_all(text.as_bytes());
    }
}

/// Local time, like `2026-10-20 14:03:07.512`.
#[cfg(windows)]
fn timestamp() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut t = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut t) };
    let t: windows_sys::Win32::Foundation::SYSTEMTIME = t;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    )
}

/// UTC elsewhere (only the browser preview and tests run there).
#[cfg(not(windows))]
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // civil-from-days (Howard Hinnant)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_dedups_and_counts() {
        let dir = std::env::temp_dir().join(format!("sm-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        init(&dir);
        write("INFO", "hello");
        write("WARN", "same");
        write("WARN", "same");
        write("WARN", "same");
        write("INFO", "different\nline");
        let text = fs::read_to_string(dir.join("logs").join("sleekmeeter.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4, "{text}");
        assert!(lines[0].ends_with("INFO hello"));
        assert!(lines[1].ends_with("WARN same"));
        assert!(lines[2].contains("repeated 2 more times"));
        assert!(lines[3].ends_with("INFO different line"));
        assert!(lines[0].starts_with("20"));
        let _ = fs::remove_dir_all(&dir);
    }
}
