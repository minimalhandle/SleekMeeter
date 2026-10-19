//! Checks GitHub for a newer Sleekmeeter release.

use serde_json::{json, Value};
use std::time::Duration;

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
