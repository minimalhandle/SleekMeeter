//! Portable setup packages. Imported paths are data, never plugin load locations.

use crate::LockExt;
use crate::{settings, Settings, Vm};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_PACKAGE: u64 = 96 * 1024 * 1024;
const MAX_FILE: usize = 16 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    format: String,
    version: u32,
    settings: Value,
    files: Vec<Entry>,
    devices: Vec<String>,
    warnings: Vec<String>,
    #[serde(default)]
    edition: i64,
    #[serde(default)]
    apps: Vec<String>,
    #[serde(default)]
    app_endpoints: Vec<PortableEndpoint>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PortableEndpoint {
    id: String,
    name: String,
    rate: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    data: String,
}
static PENDING: Mutex<Option<Package>> = Mutex::new(None);

fn safe_path(name: &str) -> bool {
    let bits: Vec<_> = name.split('/').collect();
    bits.len() == 2 && matches!(bits[0], "scenes" | "migration-assets") && {
        let file = bits[1];
        !file.is_empty()
            && file.len() < 180
            && !file.starts_with('.')
            && !file.ends_with(['.', ' '])
            && !file
                .chars()
                .any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
            && ![
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ]
            .contains(&file.split('.').next().unwrap_or("").to_uppercase().as_str())
            && if bits[0] == "scenes" {
                file.ends_with(".xml") || file.ends_with(".json")
            } else {
                [".wav", ".mp3", ".ogg", ".flac"]
                    .iter()
                    .any(|e| file.ends_with(e))
            }
    }
}
fn validate(p: &Package) -> Result<Vec<(String, Vec<u8>)>, String> {
    if p.format != "sleekmeeter-setup"
        || p.version != 1
        || !p.settings.is_object()
        || p.files.len() > 600
        || p.devices.len() > 200
        || p.warnings.len() > 600
        || p.apps.len() > 600
        || p.app_endpoints.len() > 200
    {
        return Err("Unsupported or invalid setup package".into());
    }
    if p.app_endpoints
        .iter()
        .any(|e| e.id.len() > 512 || e.name.len() > 2048)
    {
        return Err("Invalid endpoint metadata".into());
    }
    if p.settings.get("appRoutes").is_some_and(|v| {
        !v.is_object()
            || v.as_object().unwrap().len() > 600
            || v.as_object()
                .unwrap()
                .values()
                .any(|id| id.as_str().map_or(true, |s| s.len() > 512))
    }) {
        return Err("Invalid app route assignments".into());
    }
    if serde_json::to_vec(&p.settings)
        .map_err(|e| e.to_string())?
        .len()
        > 4 * 1024 * 1024
        || p.devices
            .iter()
            .chain(&p.apps)
            .chain(&p.warnings)
            .any(|s| s.len() > 2048)
    {
        return Err("Package metadata exceeds limits".into());
    }
    fn shape(value: &Value, model: &Value) -> bool {
        match (value, model) {
            (_, Value::Null) => true,
            (Value::Object(v), Value::Object(m)) => m
                .iter()
                .all(|(k, expected)| v.get(k).map_or(true, |x| shape(x, expected))),
            (Value::Array(_), Value::Array(_))
            | (Value::String(_), Value::String(_))
            | (Value::Bool(_), Value::Bool(_))
            | (Value::Number(_), Value::Number(_)) => true,
            _ => false,
        }
    }
    if !shape(&p.settings, &settings::defaults()) {
        return Err("Package settings have invalid field types".into());
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    let mut result = Vec::new();
    for e in &p.files {
        if !safe_path(&e.path)
            || !seen.insert(e.path.to_lowercase())
            || e.data.len() > MAX_FILE * 4 / 3 + 8
        {
            return Err(format!("Unsafe, duplicate or oversized file: {}", e.path));
        }
        let bytes = STANDARD
            .decode(&e.data)
            .map_err(|_| "Invalid file encoding")?;
        total += bytes.len();
        if bytes.len() > MAX_FILE || total > 64 * 1024 * 1024 {
            return Err("Setup assets exceed the 64 MB limit".into());
        }
        if e.path.ends_with(".json") {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| "Invalid scene sidecar")?;
        }
        result.push((e.path.clone(), bytes));
    }
    Ok(result)
}

/// Remove machine identities, secrets, live state and automatic external controls.
fn sanitize(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        for k in [
            "window",
            "panelPos",
            "mixWin",
            "mixWinOpen",
            "seenVersion",
            "edition",
            "autoTheme",
            "usagePing",
            "usageId",
            "micFxLive",
            "chatBalanceLive",
            "musicGuardEngaged",
            "partMute",
            "vstQuarantine",
            "migrationEpoch",
        ] {
            o.remove(k);
        }
        for k in [
            "startWithWindows",
            "launchVoicemeeter",
            "keepWindowsOutput",
            "autoRestart",
            "checkUpdates",
        ] {
            o.insert(k.into(), json!(false));
        }
        for k in [
            "remote", "obs", "twitch", "midi", "replay", "history", "ducking",
        ] {
            if let Some(obj) = o.get_mut(k).and_then(Value::as_object_mut) {
                obj.insert("on".into(), json!(false));
            }
        }
        for k in ["remote", "obs", "twitch"] {
            if let Some(obj) = o.get_mut(k).and_then(Value::as_object_mut) {
                for field in ["password", "key", "token", "accessToken", "refreshToken"] {
                    obj.remove(field);
                }
            }
        }
        if let Some(profiles) = o.get_mut("outputProfiles").and_then(Value::as_array_mut) {
            for p in profiles {
                p["auto"] = json!(false);
            }
        }
    }
}
fn plugins(v: &mut Value, local: &[Value], missing: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            if let Some(items) = o.get_mut("plugins").and_then(Value::as_array_mut) {
                for p in items {
                    if let Some(plugin) = p.as_object_mut() {
                        plugin.entry("cid").or_insert(json!(""));
                        plugin.entry("path").or_insert(json!(""));
                        plugin.insert("on".into(), json!(false));
                    }
                }
            }
            if o.contains_key("path") && (o.contains_key("cid") || o.contains_key("vendor")) {
                let found = local.iter().find(|l| {
                    l["cid"].as_str().filter(|s| !s.is_empty())
                        == o.get("cid").and_then(Value::as_str)
                        && l["cid"].as_str().is_some()
                });
                if let Some(l) = found {
                    o.insert("path".into(), l["path"].clone());
                } else {
                    missing.push(
                        o.get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown plugin")
                            .into(),
                    );
                    o.insert("path".into(), json!(""));
                }
                o.insert("on".into(), json!(false));
            }
            for child in o.values_mut() {
                plugins(child, local, missing);
            }
        }
        Value::Array(a) => {
            for child in a {
                plugins(child, local, missing);
            }
        }
        _ => {}
    }
}
fn add_file(p: &mut Package, name: String, source: &Path) -> Result<(), String> {
    if !safe_path(&name) {
        return Err(format!("Unsupported file name: {name}"));
    }
    let size = fs::metadata(source).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE as u64 {
        p.warnings
            .push(format!("Skipped oversized asset: {}", source.display()));
        return Ok(());
    }
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    p.files.push(Entry {
        path: name,
        data: STANDARD.encode(bytes),
    });
    Ok(())
}

fn capture_xml(
    root: &Path,
    save: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp_dir = root.join(format!(".migration-capture-{stamp}"));
    fs::create_dir(&temp_dir).map_err(|e| e.to_string())?;
    let temp = temp_dir.join("setup.xml");
    let result = (|| {
        save(&temp)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        let mut previous = Vec::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Ok(meta) = fs::metadata(&temp) {
                if meta.len() > MAX_FILE as u64 {
                    return Err("Current Voicemeeter XML exceeds 16 MB".into());
                }
            }
            if let Ok(bytes) = fs::read(&temp) {
                if !bytes.is_empty() && bytes == previous {
                    return Ok(bytes);
                }
                previous = bytes;
            }
            if std::time::Instant::now() >= deadline {
                return Err(
                    "Voicemeeter did not finish saving the setup; no package was exported".into(),
                );
            }
        }
    })();
    let _ = fs::remove_file(&temp);
    let _ = fs::remove_dir(&temp_dir);
    result
}
fn playback_endpoints() -> Vec<PortableEndpoint> {
    crate::endpoints::list()
        .into_iter()
        .filter(|e| !e.capture && e.active)
        .map(|e| PortableEndpoint {
            id: e.id(),
            name: e.full,
            rate: e.rate,
        })
        .collect()
}
fn route_endpoints(settings: &Value, endpoints: &[PortableEndpoint]) -> Vec<PortableEndpoint> {
    let mut result = vec![];
    for id in settings["appRoutes"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if result.iter().any(|e: &PortableEndpoint| e.id == id) {
            continue;
        }
        result.push(
            endpoints
                .iter()
                .find(|e| e.id == id)
                .cloned()
                .unwrap_or(PortableEndpoint {
                    id: id.into(),
                    name: "Unavailable source output".into(),
                    rate: None,
                }),
        );
    }
    result
}
fn remap_app_routes(
    settings: &mut Value,
    mappings: &BTreeMap<String, String>,
    local: &[PortableEndpoint],
) {
    if let Some(routes) = settings.get_mut("appRoutes").and_then(Value::as_object_mut) {
        routes.retain(|_, value| {
            let old = value.as_str().unwrap_or("");
            let selected = mappings
                .get(&format!("endpoint:{old}"))
                .map(String::as_str)
                .unwrap_or(old);
            if selected.is_empty() || !local.iter().any(|e| e.id == selected) {
                return false;
            }
            *value = json!(selected);
            true
        });
    }
}
pub fn export(app: &AppHandle, target: &str) -> Result<(), String> {
    let mut p = Package {
        format: "sleekmeeter-setup".into(),
        version: 1,
        settings: app.state::<Settings>().0.locked().clone(),
        files: vec![],
        devices: vec![],
        warnings: vec![],
        edition: app.state::<Vm>().last.locked()["edition"]
            .as_i64()
            .unwrap_or(0),
        apps: vec![],
        app_endpoints: vec![],
    };
    p.apps = p.settings["sceneRules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["app"].as_str().map(str::to_owned))
        .collect();
    if let Some(routes) = p.settings["appRoutes"].as_object() {
        for app in routes.keys() {
            if !p.apps.contains(app) {
                p.apps.push(app.clone());
            }
        }
    }
    p.app_endpoints = route_endpoints(&p.settings, &playback_endpoints());
    sanitize(&mut p.settings);
    let dir = settings::app_dir();
    if let Ok(rd) = fs::read_dir(dir.join("scenes")) {
        for item in rd {
            let item = item.map_err(|e| e.to_string())?;
            if item.file_type().map_err(|e| e.to_string())?.is_file() {
                let name = format!("scenes/{}", item.file_name().to_string_lossy());
                if safe_path(&name) {
                    add_file(&mut p, name, &item.path())?;
                }
            }
        }
    }
    // Voicemeeter writes its own XML. Never load it automatically on another machine.
    let vm = app.state::<Vm>();
    let snapshot = vm.last.locked().clone();
    for key in ["strips", "buses"] {
        if let Some(channels) = snapshot[key].as_array() {
            for c in channels {
                collect_devices(c, &mut p.devices);
            }
        }
    }
    if vm.last.locked()["connected"].as_bool() == Some(true) {
        if let Some(api) = &vm.api {
            let contents = capture_xml(&dir, |temp| {
                api.set_string("Command.Save", &temp.to_string_lossy())
            })?;
            // Choose an unused name so an existing scene and its sidecars stay together.
            let mut name = "scenes/Migrated setup.xml".to_string();
            let mut number = 2;
            while p.files.iter().any(|e| e.path.eq_ignore_ascii_case(&name)) {
                name = format!("scenes/Migrated setup {number}.xml");
                number += 1;
            }
            p.files.push(Entry {
                path: name,
                data: STANDARD.encode(contents),
            });
            let xml = PathBuf::from(&p.files.last().unwrap().path);
            p.files.push(Entry {
                path: xml
                    .with_extension("micfx.json")
                    .to_string_lossy()
                    .replace('\\', "/"),
                data: STANDARD.encode(crate::micfx::scene_snapshot(app).to_string()),
            });
            let channel = |c: &Value| json!({"gain":c["gain"],"mute":c["mute"],"layers":c["layers"],"a":c["a"],"b":c["b"]});
            let levels = snapshot["strips"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(i, c)| (format!("Strip[{i}]"), channel(c)))
                .chain(
                    snapshot["buses"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .enumerate()
                        .map(|(i, c)| (format!("Bus[{i}]"), channel(c))),
                )
                .collect::<serde_json::Map<String, Value>>();
            p.files.push(Entry {
                path: xml
                    .with_extension("levels.json")
                    .to_string_lossy()
                    .replace('\\', "/"),
                data: STANDARD.encode(Value::Object(levels).to_string()),
            });
        }
    } else {
        p.warnings
            .push("Voicemeeter was disconnected: current setup XML unavailable".into());
    }
    if let Some(sounds) = p.settings["soundboard"]["sounds"].as_array_mut() {
        let mut assets = Vec::new();
        for (i, sound) in sounds.iter_mut().enumerate() {
            let source = sound["path"].as_str().unwrap_or("").to_string();
            let ext = Path::new(&source)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let name = format!("migration-assets/sound-{i}.{ext}");
            sound["path"] = json!("");
            // Folder/random packs need explicit re-selection on the destination.
            if safe_path(&name) && Path::new(&source).is_file() {
                assets.push((name.clone(), PathBuf::from(source)));
                sound["path"] = json!(name);
            } else {
                p.warnings
                    .push(format!("Sound {} needs re-selection", i + 1));
            }
            if let Some(o) = sound.as_object_mut() {
                o.remove("folder");
                o.remove("pack");
            }
        }
        for (name, path) in assets {
            add_file(&mut p, name, &path)?;
        }
    }
    // Source plugin paths must not travel; CIDs remain for matching installed local plugins.
    let mut ignored = vec![];
    plugins(&mut p.settings, &[], &mut ignored);
    collect_devices(&p.settings, &mut p.devices);
    validate(&p)?;
    let bytes = serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_PACKAGE {
        return Err("Package exceeds 96 MB".into());
    }
    fs::write(target, bytes).map_err(|e| e.to_string())
}
fn collect_devices(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            for (k, value) in o {
                if k == "device" || (k == "name" && o.contains_key("bus")) {
                    if let Some(s) = value.as_str().filter(|s| !s.is_empty()) {
                        if !out.iter().any(|x| x == s) {
                            out.push(s.into());
                        }
                    }
                }
                collect_devices(value, out);
            }
        }
        Value::Array(a) => {
            for x in a {
                collect_devices(x, out);
            }
        }
        _ => {}
    }
}
fn local_devices(app: &AppHandle) -> Vec<String> {
    let mut out = vec![];
    if let Some(api) = &app.state::<Vm>().api {
        let d = api.devices();
        for key in ["inputs", "outputs"] {
            if let Some(a) = d[key].as_array() {
                for x in a {
                    if let Some(s) = x["name"].as_str() {
                        if !out.iter().any(|n| n == s) {
                            out.push(s.into());
                        }
                    }
                }
            }
        }
    }
    out
}
pub fn preview(app: &AppHandle, source: &str) -> Result<Value, String> {
    if fs::metadata(source).map_err(|e| e.to_string())?.len() > MAX_PACKAGE {
        return Err("Package exceeds 96 MB".into());
    }
    let mut p: Package = serde_json::from_slice(&fs::read(source).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Invalid setup package: {e}"))?;
    validate(&p)?;
    let apps = crate::apps::suggestions();
    let mut required = p.apps.clone();
    if let Some(routes) = p.settings["appRoutes"].as_object() {
        for app in routes.keys() {
            if !required.contains(app) {
                required.push(app.clone());
            }
        }
    }
    let local_edition = app.state::<Vm>().last.locked()["edition"]
        .as_i64()
        .unwrap_or(0);
    if local_edition == 0 || p.edition == 0 || local_edition != p.edition {
        p.warnings.push(format!("Voicemeeter edition compatibility requires review (source {}, local {}). Imported XML is not loaded automatically.", p.edition, local_edition));
    }
    p.warnings.push("Device mapping applies to settings. XML scenes keep their original hardware assignments; review them before loading.".into());
    sanitize(&mut p.settings);
    let local = crate::vst::scan().unwrap_or_default();
    let mut missing = vec![];
    plugins(&mut p.settings, &local, &mut missing);
    let devices = local_devices(app);
    let local_endpoints = playback_endpoints();
    let app_endpoints = route_endpoints(&p.settings, &p.app_endpoints);
    for e in &app_endpoints {
        if !local_endpoints.iter().any(|l| l.id == e.id) {
            p.warnings.push(format!("App output {} needs mapping to a local playback output. Unmapped assignments will be cleared.", e.name));
        }
    }
    let result = json!({"files": p.files.len(), "devices": p.devices, "localDevices": devices, "appEndpoints":app_endpoints, "localEndpoints":local_endpoints, "missingPlugins": missing, "missingApps": required.into_iter().filter(|x| !apps.iter().any(|a| a.eq_ignore_ascii_case(x))).collect::<Vec<_>>(), "warnings": p.warnings});
    *PENDING.locked() = Some(p);
    Ok(result)
}

/// Back up every destination before the first replacement; roll everything back on error.
#[cfg(test)]
fn transaction(root: &Path, files: &[(String, Vec<u8>)]) -> Result<PathBuf, String> {
    transaction_deleting(root, files, &[])
}
fn transaction_deleting(
    root: &Path,
    files: &[(String, Vec<u8>)],
    deletions: &[String],
) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let backup = root.join("migration-backups").join(stamp.to_string());
    fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
    let mut prior = Vec::new();
    for name in files.iter().map(|(name, _)| name).chain(deletions) {
        let target = root.join(name);
        // Reject reparse points/symlinks at every component, including existing destinations.
        let mut walk = root.to_path_buf();
        for bit in Path::new(name).components() {
            walk.push(bit);
            if let Ok(m) = fs::symlink_metadata(&walk) {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if m.file_attributes() & 0x400 != 0 {
                        return Err("Destination contains a reparse point".into());
                    }
                }
                if m.file_type().is_symlink() {
                    return Err("Destination contains a symbolic link".into());
                }
            }
        }
        let old = if target.exists() {
            Some(fs::read(&target).map_err(|e| e.to_string())?)
        } else {
            None
        };
        if let Some(bytes) = &old {
            let b = backup.join(name);
            fs::create_dir_all(b.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(b, bytes).map_err(|e| e.to_string())?;
        }
        prior.push((target, old));
    }
    fs::write(backup.join("manifest.json"), serde_json::to_vec(&json!({"replaced":files.iter().map(|(n, _)| n).collect::<Vec<_>>(),"removed":deletions})).unwrap()).map_err(|e| e.to_string())?;
    for (index, (target, _)) in prior.iter().enumerate() {
        let result = if let Some((_, bytes)) = files.get(index) {
            fs::create_dir_all(target.parent().unwrap()).and_then(|_| fs::write(target, bytes))
        } else if target.exists() {
            fs::remove_file(target)
        } else {
            Ok(())
        };
        if let Err(e) = result {
            let mut errors = vec![];
            for (path, old) in &prior {
                let r = match old {
                    Some(b) => fs::write(path, b),
                    None => {
                        if path.is_file() {
                            fs::remove_file(path)
                        } else {
                            Ok(())
                        }
                    }
                };
                if let Err(e) = r {
                    errors.push(e.to_string());
                }
            }
            return Err(format!(
                "Import failed: {e}. Rollback errors: {errors:?}. Backup: {}",
                backup.display()
            ));
        }
    }
    Ok(backup)
}
fn map_devices(v: &mut Value, mappings: &BTreeMap<String, String>) {
    match v {
        Value::Object(o) => {
            let bus = o.contains_key("bus");
            for (k, x) in o {
                if k == "device" || (bus && k == "name") {
                    if let Some(s) = x.as_str() {
                        if let Some(to) = mappings.get(s) {
                            *x = json!(to);
                        }
                    }
                }
                map_devices(x, mappings);
            }
        }
        Value::Array(a) => {
            for x in a {
                map_devices(x, mappings);
            }
        }
        _ => {}
    }
}
fn disarm_controls(settings: &mut Value, enable: bool) {
    if !enable {
        let mut disabled = json!({});
        for key in ["hotkeys", "sceneRules", "appRules"] {
            if let Some(value) = settings.get(key).cloned() {
                disabled[key] = value;
                settings[key] = json!([]);
            }
        }
        settings["migrationDisabledControls"] = disabled;
    }
}
fn retain_local_plugin_state(settings: &mut Value, local: &[Value]) {
    let mut ids = HashSet::new();
    fn gather(v: &Value, local: &[Value], ids: &mut HashSet<String>) {
        match v {
            Value::Object(o) => {
                if o.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|p| !p.is_empty())
                    && local.iter().any(|l| l["cid"] == v["cid"])
                {
                    if let Some(id) = v["id"].as_str() {
                        ids.insert(id.to_owned());
                    }
                }
                for x in o.values() {
                    gather(x, local, ids);
                }
            }
            Value::Array(a) => {
                for x in a {
                    gather(x, local, ids);
                }
            }
            _ => {}
        }
    }
    gather(&settings["micFx"], local, &mut ids);
    if let Some(states) = settings.get_mut("vstState").and_then(Value::as_object_mut) {
        states.retain(|id, _| ids.contains(id));
    }
    if let Some(presets) = settings.get_mut("vstPresets").and_then(Value::as_array_mut) {
        presets.retain(|p| {
            local.iter().any(|l| {
                l["cid"].as_str().is_some_and(|cid| !cid.is_empty()) && l["cid"] == p["cid"]
            })
        });
    }
}
pub fn check_epoch(current: &Value, incoming: &Value) -> Result<(), String> {
    if current.get("migrationEpoch") != incoming.get("migrationEpoch") {
        return Err(
            "Settings changed after setup import. Reload this window before saving.".into(),
        );
    }
    Ok(())
}
pub fn apply(
    app: &AppHandle,
    mappings: BTreeMap<String, String>,
    enable_controls: bool,
) -> Result<String, String> {
    let _write = crate::SETTINGS_WRITE_LOCK.locked();
    let p = PENDING
        .lock()
        .unwrap()
        .clone()
        .ok_or("Preview a setup package first")?;
    let available = local_devices(app);
    let local_endpoints = playback_endpoints();
    let source_endpoints = route_endpoints(&p.settings, &p.app_endpoints);
    for (from, to) in &mappings {
        let valid = if let Some(id) = from.strip_prefix("endpoint:") {
            source_endpoints.iter().any(|e| e.id == id)
                && (to.is_empty() || local_endpoints.iter().any(|e| e.id == *to))
        } else {
            p.devices.contains(from) && (to.is_empty() || available.contains(to))
        };
        if !valid {
            return Err("Choose an available local device".into());
        }
    }
    let mut files = validate(&p)?;
    let mut imported = p.settings;
    remap_app_routes(&mut imported, &mappings, &local_endpoints);
    sanitize(&mut imported);
    let local = crate::vst::scan().unwrap_or_default();
    plugins(&mut imported, &local, &mut vec![]);
    retain_local_plugin_state(&mut imported, &local);
    disarm_controls(&mut imported, enable_controls);
    for (name, bytes) in &mut files {
        if name.ends_with(".json") {
            let mut sidecar: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            plugins(&mut sidecar, &local, &mut vec![]);
            *bytes = serde_json::to_vec(&sidecar).map_err(|e| e.to_string())?;
        }
    }
    let mut effective = mappings;
    for device in &p.devices {
        if !effective.contains_key(device) && !available.contains(device) {
            effective.insert(device.clone(), String::new());
        }
    }
    map_devices(&mut imported, &effective);
    let root = settings::app_dir();
    // Remove stale local sidecars when an imported scene intentionally has none.
    let mut deletions = vec![];
    for (name, _) in &files {
        if name.starts_with("scenes/") && name.ends_with(".xml") {
            for ext in ["partial.json", "levels.json", "micfx.json"] {
                let sidecar = Path::new(name)
                    .with_extension(ext)
                    .to_string_lossy()
                    .replace('\\', "/");
                if !files.iter().any(|(n, _)| n.eq_ignore_ascii_case(&sidecar))
                    && root.join(&sidecar).exists()
                {
                    deletions.push(sidecar);
                }
            }
        }
    }
    if let Some(sounds) = imported["soundboard"]["sounds"].as_array_mut() {
        for s in sounds {
            let name = s["path"].as_str().unwrap_or("");
            s["path"] =
                if name.starts_with("migration-assets/") && files.iter().any(|(n, _)| n == name) {
                    json!(root.join(name).to_string_lossy())
                } else {
                    json!("")
                };
            if let Some(o) = s.as_object_mut() {
                o.remove("folder");
                o.remove("pack");
            }
        }
    }
    let state = app.state::<Settings>();
    let mut current = state.0.locked();
    let mut next = settings::defaults();
    next.as_object_mut()
        .unwrap()
        .extend(imported.as_object().unwrap().clone());
    for k in [
        "window",
        "panelPos",
        "mixWin",
        "edition",
        "usagePing",
        "usageId",
    ] {
        if let Some(v) = current.get(k) {
            next[k] = v.clone();
        }
    }
    next["migrationEpoch"] = json!(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        .to_string());
    files.push((
        "settings.json".into(),
        serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
    ));
    let backup = transaction_deleting(&root, &files, &deletions)?;
    *current = next.clone();
    drop(current);
    // Complete native reconfiguration before any window adopts the imported snapshot.
    let problems = crate::apply_hotkeys(app, &next["hotkeys"]);
    for problem in problems {
        log_warn!("Imported shortcuts: {problem}");
    }
    if crate::win::autostart_enabled() {
        if let Err(e) = crate::win::set_autostart(false) {
            log_warn!("Import startup setting: {e}");
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(settings::flag(&next, "alwaysOnTop"));
    }
    *PENDING.locked() = None;
    let _ = app.emit(
        "setup-imported",
        json!({"settings":next,"backup":backup.to_string_lossy()}),
    );
    let _ = app.emit("settings-changed", &next);
    Ok(backup.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn package() -> Package {
        Package {
            format: "sleekmeeter-setup".into(),
            version: 1,
            settings: json!({}),
            files: vec![],
            devices: vec![],
            warnings: vec![],
            edition: 2,
            apps: vec![],
            app_endpoints: vec![],
        }
    }
    #[test]
    fn captures_delayed_xml_in_unique_location_and_cleans_up() {
        let root = std::env::temp_dir().join(format!(
            "sleek-capture-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("migration-current.xml"), b"stale").unwrap();
        let mut worker = None;
        let result = capture_xml(&root, |path| {
            let path = path.to_path_buf();
            assert!(!path.exists());
            worker = Some(std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                fs::write(path, b"<Voicemeeter fresh='true' />").unwrap();
            }));
            Ok(())
        })
        .unwrap();
        worker.unwrap().join().unwrap();
        assert_eq!(result, b"<Voicemeeter fresh='true' />");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(capture_xml(&root, |_| Err("save failed".into())).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn app_route_mapping_uses_local_endpoint_ids_and_clears_unavailable_assignments() {
        let old = "{0.0.0.00000000}.{old-guid}";
        let new = "{0.0.0.00000000}.{new-guid}";
        let mut settings =
            json!({"appRoutes":{"game.exe":old,"missing.exe":"missing-guid","default.exe":""}});
        let source = vec![PortableEndpoint {
            id: old.into(),
            name: "Headphones".into(),
            rate: Some(48000),
        }];
        let metadata = route_endpoints(&settings, &source);
        assert_eq!(
            metadata.iter().find(|e| e.id == old).unwrap().name,
            "Headphones"
        );
        let local = vec![PortableEndpoint {
            id: new.into(),
            name: "New headphones".into(),
            rate: Some(48000),
        }];
        remap_app_routes(
            &mut settings,
            &BTreeMap::from([(format!("endpoint:{old}"), new.into())]),
            &local,
        );
        assert_eq!(settings["appRoutes"]["game.exe"], new);
        assert!(settings["appRoutes"].get("missing.exe").is_none());
        assert!(settings["appRoutes"].get("default.exe").is_none());
        settings["appRoutes"]["game.exe"] = json!(old);
        remap_app_routes(
            &mut settings,
            &BTreeMap::from([(format!("endpoint:{old}"), "Headphones".into())]),
            &local,
        );
        assert!(
            settings["appRoutes"].get("game.exe").is_none(),
            "Display names must never become endpoint IDs"
        );
    }
    #[test]
    fn rejects_traversal_duplicate_and_versions() {
        for path in [
            "../settings.json",
            "scenes/../evil.xml",
            "scenes/C:evil.xml",
            "scenes/CON.xml",
            "scenes/x.xml.",
            "migration-assets/evil.exe",
            "scenes/\\evil.xml",
        ] {
            let mut p = package();
            p.files.push(Entry {
                path: path.into(),
                data: "".into(),
            });
            assert!(validate(&p).is_err(), "{path}");
        }
        let mut p = package();
        p.version = 9;
        assert!(validate(&p).is_err());
        let mut malformed = package();
        malformed.settings = json!({"micFx":"broken"});
        assert!(validate(&malformed).is_err());
        p.version = 1;
        p.files = vec![
            Entry {
                path: "scenes/a.xml".into(),
                data: "".into(),
            },
            Entry {
                path: "scenes/A.xml".into(),
                data: "".into(),
            },
        ];
        assert!(validate(&p).is_err());
    }
    #[test]
    fn secrets_live_state_and_imported_plugin_paths_are_removed() {
        let mut v = json!({"usageId":"secret", "micFxLive":{}, "obs":{"on":true,"password":"secret"}, "remote":{"on":true,"key":"secret"}, "sceneRules":[{}], "micFx":{"plugins":[{"cid":"a","path":"C:/evil.vst3","on":true}]}});
        sanitize(&mut v);
        plugins(&mut v, &[], &mut vec![]);
        assert!(v.get("usageId").is_none());
        assert!(v["obs"].get("password").is_none());
        assert_eq!(v["remote"]["on"], false);
        assert_eq!(v["sceneRules"], json!([{}]));
        assert_eq!(v["micFx"]["plugins"][0]["path"], "");
    }
    #[test]
    fn preserves_definitions_and_only_restores_locally_matched_plugin_state() {
        let mut v = json!({"hotkeys":[{"keys":"Ctrl+M"}],"sceneRules":[{"app":"game.exe"}],"midi":{"on":true,"maps":[{}]},"micFx":{"chains":[{"engine":"cpu","rider":{"on":true},"plugins":[{"id":"p1","cid":"a","path":"evil"}]}]},"vstState":{"p1":{"c":"state"},"p2":{"c":"unknown"}},"vstPresets":[{"cid":"a","c":"preset"},{"cid":"b"}]});
        sanitize(&mut v);
        assert_eq!(v["hotkeys"].as_array().unwrap().len(), 1);
        assert_eq!(v["midi"]["maps"], json!([{}]));
        let local = vec![json!({"cid":"a","path":"local.vst3"})];
        plugins(&mut v, &local, &mut vec![]);
        retain_local_plugin_state(&mut v, &local);
        assert_eq!(v["vstState"]["p1"]["c"], "state");
        assert!(v["vstState"].get("p2").is_none());
        assert_eq!(v["vstPresets"].as_array().unwrap().len(), 1);
        assert_eq!(v["micFx"]["chains"][0]["engine"], "cpu");
        let enabled = v.clone();
        disarm_controls(&mut v, false);
        assert_eq!(v["hotkeys"], json!([]));
        assert_eq!(
            v["migrationDisabledControls"]["hotkeys"],
            enabled["hotkeys"]
        );
        v = enabled.clone();
        disarm_controls(&mut v, true);
        assert_eq!(v["hotkeys"], enabled["hotkeys"]);
        assert_eq!(v["sceneRules"], enabled["sceneRules"]);
    }
    #[test]
    fn backup_preserves_overwritten_files_and_rollback_restores() {
        let root = std::env::temp_dir().join(format!(
            "sleek-migration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("settings.json"), b"old").unwrap();
        let backup = transaction(&root, &[("settings.json".into(), b"new".to_vec())]).unwrap();
        assert_eq!(fs::read(backup.join("settings.json")).unwrap(), b"old");
        fs::write(root.join("stale.json"), b"sidecar").unwrap();
        let backup = transaction_deleting(&root, &[], &["stale.json".into()]).unwrap();
        assert!(!root.join("stale.json").exists());
        assert_eq!(fs::read(backup.join("stale.json")).unwrap(), b"sidecar");
        fs::write(root.join("blocker"), b"block").unwrap();
        assert!(transaction(
            &root,
            &[
                ("settings.json".into(), b"bad".to_vec()),
                ("blocker/child".into(), vec![])
            ]
        )
        .is_err());
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn post_import_stale_window_save_cannot_overwrite_imported_disk_snapshot() {
        let root = std::env::temp_dir().join(format!(
            "sleek-migration-epoch-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let stale_window = json!({"theme":"old"});
        let imported = json!({"theme":"imported","migrationEpoch":"new-import"});
        transaction(
            &root,
            &[(
                "settings.json".into(),
                serde_json::to_vec(&imported).unwrap(),
            )],
        )
        .unwrap();
        let attempt = check_epoch(&imported, &stale_window).and_then(|_| {
            transaction(
                &root,
                &[(
                    "settings.json".into(),
                    serde_json::to_vec(&stale_window).unwrap(),
                )],
            )
        });
        assert!(attempt.is_err());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(root.join("settings.json")).unwrap())
                .unwrap(),
            imported
        );
        let mut refreshed_window = imported.clone();
        refreshed_window["theme"] = json!("reviewed");
        check_epoch(&imported, &refreshed_window).unwrap();
        transaction(
            &root,
            &[(
                "settings.json".into(),
                serde_json::to_vec(&refreshed_window).unwrap(),
            )],
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(root.join("settings.json")).unwrap())
                .unwrap()["theme"],
            "reviewed"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
