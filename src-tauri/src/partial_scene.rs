//! Selective scenes never hand their XML to Voicemeeter.
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn path(xml: &Path) -> PathBuf {
    xml.with_extension("partial.json")
}
pub fn replace_files(
    xml: &Path,
    contents: &[u8],
    partial: Option<&[u8]>,
    levels: Option<&[u8]>,
    mics: Option<&[u8]>,
) -> Result<(), String> {
    replace_files_with(xml, contents, partial, levels, mics, |from, to| {
        std::fs::rename(from, to)
    })
}
fn replace_files_with<F: FnMut(&Path, &Path) -> std::io::Result<()>>(
    xml: &Path,
    contents: &[u8],
    partial: Option<&[u8]>,
    levels: Option<&[u8]>,
    mics: Option<&[u8]>,
    mut rename: F,
) -> Result<(), String> {
    let targets = [
        xml.to_path_buf(),
        path(xml),
        xml.with_extension("levels.json"),
        xml.with_extension("micfx.json"),
    ];
    let values = [Some(contents), partial, levels, mics];
    for target in &targets {
        if target.exists() && !target.is_file() {
            return Err(format!("Scene path is not a file: {}", target.display()));
        }
    }
    let dir = xml
        .parent()
        .ok_or("Scene has no parent folder")?
        .join(format!(
            ".scene-write-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let mut backed = Vec::new();
    let mut installed = Vec::new();
    let result = (|| -> std::io::Result<()> {
        // Stage every byte before touching any authoritative file.
        for (i, value) in values.iter().enumerate() {
            if let Some(bytes) = value {
                std::fs::write(dir.join(format!("new{i}")), bytes)?;
            }
        }
        for (i, target) in targets.iter().enumerate() {
            if target.exists() {
                rename(target, &dir.join(format!("old{i}")))?;
                backed.push(i);
            }
        }
        for (i, value) in values.iter().enumerate() {
            if value.is_some() {
                rename(&dir.join(format!("new{i}")), &targets[i])?;
                installed.push(i);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        for i in installed.into_iter().rev() {
            if let Err(e) = std::fs::remove_file(&targets[i]) {
                rollback_errors.push(e.to_string());
            }
        }
        for i in backed.into_iter().rev() {
            if let Err(e) = rename(&dir.join(format!("old{i}")), &targets[i]) {
                rollback_errors.push(e.to_string());
            }
        }
        if !rollback_errors.is_empty() {
            return Err(format!(
                "Scene save failed: {error}. Backups retained in {}: {}",
                dir.display(),
                rollback_errors.join("; ")
            ));
        }
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!(
            "Scene save failed; original files restored: {error}"
        ));
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
fn selected(scope: &Value, category: &str) -> bool {
    scope[category].as_bool().unwrap_or(false)
}
fn channel<'a>(snapshot: &'a Value, key: &str) -> Option<&'a Value> {
    for (list, prefix) in [("strips", "Strip"), ("buses", "Bus")] {
        if let Some(i) = key
            .strip_prefix(&format!("{prefix}["))
            .and_then(|s| s.strip_suffix(']'))
            .and_then(|s| s.parse::<usize>().ok())
        {
            if key != format!("{prefix}[{i}]") {
                return None;
            }
            return snapshot[list].as_array()?.get(i);
        }
    }
    None
}
pub fn validate_scope(scope: &Value, snapshot: &Value) -> Result<Vec<String>, String> {
    let channels = scope["channels"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("Select at least one channel")?;
    if !["levels", "mutes", "routes", "micProcessing"]
        .iter()
        .any(|k| selected(scope, k))
    {
        return Err("Select at least one control category".into());
    }
    let mut keys = Vec::new();
    for v in channels {
        let key = v.as_str().ok_or("Invalid scene channel")?;
        if channel(snapshot, key).is_none() {
            return Err(format!(
                "Scene channel {key} is unavailable in this Voicemeeter edition"
            ));
        }
        if !keys.iter().any(|s| s == key) {
            keys.push(key.to_owned());
        }
    }
    Ok(keys)
}
pub fn capture(scope: &Value, snapshot: &Value, mics: Value) -> Result<Value, String> {
    let keys = validate_scope(scope, snapshot)?;
    let mut channels = Map::new();
    for key in &keys {
        let source = channel(snapshot, key).unwrap();
        let mut target = Map::new();
        for (category, fields) in [
            ("levels", &["gain", "layers"][..]),
            ("mutes", &["mute"][..]),
            ("routes", &["a", "b"][..]),
        ] {
            if selected(scope, category) {
                for field in fields {
                    if let Some(v) = source.get(*field) {
                        target.insert((*field).into(), v.clone());
                    }
                }
            }
        }
        channels.insert(key.clone(), Value::Object(target));
    }
    let mics = if selected(scope, "micProcessing") {
        Value::Object(
            keys.iter()
                .map(|k| {
                    (
                        k.clone(),
                        mics.get(k)
                            .cloned()
                            .unwrap_or_else(|| json!({"chain":null})),
                    )
                })
                .collect(),
        )
    } else {
        json!({})
    };
    Ok(json!({"version":1,"scope":scope,"channels":channels,"mics":mics,"partial":true}))
}
fn gain(v: &Value) -> Result<f64, String> {
    v.as_f64()
        .filter(|n| n.is_finite() && (-60.0..=12.0).contains(n))
        .ok_or("Invalid scene level".into())
}
/// Validate everything before returning any writes. Never infer selected categories from data.
pub fn script(scene: &Value, snapshot: &Value) -> Result<Vec<String>, String> {
    if scene["version"] != 1 {
        return Err("Unsupported partial scene version".into());
    }
    let scope = &scene["scope"];
    let keys = validate_scope(scope, snapshot)?;
    let mut lines = Vec::new();
    for key in keys {
        let ch = scene["channels"]
            .get(&key)
            .ok_or("Scene is missing a selected channel")?;
        if selected(scope, "levels") {
            lines.push(format!("{key}.Gain = {};", gain(&ch["gain"])?));
            if key.starts_with("Strip[") {
                if let Some(layers) = ch["layers"].as_array() {
                    let available = channel(snapshot, &key)
                        .and_then(|c| c["layers"].as_array())
                        .map(|a| a.len())
                        .unwrap_or_else(|| {
                            snapshot["buses"].as_array().map(|a| a.len()).unwrap_or(0)
                        });
                    if layers.len() > crate::layers::LAYERS || layers.len() > available {
                        return Err(
                            "Scene gain layers are unavailable in this Voicemeeter edition".into(),
                        );
                    }
                    for (i, v) in layers.iter().enumerate() {
                        lines.push(format!("{key}.GainLayer[{i}] = {};", gain(v)?));
                    }
                }
            }
        }
        if selected(scope, "mutes") {
            let mute = ch["mute"].as_bool().ok_or("Invalid scene mute")?;
            lines.push(format!("{key}.Mute = {};", u8::from(mute)));
        }
        if selected(scope, "routes") && key.starts_with("Strip[") {
            for (field, prefix) in [("a", "A"), ("b", "B")] {
                if let Some(routes) = ch[field].as_array() {
                    let available = channel(snapshot, &key)
                        .and_then(|c| c[field].as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    if routes.len() > available {
                        return Err(
                            "Scene routes are unavailable in this Voicemeeter edition".into()
                        );
                    }
                    for (i, v) in routes.iter().enumerate() {
                        let on = v
                            .as_bool()
                            .or_else(|| v.as_u64().filter(|n| *n <= 1).map(|n| n == 1))
                            .ok_or("Invalid scene route")?;
                        lines.push(format!("{key}.{prefix}{} = {};", i + 1, u8::from(on)));
                    }
                }
            }
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn successful_scene_conversion_publishes_matching_sidecars() {
        let dir = std::env::temp_dir().join(format!(
            "sleek-scene-success-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let xml = dir.join("mix.xml");
        replace_files(&xml, b"full", None, Some(b"levels"), Some(b"mics")).unwrap();
        assert!(!path(&xml).exists());
        replace_files(&xml, b"partial marker", Some(b"partial"), None, None).unwrap();
        assert_eq!(std::fs::read(path(&xml)).unwrap(), b"partial");
        assert!(!xml.with_extension("levels.json").exists());
        assert!(!xml.with_extension("micfx.json").exists());
        replace_files(
            &xml,
            b"new full",
            None,
            Some(b"new levels"),
            Some(b"new mics"),
        )
        .unwrap();
        assert_eq!(std::fs::read(&xml).unwrap(), b"new full");
        assert!(!path(&xml).exists());
        assert_eq!(
            std::fs::read(xml.with_extension("levels.json")).unwrap(),
            b"new levels"
        );
        assert_eq!(
            std::fs::read(xml.with_extension("micfx.json")).unwrap(),
            b"new mics"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_scene_conversion_restores_all_original_files_in_both_directions() {
        for was_partial in [false, true] {
            let dir = std::env::temp_dir().join(format!(
                "sleek-scene-test-{}-{}-{}",
                std::process::id(),
                was_partial,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let xml = dir.join("mix.xml");
            std::fs::write(&xml, b"original xml").unwrap();
            if was_partial {
                std::fs::write(path(&xml), b"original partial").unwrap();
            }
            std::fs::write(xml.with_extension("levels.json"), b"old levels").unwrap();
            let mut failed = false;
            let result = replace_files_with(
                &xml,
                b"new xml",
                if was_partial {
                    None
                } else {
                    Some(b"new partial".as_slice())
                },
                None,
                None,
                |from, to| {
                    if to == xml && !failed {
                        failed = true;
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "simulated filesystem failure",
                        ));
                    }
                    std::fs::rename(from, to)
                },
            );
            assert!(result.is_err());
            assert!(failed);
            assert_eq!(std::fs::read(&xml).unwrap(), b"original xml");
            assert_eq!(path(&xml).exists(), was_partial);
            if was_partial {
                assert_eq!(std::fs::read(path(&xml)).unwrap(), b"original partial");
            }
            assert_eq!(
                std::fs::read(xml.with_extension("levels.json")).unwrap(),
                b"old levels"
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn scope_rejects_unsupported_channels_and_empty_categories() {
        assert!(validate_scope(
            &json!({"channels":["Strip[99]"],"levels":true}),
            &json!({"strips":[{}],"buses":[]})
        )
        .is_err());
        assert!(validate_scope(
            &json!({"channels":["Strip[0]"]}),
            &json!({"strips":[{}],"buses":[]})
        )
        .is_err());
    }
    #[test]
    fn mute_only_never_writes_gain_routes_or_other_channels() {
        let scene = json!({"version":1,"scope":{"channels":["Strip[0]"],"mutes":true},"channels":{"Strip[0]":{"gain":-10,"mute":true,"a":[true]},"Strip[1]":{"mute":true}}});
        assert_eq!(
            script(&scene, &json!({"strips":[{},{}],"buses":[]})).unwrap(),
            vec!["Strip[0].Mute = 1;"]
        );
    }
    #[test]
    fn invalid_saved_value_rejects_entire_script() {
        let scene = json!({"version":1,"scope":{"channels":["Strip[0]"],"levels":true},"channels":{"Strip[0]":{"gain":200}}});
        assert!(script(&scene, &json!({"strips":[{}],"buses":[]})).is_err());
    }
    #[test]
    fn routes_accept_voicemeeter_numeric_flags_and_reject_unavailable_outputs() {
        let scene = json!({"version":1,"scope":{"channels":["Strip[0]"],"routes":true},"channels":{"Strip[0]":{"a":[1,0],"b":[true]}}});
        assert_eq!(
            script(
                &scene,
                &json!({"strips":[{"a":[0,0],"b":[0]}],"buses":[{},{},{}]})
            )
            .unwrap(),
            vec!["Strip[0].A1 = 1;", "Strip[0].A2 = 0;", "Strip[0].B1 = 1;"]
        );
        assert!(script(
            &scene,
            &json!({"strips":[{"a":[0],"b":[0]}],"buses":[{},{}]})
        )
        .is_err());
    }
    #[test]
    fn capture_excludes_unselected_controls_and_records_absent_processing() {
        let scene = capture(
            &json!({"channels":["Strip[1]"],"mutes":true,"micProcessing":true}),
            &json!({"strips":[{"gain":1,"mute":false},{"gain":-3,"mute":true,"a":[1]}],"buses":[]}),
            json!({"Strip[0]":{"chain":{"on":true}}}),
        )
        .unwrap();
        assert_eq!(scene["channels"], json!({"Strip[1]":{"mute":true}}));
        assert_eq!(scene["mics"], json!({"Strip[1]":{"chain":null}}));
    }
    #[test]
    fn level_scope_includes_layers_but_no_mutes_or_routes() {
        let scene = json!({"version":1,"scope":{"channels":["Strip[0]"],"levels":true},"channels":{"Strip[0]":{"gain":-10,"layers":[-10,-12],"mute":true,"a":[true]}}});
        let lines = script(&scene, &json!({"strips":[{}],"buses":[{},{}]})).unwrap();
        assert_eq!(
            lines,
            vec![
                "Strip[0].Gain = -10;",
                "Strip[0].GainLayer[0] = -10;",
                "Strip[0].GainLayer[1] = -12;"
            ]
        );
    }
}
