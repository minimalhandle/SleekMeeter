//! Push-to-talk and push-to-mute: shortcuts that only act while the keys are held down.
//!
//! - Push to talk: the channel (your mic) is closed, and opens while you hold the keys.
//!   After you let go it stays open a moment (Settings → `hold.releaseMs`) so the end of a
//!   word isn't cut off.
//! - Push to mute: the opposite. Holding the keys mutes the channel; letting go puts it back
//!   how it was (a channel you had already muted stays muted).
//!
//! Windows tells us when the keys go down and when they come up. The key-repeat while holding
//! is switched off by the shortcut library, but a repeat is ignored here anyway.

use crate::{fades, Settings, Vm};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How fast the channel opens when you press the keys.
const OPEN_MS: u64 = 30;
/// How fast it closes (or comes back) when you let go.
const CLOSE_MS: u64 = 80;
const DEFAULT_TAIL_MS: u64 = 250;

struct Held {
    target: String,
    talk: bool,
    /// Push to mute only: the channel was already muted before the press.
    was_muted: bool,
}

#[derive(Default)]
pub struct Holds {
    /// shortcut text ("Ctrl+Alt+T") → what holding it did
    held: HashMap<String, Held>,
    /// Counts releases per channel, so a delayed "close the mic" knows it was overtaken.
    tickets: HashMap<String, u64>,
    /// Channels already closed for push to talk since Voicemeeter connected.
    armed: HashSet<String>,
}

/// How long the mic stays open after you let go, in ms.
pub fn tail_ms(settings: &serde_json::Value) -> u64 {
    settings["hold"]["releaseMs"]
        .as_u64()
        .unwrap_or(DEFAULT_TAIL_MS)
        .min(2000)
}

fn is_channel(target: &str) -> bool {
    target.starts_with("Strip[") || target.starts_with("Bus[")
}

fn shown_mute(app: &AppHandle, api: &crate::vm::Api, target: &str) -> bool {
    let actual = api.get_bool(&format!("{target}.Mute"));
    app.state::<Vm>()
        .smooth
        .lock()
        .unwrap()
        .is_muted(target, actual)
}

/// The keys went down. `id` is the shortcut text, so each shortcut is tracked on its own.
pub fn press(app: &AppHandle, id: &str, talk: bool, target: &str) {
    if !is_channel(target) {
        return;
    }
    let vm = app.state::<Vm>();
    let Some(api) = vm.api.clone() else { return };
    let was_muted = shown_mute(app, &api, target);
    {
        let mut holds = vm.holds.lock().unwrap();
        if holds.held.contains_key(id) {
            return; // still held, a repeat
        }
        holds.held.insert(
            id.to_string(),
            Held {
                target: target.to_string(),
                talk,
                was_muted,
            },
        );
    }
    // Talking opens the channel (unmute); push to mute closes it.
    if let Err(e) = fades::mute_quick(app, &api, target, !talk, OPEN_MS) {
        log_warn!("Hold shortcut {id}: couldn't change {target}: {e}");
    }
}

/// The keys came up.
pub fn release(app: &AppHandle, id: &str) {
    let vm = app.state::<Vm>();
    let (held, ticket) = {
        let mut holds = vm.holds.lock().unwrap();
        let Some(held) = holds.held.remove(id) else {
            return;
        };
        let t = holds.tickets.entry(held.target.clone()).or_insert(0);
        *t += 1;
        let ticket = *t;
        (held, ticket)
    };
    // Another shortcut still holds this channel the same way: leave it.
    if still_held(app, &held.target, held.talk) {
        return;
    }
    let Some(api) = vm.api.clone() else { return };
    if held.talk {
        let tail = tail_ms(&app.state::<Settings>().0.lock().unwrap());
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(tail));
            let vm = app.state::<Vm>();
            let overtaken = {
                let holds = vm.holds.lock().unwrap();
                holds.tickets.get(&held.target).copied() != Some(ticket)
                    || holds
                        .held
                        .values()
                        .any(|h| h.target == held.target && h.talk)
            };
            if overtaken {
                return;
            }
            if let Err(e) = fades::mute_quick(&app, &api, &held.target, true, CLOSE_MS) {
                log_warn!("Push to talk: couldn't close {}: {e}", held.target);
            }
        });
    } else if !held.was_muted {
        if let Err(e) = fades::mute_quick(app, &api, &held.target, false, CLOSE_MS) {
            log_warn!("Push to mute: couldn't unmute {}: {e}", held.target);
        }
    }
}

fn still_held(app: &AppHandle, target: &str, talk: bool) -> bool {
    app.state::<Vm>()
        .holds
        .lock()
        .unwrap()
        .held
        .values()
        .any(|h| h.target == target && h.talk == talk)
}

/// Let go of everything (shortcuts are being re-registered, so a release could be missed).
pub fn release_all(app: &AppHandle) {
    let ids: Vec<String> = app
        .state::<Vm>()
        .holds
        .lock()
        .unwrap()
        .held
        .keys()
        .cloned()
        .collect();
    for id in ids {
        release(app, &id);
    }
}

/// Channels with a push-to-talk shortcut, from the list of shortcuts in the settings.
fn talk_targets(hotkeys: &serde_json::Value) -> HashSet<String> {
    hotkeys
        .as_array()
        .into_iter()
        .flatten()
        .filter(|h| {
            h["action"].as_str() == Some("ptt")
                && h["keys"]
                    .as_str()
                    .map(|k| !k.trim().is_empty())
                    .unwrap_or(false)
        })
        .filter_map(|h| h["target"].as_str())
        .filter(|t| is_channel(t))
        .map(String::from)
        .collect()
}

/// Forget which channels were closed, so the next `arm` closes them again (Voicemeeter reconnected).
pub fn forget_armed(app: &AppHandle) {
    app.state::<Vm>().holds.lock().unwrap().armed.clear();
}

/// Close the channels that have a push-to-talk shortcut, once, so the mic starts out closed.
/// Called when Voicemeeter has connected and when the shortcuts change (`hotkeys` is the
/// shortcut list being applied); channels already closed this session are left alone, so
/// changing an unrelated setting never mutes your mic.
pub fn arm(app: &AppHandle, hotkeys: &serde_json::Value) {
    let vm = app.state::<Vm>();
    let Some(api) = vm.api.clone() else { return };
    if !vm.last.lock().unwrap()["connected"]
        .as_bool()
        .unwrap_or(false)
    {
        return;
    }
    let wanted = talk_targets(hotkeys);
    let fresh: Vec<String> = {
        let mut holds = vm.holds.lock().unwrap();
        holds.armed.retain(|t| wanted.contains(t));
        wanted
            .iter()
            .filter(|t| !holds.armed.contains(*t))
            .cloned()
            .collect()
    };
    for target in fresh {
        let holding = still_held(app, &target, true);
        if !holding {
            match fades::mute_quick(app, &api, &target, true, CLOSE_MS) {
                Ok(()) => log_info!("Push to talk: {target} starts out muted"),
                Err(e) => {
                    log_warn!("Push to talk: couldn't mute {target}: {e}");
                    continue;
                }
            }
        }
        vm.holds.lock().unwrap().armed.insert(target);
    }
}
