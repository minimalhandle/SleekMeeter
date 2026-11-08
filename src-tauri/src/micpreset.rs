//! Portable NVIDIA/VST3 chains. Paths and instance IDs are always resolved on this PC.

use crate::{files, micfx, pluginhost, settings, Settings};
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const FORMAT: &str = "sleekmeeter-mic-chain";
const LIMIT: u64 = 16 * 1024 * 1024;
const MAX_PLUGINS: usize = 32;

struct Pending {
    original: Value,
    replacement: Value,
    states: Vec<(String, Value)>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

pub fn clear() {
    *PENDING.lock().unwrap() = None;
}

fn chain(s: &Value, id: &str) -> Result<Value, String> {
    micfx::chains_json(&s["micFx"])
        .into_iter()
        .find(|c| c["id"] == id)
        .ok_or_else(|| "That mic chain no longer exists.".into())
}

pub fn export(app: &AppHandle, id: &str) -> Result<bool, String> {
    let (chain, cached) = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        (chain(&s, id)?, s["vstState"].clone())
    };
    let Some(path) = files::mic_preset_dialog(true) else {
        return Ok(false);
    };
    let mut plugins = Vec::new();
    for p in chain["plugins"].as_array().into_iter().flatten() {
        let pid = p["id"].as_str().unwrap_or("");
        let state = if p["on"] != false {
            pluginhost::get_state(pid.to_owned()).unwrap_or_else(|_| cached[pid].clone())
        } else {
            cached[pid].clone()
        };
        plugins.push(json!({
            "cid": p["cid"], "name": p["name"], "on": p["on"] != false,
            "c": state["c"].as_str().unwrap_or(""), "e": state["e"].as_str().unwrap_or("")
        }));
    }
    if plugins.len() > MAX_PLUGINS {
        return Err(format!(
            "Portable chains support up to {MAX_PLUGINS} plugins."
        ));
    }
    let preset = json!({
        "format": FORMAT, "version": 1,
        "on": chain["on"] == true, "aec": chain["aec"] == true,
        "stereo": chain["stereo"] == true,
        "effect": chain["effect"].as_str().unwrap_or("denoiser"),
        "strength": chain["strength"].as_f64().unwrap_or(100.0),
        "plugins": plugins
    });
    let bytes = serde_json::to_vec_pretty(&preset).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("The plugin settings exceed the portable preset size limit.".into());
    }
    std::fs::write(path, bytes).map_err(|e| format!("Could not write the mic preset: {e}"))?;
    Ok(true)
}

fn valid_state(p: &Value, key: &str) -> bool {
    p[key]
        .as_str()
        .is_some_and(|s| base64::engine::general_purpose::STANDARD.decode(s).is_ok())
}

pub fn preview(app: &AppHandle, id: &str) -> Result<Option<Value>, String> {
    clear();
    let Some(path) = files::mic_preset_dialog(false) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(LIMIT + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("Could not read the mic preset: {e}"))?;
    if bytes.len() as u64 > LIMIT {
        return Err("This mic preset exceeds the 16 MB limit.".into());
    }
    let preset: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid mic preset: {e}"))?;
    if preset["format"] != FORMAT || preset["version"] != 1 {
        return Err("Choose a version 1 Sleekmeeter mic-chain preset.".into());
    }
    let effect = preset["effect"]
        .as_str()
        .and_then(|effect| micfx::EFFECTS.iter().find(|(key, _)| *key == effect))
        .ok_or("The preset specifies an unknown NVIDIA effect.")?;
    let plugins = preset["plugins"]
        .as_array()
        .filter(|p| p.len() <= MAX_PLUGINS)
        .ok_or("The preset has an invalid plugin list.")?;
    let strength = preset["strength"]
        .as_f64()
        .filter(|v| (0.0..=100.0).contains(v))
        .ok_or("The preset has an invalid effect strength.")?;
    if plugins.iter().any(|p| {
        !p["cid"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 64)
            || !valid_state(p, "c")
            || !valid_state(p, "e")
    }) {
        return Err("The preset has an invalid plugin identity or plugin state.".into());
    }
    let (original, local, quarantine) = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        let local: Vec<Value> = micfx::chains_json(&s["micFx"])
            .iter()
            .flat_map(|c| c["plugins"].as_array().into_iter().flatten().cloned())
            .collect();
        (
            chain(&s, id)?,
            local,
            s["vstQuarantine"].as_array().cloned().unwrap_or_default(),
        )
    };
    let mut catalog = local
        .iter()
        .filter(|p| {
            p["path"]
                .as_str()
                .is_some_and(|p| std::path::Path::new(p).exists())
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut notes = Vec::new();
    if plugins
        .iter()
        .any(|p| !catalog.iter().any(|v| v["cid"] == p["cid"]))
    {
        match pluginhost::scan() {
            Ok(found) => catalog.extend(found),
            Err(_) => notes.push("The VST3 scan did not finish. Only plugins already added on this PC could be matched.".to_owned()),
        }
    }
    let stereo = preset["stereo"] == true;
    let wants_nvidia = !stereo && (preset["on"] == true || preset["aec"] == true);
    let nvidia = micfx::available();
    if wants_nvidia {
        notes.push(if nvidia {
            "NVIDIA runtime found. GPU and engine compatibility are checked when processing starts."
        } else {
            "NVIDIA runtime missing. NVIDIA effects will be imported switched off."
        }.into());
    }
    let mut replacement = original.clone();
    replacement["stereo"] = json!(stereo);
    replacement["on"] = json!(nvidia && preset["on"] == true);
    replacement["aec"] = json!(nvidia && preset["aec"] == true);
    replacement["effect"] = json!(effect.0);
    replacement["strength"] = json!(strength);
    let mut imported = Vec::new();
    let mut states = Vec::new();
    let mut results = Vec::new();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    for (i, p) in plugins.iter().enumerate() {
        let name = p["name"].as_str().unwrap_or("Unnamed VST3");
        let Some(found) = catalog.iter().find(|v| v["cid"] == p["cid"]) else {
            results.push(json!({"name": name, "status": "Missing · skipped"}));
            continue;
        };
        let quarantined = local
            .iter()
            .any(|v| v["cid"] == p["cid"] && quarantine.contains(&v["id"]));
        if quarantined {
            results.push(json!({"name": found["name"], "status": "Quarantined locally · skipped"}));
            continue;
        }
        let id = format!("portable-{timestamp}-{i}");
        let enabled = p["on"] != false;
        imported.push(
            json!({ "id": id, "cid": found["cid"], "name": found["name"],
            "vendor": found["vendor"], "path": found["path"], "on": enabled }),
        );
        states.push((id, json!({"c": p["c"], "e": p["e"]})));
        let status = if enabled {
            "Installed · enabled"
        } else {
            "Installed · disabled"
        };
        results.push(json!({"name": found["name"], "status": status}));
    }
    replacement["plugins"] = json!(imported);
    let result = json!({ "effect": effect.1, "strength": strength, "on": preset["on"] == true, "stereo": stereo,
        "aec": preset["aec"] == true, "notes": notes, "plugins": results });
    *PENDING.lock().unwrap() = Some(Pending {
        original,
        replacement,
        states,
    });
    Ok(Some(result))
}

pub fn apply(app: &AppHandle, id: &str) -> Result<Value, String> {
    let mut pending = PENDING.lock().unwrap();
    let preset = pending
        .as_ref()
        .filter(|p| p.original["id"] == id)
        .ok_or("Preview a preset first.")?;
    let store = app.state::<Settings>();
    let mut s = store.0.lock().unwrap();
    let mut next = s.clone();
    let mut chains = micfx::chains_json(&next["micFx"]);
    let destination = chains
        .iter_mut()
        .find(|c| **c == preset.original)
        .ok_or("The destination chain changed. Preview the preset again.")?;
    *destination = preset.replacement.clone();
    if next["micFx"].get("chains").is_none() {
        next["micFx"] = json!({"aecRef": next["micFx"]["aecRef"].as_str().unwrap_or("Bus[0]")});
    }
    next["micFx"]["chains"] = json!(chains);
    if !next["vstState"].is_object() {
        next["vstState"] = json!({});
    }
    for (pid, state) in &preset.states {
        next["vstState"][pid] = state.clone();
    }
    if let Some(live) = next["micFxLive"].as_object_mut() {
        live.remove(id);
    }
    settings::save(&next)?;
    let result = next["micFx"].clone();
    *s = next.clone();
    *pending = None;
    drop(s);
    let _ = app.emit("settings-changed", next);
    Ok(result)
}
