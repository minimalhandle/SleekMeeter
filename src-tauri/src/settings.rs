//! Settings live in settings.json next to the exe, so Sleekmeeter stays portable
//! (or in %APPDATA%\Sleekmeeter when the exe sits in a read-only folder, like after an MSI install).

use serde_json::{json, Value};
use std::path::PathBuf;

/// Where settings, scenes and logs live. Portable: the exe's own folder. If that folder can't be
/// written to (installed under Program Files by the MSI), %APPDATA%\Sleekmeeter instead.
pub fn app_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        // A per-user install replaces its folder on every update, so settings stay in %APPDATA%.
        if writable(&exe_dir) && !exe_dir.join("uninstall.exe").exists() {
            return exe_dir;
        }
        match std::env::var_os("APPDATA") {
            Some(appdata) => {
                let dir = PathBuf::from(appdata).join("Sleekmeeter");
                let _ = std::fs::create_dir_all(&dir);
                dir
            }
            None => exe_dir,
        }
    })
    .clone()
}

fn writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".sleekmeeter-write-test");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn path() -> PathBuf {
    app_dir().join("settings.json")
}

/// The settings as they were before the last save, used when settings.json is missing or broken.
fn last_good() -> PathBuf {
    app_dir().join("settings.last-good.json")
}

/// False on a fresh install, before anything was saved.
pub fn exists() -> bool {
    path().exists() || last_good().exists()
}

/// Replace `path` with `bytes` so that a crash or power cut leaves either the old file or the
/// new one, never half of each: write a temporary file, flush it to disk, then swap it in.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Read a settings file: Some(object) when it parses as one.
fn read_object(p: &std::path::Path) -> Result<Option<serde_json::Map<String, Value>>, String> {
    let text = match std::fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => Ok(Some(o)),
        Ok(_) => Err("it isn't a settings object".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// The saved settings, falling back to the copy from before the last save. A broken
/// settings.json is kept (renamed) rather than overwritten, so nothing is lost for good.
fn saved_object() -> Option<serde_json::Map<String, Value>> {
    match read_object(&path()) {
        Ok(Some(o)) => return Some(o),
        Ok(None) => {}
        Err(e) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let keep = app_dir().join(format!("settings.broken-{stamp}.json"));
            let _ = std::fs::rename(path(), &keep);
            log_warn!(
                "settings.json couldn't be read ({e}); kept it as {} and used the previous settings",
                keep.display()
            );
        }
    }
    match read_object(&last_good()) {
        Ok(Some(o)) => {
            log_warn!("Restored settings from settings.last-good.json");
            Some(o)
        }
        Ok(None) => None,
        Err(e) => {
            log_warn!("settings.last-good.json couldn't be read either ({e}); using the defaults");
            None
        }
    }
}

pub fn defaults() -> Value {
    json!({
        // Per strip/bus look: { "strip-0": { "color": "amber", "icon": "mic", "hidden": false }, "bus-3": {...} }
        "appearance": {},
        "hotkeys": [
            { "keys": "Ctrl+Alt+M", "action": "mute", "target": "Strip[0]" },
            { "keys": "Ctrl+Alt+Up", "action": "volup", "target": "Bus[0]" },
            { "keys": "Ctrl+Alt+Down", "action": "voldown", "target": "Bus[0]" },
            { "keys": "Ctrl+Alt+S", "action": "window", "target": "" }
        ],
        "startWithWindows": false,
        "startInTray": false,
        "launchVoicemeeter": false,
        "hideVoicemeeter": false,
        // The volume overlay at all: off hides levels, messages and warnings alike.
        "osdOn": true,
        // Levels on the overlay when they change while you're in another app.
        "overlay": true,
        "alwaysOnTop": false,
        "mini": false,
        // Load a scene when an app starts: [{ "app": "obs64.exe", "scene": "Streaming", "restore": "Default" }]
        "sceneRules": [],
        // On for every build, test versions and local -dev builds included, so each one moves on
        // to the full release when it's out.
        "checkUpdates": true,
        // Also offer test versions (GitHub pre-releases) as updates.
        "betaUpdates": false,
        "oled": false,
        "skippedVersion": "",
        // The Stream Deck plugin offer already answered, like "install:0.16.0.0".
        "streamDeckOffered": "",
        // Anonymous usage count: null until the user is asked, then true or false (usage.rs).
        "usagePing": null,
        // Mutes fade out and in; typed levels, shortcuts and scenes glide.
        "fades": { "on": true, "muteMs": 250, "sceneMs": 1200 },
        // Talk-over ducking: while `trigger` is above `threshold` dB, lower `targets` by `amount` dB.
        "ducking": {
            "on": false, "trigger": "Strip[0]", "also": [], "targets": [], "amount": 12, "threshold": -40,
            "attackMs": 150, "releaseMs": 800, "holdMs": 700,
            "voiceAware": false, "speechThreshold": 0.6
        },
        // Restart Voicemeeter's audio engine when a device it uses comes back.
        "autoRestart": true,
        // Warn when an app opens a Bluetooth headset's mic, switching it to call quality (btwatch.rs).
        "btWarn": true,
        // Put Windows' sound output back on Voicemeeter when plugging in a device moves it.
        "keepWindowsOutput": false,
        // Volume overlay screen: "" = the mixer's screen, "primary", or a screen's name.
        "overlayScreen": "",
        // Tray panel: "rows" or "columns" (vertical faders), size and opacity in %, and what it shows.
        "panelLayout": "rows",
        "panelScale": 100,
        "panelOpacity": 100,
        "panelIcons": true,
        "panelMute": true,
        "panelMeters": true,
        // Saved sets of output devices: [{ "name": "Headphones", "auto": false,
        //   "buses": [{ "bus": 0, "type": "wdm", "name": "Headphones (Arctis)" }] }]
        "outputProfiles": [],
        "outputFallbacks": {},
        "outputFallbackLinks": {},
        "themeMotion": "subtle",
        "faderGroups": [],
        "vstQuarantine": [],
        // The tray panel snaps to the screen corner by the clock. Undocked, it can be moved and
        // remembers where you left it: "panelPos": { "x": 1500, "y": 700 } (physical pixels).
        "panelDocked": true,
        "panelPos": null,
        // Hide Solo and Mono under inputs, and Mono and EQ on outputs. On for new installs only (see `load`).
        "hideSoloMono": true,
        // Show the Be right back, Rec and Sounds buttons in the header.
        "streamerMode": true,
        // Prevent header dragging from moving channels, without locking mixer controls.
        "lockArrangement": false,
        // Push to talk: how long the mic stays open after the keys are let go.
        "hold": { "releaseMs": 250 },
        // Be right back: channels to mute, channels to turn down by `amount` dB, a channel to play.
        "brb": { "mute": [], "lower": [], "amount": 30, "play": "", "playDb": -8, "overlay": true },
        // OBS Studio link: scene rules [{ "obs": "BRB", "do": "brb-on" | "brb-off" | "scene", "scene": "" }],
        // plus what to do when the stream starts (liveDo, liveScene) and ends (offDo, offScene).
        "obs": { "on": false, "host": "127.0.0.1", "port": 4455, "password": "", "rules": [],
                 "liveDo": "", "liveScene": "", "offDo": "", "offScene": "" },
        // Warn when this channel's level goes over 0 dB.
        "clipWarn": { "on": false, "target": "Strip[0]" },
        // Soundboard: sounds [{ "name", "path", "volume" 0-100 }] play to `device` ("" = a Voicemeeter virtual input).
        "soundboard": { "device": "", "volume": 100, "sounds": [] },
        // Twitch chat commands: commands [{ "cmd": "!brb", "action": "brb", "target": "" }];
        // who can use them: "broadcaster", "mods" or "everyone".
        // Channel point rewards that ask the viewer for text show up in chat with their id:
        // rewards [{ "id", "name", "action", "target" }] (anyone who redeems one may run it).
        "twitch": { "on": false, "channel": "", "who": "mods", "cooldown": 3, "commands": [], "rewards": [] },
        // Control from a phone on the same network. `key` is the secret in the address.
        "remote": { "on": false, "port": 8787, "key": "", "scope": "network" },
        // Record how loud each channel is, for the level history.
        "history": { "on": false },
        // The output your stream gets, like "Bus[4]". "" = B2 (B on Voicemeeter Standard).
        "streamBus": "",
        // Warn when someone talks into `target` while it's muted (louder than `threshold` dB
        // before the fader). `ptt`: also while a push-to-talk key isn't held.
        "mutedTalk": { "on": false, "target": "Strip[0]", "threshold": -35, "ptt": false },
        // Warn when the stream output is silent for `silentSecs`, or clips (`clip`).
        // `onlyLive`: only while OBS says you're live.
        "streamWatch": { "on": false, "silentSecs": 15, "clip": true, "onlyLive": true },
        // Run the go-live check when OBS starts streaming.
        "goLive": { "onLive": true },
        // Keep music off the stream: turn `strip`'s send to the stream output off while OBS
        // records ("recording"), streams ("live"), either ("either"), or only by key ("manual").
        "musicGuard": { "on": false, "strip": "", "when": "either" },
        // Instant replay: keep the last `secs` seconds of `device` (a Voicemeeter output as
        // Windows lists it, "" = the stream output) ready to save as a WAV file. `tracks`: up to four
        // inputs ("Strip[0]") also saved as their own files (replay.rs).
        "replay": { "on": false, "device": "", "secs": 60, "tracks": [] },
        // Stream loudness in LUFS (loudness.rs), measured on the stream output, against `target`.
        "loudness": { "on": false, "target": -14 },
        // MIDI controllers (midi.rs): maps [{ "dev" ("" = any), "kind" ("cc", "note", "pb"), "ch",
        // "num", "action" ("fader" or a shortcut action), "target" }].
        "midi": { "on": false, "maps": [] },
        // Mic clean-up, one chain per mic (micfx.rs). On hardware input `target`: NVIDIA's speaker
        // echo removal (`aec`, using what bus `aecRef` plays), NVIDIA's `effect` when `on`
        // ("denoiser", "dereverb", "dereverb_denoiser") at `strength` %, then VST3 `plugins` in
        // order: [{ "id", "name", "vendor", "path", "cid", "on" }] (vst.rs, pluginhost.rs).
        // Older copies kept one chain's fields in micFx itself; micfx::chains_json reads both.
        // Rust keeps plugin settings in "vstState" { id: { "c", "e" } } (base64), presets in
        // "vstPresets" [{ "name", "cid", "c", "e" }], and what shortcuts and scenes switched in
        // "micFxLive" { chain id: { "off", "strength" } }.
        "micFx": {
            "aecRef": "Bus[0]",
            "chains": [{ "id": "c1", "target": "Strip[0]", "on": false, "engine": "cpu", "effect": "denoiser",
                         "strength": 100, "aec": false, "plugins": [] }]
        }
    })
}

/// Saved settings laid over the defaults, so new options get sensible values.
pub fn load() -> Value {
    let mut s = defaults();
    if let (Some(saved), Value::Object(base)) = (saved_object(), &mut s) {
        // People who already use Sleekmeeter keep seeing Solo and Mono.
        if !saved.contains_key("hideSoloMono") {
            base.insert("hideSoloMono".into(), Value::Bool(false));
        }
        // These onboarding defaults only apply when there is no settings file.
        base.extend(
            json!({
                "startInTray": true, "launchVoicemeeter": true, "themeMotion": "full",
                "history": { "on": true },
                "mutedTalk": { "on": true, "target": "Strip[0]", "threshold": -35, "ptt": false }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        for (k, v) in saved {
            base.insert(k, v);
        }
    }
    s
}

pub fn save(s: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    // The current file becomes the fallback, but only when it's a good one.
    if matches!(read_object(&path()), Ok(Some(_))) {
        let _ = std::fs::copy(path(), last_good());
    }
    write_atomic(&path(), text.as_bytes()).map_err(|e| {
        log_error!("Couldn't save settings to {}: {e}", path().display());
        format!("Couldn't save settings: {e}")
    })
}

/// The chosen theme. Before themes there was only "Pure black for OLED" (`oled`).
pub fn theme(s: &Value) -> String {
    match s["theme"].as_str() {
        // Retired themes fall back to Console.
        Some("midnight") | Some("minimal") | Some("analog") | Some("clean") | Some("studio")
        | Some("ink") | Some("deco") | Some("haunted") | Some("cosmic") | Some("rack")
        | Some("titanium") | Some("afterburner") | Some("opal") | Some("onyx")
        | Some("afterhours") | Some("caldera") | Some("blueprint") | Some("letterpress")
        | Some("eventhorizon") | Some("lunar") | Some("observatory") | Some("mission")
        | Some("sumi") => "console".into(),
        Some(t) if !t.is_empty() => t.to_string(),
        _ if flag(s, "oled") => "oled".into(),
        _ => "console".into(),
    }
}

pub fn flag(s: &Value, key: &str) -> bool {
    flag_or(s, key, false)
}

pub fn flag_or(s: &Value, key: &str, default: bool) -> bool {
    s.get(key).and_then(Value::as_bool).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("sm-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        write_atomic(&p, br#"{"a":1}"#).unwrap();
        write_atomic(&p, br#"{"a":2}"#).unwrap();
        assert_eq!(read_object(&p).unwrap().unwrap()["a"], 2);
        assert!(!dir.join("settings.json.tmp").exists());
        std::fs::write(&p, b"{\"a\":").unwrap();
        assert!(read_object(&p).is_err());
        assert!(read_object(&dir.join("missing.json")).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
