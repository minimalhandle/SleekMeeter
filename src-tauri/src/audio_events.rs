//! A small local timeline of the decisions that can change what the mixer hears.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const LIMIT: usize = 200;
static EVENTS: OnceLock<Mutex<VecDeque<Event>>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
pub struct Event {
    at: u64,
    kind: String,
    title: String,
    detail: String,
    target: String,
}

fn path() -> std::path::PathBuf {
    crate::settings::app_dir().join("audio-events.json")
}

fn store() -> &'static Mutex<VecDeque<Event>> {
    EVENTS.get_or_init(|| {
        let file = path();
        let data = std::fs::metadata(&file)
            .ok()
            .filter(|m| m.len() < 1024 * 1024)
            .and_then(|_| std::fs::read(&file).ok());
        let mut events: VecDeque<Event> = data
            .as_deref()
            .and_then(|b| serde_json::from_slice(b).ok())
            .unwrap_or_default();
        events.truncate(LIMIT);
        Mutex::new(events)
    })
}

fn save(events: &VecDeque<Event>) -> Result<(), String> {
    let path = path();
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(events).map_err(|e| e.to_string())?;
    std::fs::write(&temp, bytes)
        .and_then(|_| std::fs::rename(&temp, &path))
        .map_err(|e| format!("Could not save audio event history: {e}"))
}

pub fn record(app: &AppHandle, kind: &str, title: &str, detail: &str, target: &str) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let bounded = |s: &str| s.chars().take(360).collect::<String>();
    let event = Event {
        at,
        kind: kind.into(),
        title: bounded(title),
        detail: bounded(detail),
        target: bounded(target),
    };
    let mut events = store().lock().unwrap();
    if events.front().is_some_and(|last| {
        at.saturating_sub(last.at) < 10_000
            && last.kind == event.kind
            && last.title == event.title
            && last.detail == event.detail
            && last.target == event.target
    }) {
        return;
    }
    events.push_front(event);
    events.truncate(LIMIT);
    if let Err(err) = save(&events) {
        log_warn!("{err}");
    }
    drop(events);
    let _ = app.emit("audio-events-changed", ());
}

pub fn list() -> Vec<Event> {
    store().lock().unwrap().iter().cloned().collect()
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let mut events = store().lock().unwrap();
    save(&VecDeque::new())?;
    events.clear();
    drop(events);
    let _ = app.emit("audio-events-changed", ());
    Ok(())
}
