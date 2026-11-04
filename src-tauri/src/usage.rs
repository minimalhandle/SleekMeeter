//! Anonymous usage count, only when the user says yes. Once a day Sleekmeeter sends a random
//! install ID, its version and the Voicemeeter edition to sleekmeeter.app, so we can count how
//! many copies are in use. Nothing else: no names, devices, settings or audio.
//!
//! The ID lives in usage.json next to the settings (not in settings.json, which the window
//! rewrites) and is deleted when the user says no, so saying yes again starts a new one.

use crate::{settings, Settings};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const URL: &str = "https://sleekmeeter.app/api/ping";
/// Wait this long after starting, so the ping never slows startup.
const FIRST: Duration = Duration::from_secs(60);
/// Look again this often (it sends at most once a day).
const EVERY: Duration = Duration::from_secs(600);

fn file() -> PathBuf {
    settings::app_dir().join("usage.json")
}

/// A new random ID: 32 hex characters, from the operating system's random source.
fn new_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from the OS's random source; two of them give 128 bits.
    let part = || {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Today in UTC as YYYY-MM-DD, without a date library.
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    civil(secs / 86_400)
}

/// Days since 1970-01-01 to a date (Howard Hinnant's civil_from_days).
fn civil(days: u64) -> String {
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

fn edition(s: &Value) -> &'static str {
    match s["edition"].as_i64() {
        Some(1) => "standard",
        Some(2) => "banana",
        Some(3) => "potato",
        _ => "unknown",
    }
}

/// What gets sent. Kept here in one place so it's easy to check.
fn payload(id: &str, edition: &str) -> Value {
    json!({ "id": id, "version": env!("CARGO_PKG_VERSION"), "edition": edition })
}

fn send(url: &str, body: &Value) -> Result<(), String> {
    ureq::post(url)
        .set(
            "User-Agent",
            concat!("Sleekmeeter/", env!("CARGO_PKG_VERSION")),
        )
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(8))
        .send_string(&body.to_string())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Sends today's ping if the user agreed and it hasn't gone yet; forgets the ID if they didn't.
fn tick(app: &AppHandle) {
    let (on, edition) = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        (s["usagePing"].as_bool() == Some(true), edition(&s))
    };
    let path = file();
    if !on {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let mut saved: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    let id = match saved["id"].as_str().filter(|id| valid_id(id)) {
        Some(id) => id.to_string(),
        None => new_id(),
    };
    let day = today();
    if saved["id"] == json!(id) && saved["sent"] == json!(day) {
        return;
    }
    match send(URL, &payload(&id, edition)) {
        Ok(()) => {
            saved = json!({ "id": id, "sent": day });
            let _ = std::fs::write(&path, saved.to_string());
        }
        // Offline or the site is down: try again later, quietly.
        Err(e) => log_info!("Usage count not sent this time: {e}"),
    }
}

pub fn spawn(app: AppHandle) {
    // Development builds aren't real users.
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST);
        loop {
            tick(&app);
            std::thread::sleep(EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_random_hex() {
        let (a, b) = (new_id(), new_id());
        assert!(valid_id(&a) && valid_id(&b));
        assert_ne!(a, b);
        assert!(!valid_id("not-an-id"));
    }

    #[test]
    fn dates_are_utc_calendar_days() {
        assert_eq!(civil(0), "1970-01-01");
        assert_eq!(civil(19_783), "2024-03-01"); // just after a leap day
        assert_eq!(civil(20_761), "2026-11-04");
    }

    #[test]
    fn sends_only_the_id_version_and_edition() {
        let p = payload(
            "0123456789abcdef0123456789abcdef",
            edition(&json!({ "edition": 2 })),
        );
        let keys: Vec<&String> = p.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["edition", "id", "version"]);
        assert_eq!(p["edition"], "banana");
        assert_eq!(edition(&json!({})), "unknown");
    }
}
