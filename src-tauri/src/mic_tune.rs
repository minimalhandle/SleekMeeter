//! Temporary audition and pre-fader metering for the mic tune-up wizard.

use crate::{api, fades, layers::LAYERS, vm::Api, Layout, Vm};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const AUDITION: Duration = Duration::from_secs(8);
const NONE: usize = usize::MAX;
static METER: AtomicUsize = AtomicUsize::new(NONE);
static AUDITIONING: AtomicBool = AtomicBool::new(false);
static PREVIEW: Mutex<Option<Preview>> = Mutex::new(None);

#[derive(Deserialize)]
pub struct Tune {
    gain: Option<f32>,
    gate: Option<f32>,
    threshold: Option<f32>,
}

struct Change {
    field: &'static str,
    before: f32,
    after: f32,
    layers: Option<LayerPreview>,
}
struct LayerPreview {
    before: [f32; LAYERS],
    after: [f32; LAYERS],
}
struct Preview {
    strip: usize,
    edition: i32,
    changes: Vec<Change>,
    started: Instant,
    retry_at: Instant,
    restoring: bool,
}

pub fn meter(api: &Api, strip: Option<usize>) -> Result<(), String> {
    if let Some(i) = strip {
        let edition = api
            .edition()
            .ok_or("Start Voicemeeter to tune a microphone.")?;
        if i >= Layout::for_edition(edition).hw_strips {
            return Err("Choose a hardware input.".into());
        }
    }
    METER.store(strip.unwrap_or(NONE), Ordering::Relaxed);
    Ok(())
}

pub fn stop_meter() {
    METER.store(NONE, Ordering::Relaxed);
}

pub fn sample(api: &Api, layout: &Layout, levels: &mut Value) {
    let strip = METER.load(Ordering::Relaxed);
    if strip < layout.hw_strips {
        levels["micTune"] = json!({ "strip": strip, "pre": api.strip_level_pre(layout, strip) });
    }
}

fn param(strip: usize, field: &str) -> String {
    format!("Strip[{strip}].{field}")
}

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() <= 0.15
}

fn gain_layers(api: &Api, strip: usize) -> Result<[f32; LAYERS], String> {
    let mut layers = [0.0; LAYERS];
    for (i, gain) in layers.iter_mut().enumerate() {
        *gain = api
            .get_float(&format!("Strip[{strip}].GainLayer[{i}]"))
            .ok_or("An output level is unavailable on this microphone.")?;
    }
    Ok(layers)
}

fn write(
    app: &AppHandle,
    api: &Api,
    strip: usize,
    field: &str,
    value: f32,
    immediate: bool,
) -> Result<(), String> {
    if field == "Gain" && !immediate {
        fades::glide(app, api, &format!("Strip[{strip}]"), value)
    } else {
        fades::set_float(app, api, &param(strip, field), value)
    }
}

pub fn change(
    app: &AppHandle,
    strip: usize,
    expected: Tune,
    next: Tune,
    preview: bool,
) -> Result<(), String> {
    let vm = app.state::<Vm>();
    let api = api(&vm)?;
    let edition = api.edition().ok_or("Voicemeeter is unavailable.")?;
    if strip >= Layout::for_edition(edition).hw_strips {
        return Err("Choose a hardware input.".into());
    }
    if next.gain.is_some()
        && edition == 3
        && (0..Layout::for_edition(edition).buses())
            .any(|i| api.get_float(&format!("Bus[{i}].Sel")).unwrap_or(0.0) != 0.0)
    {
        return Err(
            "Set Faders set to All outputs before applying a microphone fader level.".into(),
        );
    }
    let mut active = PREVIEW.lock().unwrap();
    if active.is_some() {
        return Err("Stop the current preview first.".into());
    }
    let mut changes = Vec::new();
    for (field, before, after, bounds) in [
        (
            "Gate.Threshold",
            expected.threshold,
            next.threshold,
            -60.0..=-10.0,
        ),
        ("Gate", expected.gate, next.gate, 0.0..=10.0),
        ("Gain", expected.gain, next.gain, -60.0..=12.0),
    ] {
        let Some(after) = after else { continue };
        if !bounds.contains(&after) {
            return Err(format!("{field} is outside the supported range."));
        }
        let actual = api
            .get_float(&param(strip, field))
            .ok_or_else(|| format!("{field} is unavailable on this input."))?;
        if !before.is_some_and(|v| near(v, actual)) {
            return Err("Input settings changed after measurement. Run the tune-up again.".into());
        }
        if !near(actual, after) {
            let layers = if preview && edition == 3 && field == "Gain" {
                if vm
                    .smooth
                    .lock()
                    .unwrap()
                    .is_managed(&format!("Strip[{strip}]"))
                {
                    return Err(
                        "Wait for the microphone fade or ducking to finish before previewing."
                            .into(),
                    );
                }
                let before = gain_layers(api, strip)?;
                let after = before.map(|v| (v + after - actual).clamp(-60.0, 12.0));
                Some(LayerPreview { before, after })
            } else {
                None
            };
            changes.push(Change {
                field,
                before: actual,
                after,
                layers,
            });
        }
    }
    let started = Instant::now();
    for (i, c) in changes.iter().enumerate() {
        let applied = if let Some(layers) = &c.layers {
            fades::glide_layers(app, api, strip, &layers.after, &[true; LAYERS], false)
                .map(|()| api.adopt_layers(strip, c.after, &layers.after))
        } else {
            write(app, api, strip, c.field, c.after, false)
        };
        if let Err(err) = applied {
            for done in changes[..i].iter().rev() {
                let _ = write(app, api, strip, done.field, done.before, false);
            }
            return Err(err);
        }
    }
    if preview {
        *active = Some(Preview {
            strip,
            edition,
            changes,
            started,
            retry_at: started + AUDITION,
            restoring: false,
        });
        AUDITIONING.store(true, Ordering::Release);
    }
    Ok(())
}

fn is_preview_value(c: &Change, actual: f32, elapsed: Duration) -> bool {
    owns_value(c.before, c.after, actual, elapsed, c.field == "Gain")
}

fn owns_value(before: f32, after: f32, actual: f32, elapsed: Duration, gliding: bool) -> bool {
    near(actual, after)
        || (gliding
            && elapsed < Duration::from_millis(450)
            && (before.min(after)..=before.max(after)).contains(&actual))
}

fn finish_locked(
    app: &AppHandle,
    api: &Api,
    active: &mut Option<Preview>,
    keep: bool,
    immediate: bool,
) -> Result<bool, String> {
    let Some(p) = active.as_mut() else {
        return Ok(false);
    };
    p.restoring |= !keep;
    if p.restoring {
        p.retry_at = Instant::now() + Duration::from_secs(1);
    }
    let Some(edition) = api.edition() else {
        return Err("Voicemeeter is unavailable.".into());
    };
    let elapsed = p.started.elapsed();
    let gain_layers_now = if edition == p.edition && p.changes.iter().any(|c| c.layers.is_some()) {
        Some(gain_layers(api, p.strip)?)
    } else {
        None
    };
    let own = |c: &Change| {
        edition == p.edition
            && api
                .get_float(&param(p.strip, c.field))
                .is_some_and(|v| is_preview_value(c, v, elapsed))
    };
    let layer_matches = |l: &LayerPreview, live: &[f32; LAYERS]| -> [bool; LAYERS] {
        std::array::from_fn(|i| owns_value(l.before[i], l.after[i], live[i], elapsed, true))
    };
    let accepted = !p.restoring
        && elapsed < AUDITION
        && p.changes.iter().all(|c| {
            own(c)
                && c.layers
                    .as_ref()
                    .zip(gain_layers_now.as_ref())
                    .is_none_or(|(layers, live)| layer_matches(layers, live).iter().all(|m| *m))
        });
    let mut error = None;
    if !accepted {
        p.restoring = true;
        let strip = p.strip;
        p.changes.reverse();
        p.changes.retain(|c| {
            let result =
                if let Some((layers, live)) = c.layers.as_ref().zip(gain_layers_now.as_ref()) {
                    let matches = layer_matches(layers, live);
                    let targets = std::array::from_fn(|i| {
                        if matches[i] {
                            layers.before[i]
                        } else {
                            live[i]
                        }
                    });
                    fades::glide_layers(app, api, strip, &targets, &matches, immediate).map(|()| {
                        if own(c) {
                            api.adopt_layers(strip, c.before, &targets);
                        }
                    })
                } else if own(c) {
                    write(app, api, strip, c.field, c.before, immediate)
                } else {
                    Ok(())
                };
            if let Err(err) = result {
                error = Some(err);
                return true;
            }
            false
        });
        p.changes.reverse();
        if let Some(err) = error {
            p.retry_at = Instant::now() + Duration::from_secs(1);
            return Err(err);
        }
    }
    *active = None;
    AUDITIONING.store(false, Ordering::Release);
    Ok(accepted)
}

pub fn finish(app: &AppHandle, keep: bool, immediate: bool) -> Result<bool, String> {
    let mut active = PREVIEW.lock().unwrap();
    if active.is_none() {
        return Ok(false);
    }
    let vm = app.state::<Vm>();
    finish_locked(app, api(&vm)?, &mut active, keep, immediate)
}

pub fn tick(app: &AppHandle, api: &Api) {
    if !AUDITIONING.load(Ordering::Acquire) {
        return;
    }
    let Ok(mut active) = PREVIEW.try_lock() else {
        return;
    };
    let Some(p) = active.as_mut() else { return };
    if Instant::now() < p.retry_at {
        return;
    }
    p.retry_at = Instant::now() + Duration::from_secs(1);
    let result = finish_locked(app, api, &mut active, false, false);
    if active.is_none() {
        let _ = app.emit_to("main", "mic-tune-ended", result.err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restoration_only_owns_the_audition_value_or_in_progress_gain_glide() {
        let gain = Change {
            field: "Gain",
            before: -10.0,
            after: -4.0,
            layers: None,
        };
        assert!(is_preview_value(&gain, -7.0, Duration::from_millis(200)));
        assert!(!is_preview_value(&gain, -7.0, Duration::from_millis(500)));
        assert!(!is_preview_value(&gain, 0.0, Duration::from_millis(200)));
        assert!(is_preview_value(&gain, -4.0, AUDITION));
        let gate = Change {
            field: "Gate",
            before: 0.0,
            after: 2.0,
            layers: None,
        };
        assert!(!is_preview_value(&gate, 1.0, Duration::from_millis(200)));
    }
}
