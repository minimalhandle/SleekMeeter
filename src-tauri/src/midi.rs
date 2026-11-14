//! MIDI controllers: faders and knobs move a channel's level, and buttons or pads run the same
//! actions as shortcuts (mute, a scene, a sound, Be right back...). Settings → Controls → MIDI
//! controller learns each control: press Add, then move or press it.
//!
//! Sleekmeeter opens only the controllers its mappings use (all of them while learning), so a
//! keyboard you play in a music app stays free. Windows lets one app at a time open a MIDI
//! device, so a controller that Voicemeeter's own MIDI mapping holds shows as in use.
//!
//! Faders pick up: one that's far from the channel's level does nothing until it passes it, so
//! the level never jumps when you first touch it.

use crate::{actions, fades, Settings, Vm};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// One message from a controller, as Sleekmeeter uses it.
#[derive(Clone, Debug, PartialEq)]
pub struct Control {
    /// "cc" (most faders, knobs and buttons), "note" (pads and keys), "pb" (pitch bend, which
    /// motor faders on Mackie-style controllers send).
    pub kind: &'static str,
    /// MIDI channel, 0 to 15.
    pub ch: u8,
    /// Controller or note number (0 for pitch bend).
    pub num: u8,
    /// 0 to 1.
    pub value: f32,
    /// For buttons: pressed (note on, CC 64 and up) or released.
    pub pressed: bool,
}

/// Read a short MIDI message as winmm packs it: status | data1 << 8 | data2 << 16.
pub fn parse(m: u32) -> Option<Control> {
    let status = (m & 0xff) as u8;
    let d1 = ((m >> 8) & 0x7f) as u8;
    let d2 = ((m >> 16) & 0x7f) as u8;
    let ch = status & 0x0f;
    match status & 0xf0 {
        0xB0 => Some(Control {
            kind: "cc",
            ch,
            num: d1,
            value: d2 as f32 / 127.0,
            pressed: d2 >= 64,
        }),
        0x90 if d2 > 0 => Some(Control {
            kind: "note",
            ch,
            num: d1,
            value: d2 as f32 / 127.0,
            pressed: true,
        }),
        0x90 | 0x80 => Some(Control {
            kind: "note",
            ch,
            num: d1,
            value: 0.0,
            pressed: false,
        }),
        0xE0 => {
            let v = ((d2 as u32) << 7) | d1 as u32;
            Some(Control {
                kind: "pb",
                ch,
                num: 0,
                value: v as f32 / 16383.0,
                pressed: false,
            })
        }
        _ => None,
    }
}

/// The mixer's fader curve (app.js TAPER): a fader position 0..1 to dB, so a hardware fader
/// halfway up sits where the on-screen one does.
const TAPER: [(f32, f32); 6] = [
    (-60.0, 0.0),
    (-40.0, 0.17),
    (-20.0, 0.44),
    (-10.0, 0.64),
    (0.0, 0.84),
    (12.0, 1.0),
];

pub fn pos_to_db(p: f32) -> f32 {
    let p = p.clamp(0.0, 1.0);
    for w in TAPER.windows(2) {
        let ((d0, p0), (d1, p1)) = (w[0], w[1]);
        if p <= p1 {
            let db = d0 + (p - p0) / (p1 - p0) * (d1 - d0);
            return (db * 10.0).round() / 10.0;
        }
    }
    12.0
}

/// One mapping from Settings: `{ dev, kind, ch, num, action, target }`. `dev` "" = any device.
#[derive(Clone, Debug, PartialEq)]
struct Map {
    dev: String,
    kind: String,
    ch: u8,
    num: u8,
    action: String,
    target: String,
}

fn maps(s: &Value) -> Vec<Map> {
    s["midi"]["maps"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(Map {
                        dev: m["dev"].as_str().unwrap_or("").to_string(),
                        kind: m["kind"].as_str()?.to_string(),
                        ch: m["ch"].as_u64()? as u8,
                        num: m["num"].as_u64().unwrap_or(0) as u8,
                        action: m["action"].as_str()?.to_string(),
                        target: m["target"].as_str().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Soft takeover for one fader.
#[derive(Default)]
struct Pickup {
    picked: bool,
    last_want: Option<f32>,
    /// The level Sleekmeeter set last; a different level means someone else moved it.
    last_set: Option<f32>,
}

/// Should this fader move the level yet? Picks up within 1.5 dB, or when it passes the level.
fn pick_up(p: &mut Pickup, want: f32, current: f32) -> bool {
    if let Some(set) = p.last_set {
        if (current - set).abs() > 0.6 {
            p.picked = false;
            p.last_set = None;
        }
    }
    if !p.picked {
        let crossed = p
            .last_want
            .is_some_and(|prev| (prev - current).signum() != (want - current).signum());
        if (want - current).abs() <= 1.5 || crossed {
            p.picked = true;
        }
    }
    p.last_want = Some(want);
    p.picked
}

static TX: Mutex<Option<Sender<(usize, u32)>>> = Mutex::new(None);
/// Device names by the index winmm opened them with.
static NAMES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static LEARNING: AtomicBool = AtomicBool::new(false);
static STATUS: Mutex<Value> = Mutex::new(Value::Null);

/// `{ on, devices: [{ name, open, error }] }` for Settings.
pub fn status() -> Value {
    let s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        json!({ "on": false, "devices": [] })
    } else {
        s
    }
}

/// Start or stop learning: the next control moved is sent to the UI as "midi-learned".
pub fn learn(on: bool) {
    LEARNING.store(on, Ordering::Relaxed);
}

pub fn spawn(app: AppHandle) {
    let (tx, rx) = channel();
    *TX.lock().unwrap() = Some(tx);
    let devices_app = app.clone();
    std::thread::spawn(move || device_loop(devices_app));
    std::thread::spawn(move || handle_loop(app, rx));
}

/// Open the controllers the mappings use (every one while learning), and keep them open.
fn device_loop(app: AppHandle) {
    #[cfg(windows)]
    {
        let mut open: Vec<(String, imp::Port)> = Vec::new();
        // Why a device couldn't be opened, and when that was (it's tried again after 10 s).
        let mut errors: HashMap<String, (String, Instant)> = HashMap::new();
        let mut names_seen: Vec<String> = Vec::new();
        loop {
            let (on, wanted_devs) = {
                let state = app.state::<Settings>();
                let s = state.0.lock().unwrap();
                let on = s["midi"]["on"].as_bool().unwrap_or(false);
                (on, maps(&s).into_iter().map(|m| m.dev).collect::<Vec<_>>())
            };
            let names = imp::names();
            if names != names_seen {
                // Plugged in or out: indexes may have moved, so open everything again.
                open.clear();
                errors.clear();
                *NAMES.lock().unwrap() = names.clone();
                names_seen = names.clone();
            }
            let learning = LEARNING.load(Ordering::Relaxed);
            let want =
                |n: &String| on && (learning || wanted_devs.iter().any(|d| d.is_empty() || d == n));
            open.retain(|(n, _)| want(n));
            for (i, n) in names.iter().enumerate() {
                let waiting = errors
                    .get(n)
                    .is_some_and(|(_, at)| at.elapsed() < Duration::from_secs(10));
                if !want(n) || open.iter().any(|(o, _)| o == n) || (waiting && !learning) {
                    continue;
                }
                match imp::open(i) {
                    Ok(p) => {
                        log_info!("MIDI: listening to {n}");
                        errors.remove(n);
                        open.push((n.clone(), p));
                    }
                    Err(e) => {
                        if errors.get(n).map(|(m, _)| m) != Some(&e) {
                            log_warn!("MIDI: couldn't open {n}: {e}");
                        }
                        errors.insert(n.clone(), (e, Instant::now()));
                    }
                }
            }
            if !on {
                errors.clear();
            }
            let devices: Vec<Value> = names
                .iter()
                .map(|n| {
                    json!({
                        "name": n,
                        "open": open.iter().any(|(o, _)| o == n),
                        "error": errors.get(n).map(|(m, _)| m.clone()).unwrap_or_default(),
                    })
                })
                .collect();
            *STATUS.lock().unwrap() = json!({ "on": on, "devices": devices });
            // Look again every second: for new devices, settings and learning.
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// Turn messages into level changes and actions.
fn handle_loop(app: AppHandle, rx: Receiver<(usize, u32)>) {
    let mut pickups: HashMap<String, Pickup> = HashMap::new();
    let mut held: HashMap<String, bool> = HashMap::new();
    let mut cached: (Instant, Vec<Map>) = (Instant::now() - Duration::from_secs(10), Vec::new());
    for (index, raw) in rx {
        let Some(c) = parse(raw) else { continue };
        let dev = NAMES
            .lock()
            .unwrap()
            .get(index)
            .cloned()
            .unwrap_or_default();
        if LEARNING.load(Ordering::Relaxed) {
            // A note off or a button let go isn't something to learn.
            if c.kind == "note" && !c.pressed {
                continue;
            }
            LEARNING.store(false, Ordering::Relaxed);
            let _ = app.emit(
                "midi-learned",
                json!({ "dev": dev, "kind": c.kind, "ch": c.ch, "num": c.num }),
            );
            continue;
        }
        if cached.0.elapsed() > Duration::from_millis(500) {
            let state = app.state::<Settings>();
            let s = state.0.lock().unwrap();
            cached = (
                Instant::now(),
                if s["midi"]["on"].as_bool().unwrap_or(false) {
                    maps(&s)
                } else {
                    Vec::new()
                },
            );
        }
        for m in cached.1.iter().filter(|m| {
            m.kind == c.kind && m.ch == c.ch && m.num == c.num && (m.dev.is_empty() || m.dev == dev)
        }) {
            let key = format!("{}|{}|{}|{}|{}", m.dev, m.kind, m.ch, m.num, m.target);
            if m.action == "fader" {
                if !(m.target.starts_with("Strip[") || m.target.starts_with("Bus[")) {
                    continue;
                }
                let Some(api) = app.state::<Vm>().api.clone() else {
                    continue;
                };
                let gain = format!("{}.Gain", m.target);
                let want = pos_to_db(c.value);
                let current = api.get_float(&gain).unwrap_or(0.0);
                let p = pickups.entry(key).or_default();
                if pick_up(p, want, current) && (want - current).abs() >= 0.05 {
                    match fades::set_float(&app, &api, &gain, want) {
                        Ok(()) => p.last_set = Some(want),
                        Err(e) => log_warn!("MIDI: {e}"),
                    }
                }
                continue;
            }
            // Buttons: act once per press (a CC button sends a value when pressed and again
            // when let go).
            let was = held.insert(key, c.pressed).unwrap_or(false);
            if c.pressed && (!was || c.kind == "note") {
                if let Err(e) = actions::perform(&app, &m.action, &m.target) {
                    log_warn!("MIDI: {e}");
                }
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::TX;
    use windows_sys::Win32::Media::Audio::{
        midiInClose, midiInGetDevCapsW, midiInGetNumDevs, midiInOpen, midiInReset, midiInStart,
        midiInStop, CALLBACK_FUNCTION, HMIDIIN, MIDIINCAPSW,
    };

    const MIM_DATA: u32 = 0x3C3;
    const MMSYSERR_ALLOCATED: u32 = 4;

    pub fn count() -> usize {
        unsafe { midiInGetNumDevs() as usize }
    }

    pub fn names() -> Vec<String> {
        (0..count())
            .map(|i| {
                let mut caps: MIDIINCAPSW = unsafe { std::mem::zeroed() };
                let r = unsafe {
                    midiInGetDevCapsW(i, &mut caps, std::mem::size_of::<MIDIINCAPSW>() as u32)
                };
                if r != 0 {
                    return format!("MIDI device {}", i + 1);
                }
                let name = caps.szPname;
                let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
                String::from_utf16_lossy(&name[..end])
            })
            .collect()
    }

    /// Runs on winmm's thread: hand the message on and return straight away.
    unsafe extern "system" fn on_midi(
        _h: HMIDIIN,
        msg: u32,
        instance: usize,
        p1: usize,
        _p2: usize,
    ) {
        if msg == MIM_DATA {
            if let Ok(tx) = TX.try_lock() {
                if let Some(tx) = tx.as_ref() {
                    let _ = tx.send((instance, p1 as u32));
                }
            }
        }
    }

    pub struct Port(HMIDIIN);
    // The handle is only used to close the device, from whichever thread owns the Port.
    unsafe impl Send for Port {}

    impl Drop for Port {
        fn drop(&mut self) {
            unsafe {
                midiInStop(self.0);
                midiInReset(self.0);
                midiInClose(self.0);
            }
        }
    }

    pub fn open(index: usize) -> Result<Port, String> {
        let mut h: HMIDIIN = std::ptr::null_mut();
        let r = unsafe {
            midiInOpen(
                &mut h,
                index as u32,
                on_midi as *const () as usize,
                index,
                CALLBACK_FUNCTION,
            )
        };
        match r {
            0 => {}
            MMSYSERR_ALLOCATED => {
                return Err("Another app is using it. If that's Voicemeeter, set its MIDI Mapping input to none.".into())
            }
            n => return Err(format!("Windows couldn't open it (error {n})")),
        }
        let port = Port(h);
        if unsafe { midiInStart(h) } != 0 {
            return Err("Windows couldn't start it".into());
        }
        Ok(port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_read_as_controls() {
        // CC 7 on channel 1 at 127.
        let c = parse(0xB0 | 7 << 8 | 127 << 16).unwrap();
        assert_eq!(
            (c.kind, c.ch, c.num, c.value, c.pressed),
            ("cc", 0, 7, 1.0, true)
        );
        // Note 36 on channel 10, then the same note with velocity 0 (a note off).
        let on = parse(0x99 | 36 << 8 | 100 << 16).unwrap();
        assert_eq!((on.kind, on.ch, on.num, on.pressed), ("note", 9, 36, true));
        assert!(!parse(0x99 | 36 << 8).unwrap().pressed);
        assert!(!parse(0x89 | 36 << 8 | 64 << 16).unwrap().pressed);
        // Pitch bend at full scale, and clock messages are ignored.
        assert_eq!(parse(0xE2 | 0x7f << 8 | 0x7f << 16).unwrap().value, 1.0);
        assert!(parse(0xF8).is_none());
    }

    #[test]
    fn fader_positions_follow_the_mixer_curve() {
        assert_eq!(pos_to_db(0.0), -60.0);
        assert_eq!(pos_to_db(0.84), 0.0);
        assert_eq!(pos_to_db(1.0), 12.0);
        assert_eq!(pos_to_db(0.44), -20.0);
    }

    #[test]
    fn a_far_away_fader_waits_until_it_reaches_the_level() {
        let mut p = Pickup::default();
        // The channel is at -10 dB; the hardware fader starts at the bottom.
        assert!(!pick_up(&mut p, -60.0, -10.0));
        assert!(!pick_up(&mut p, -30.0, -10.0));
        // Passing the level picks it up.
        assert!(pick_up(&mut p, -5.0, -10.0));
        p.last_set = Some(-5.0);
        assert!(pick_up(&mut p, -4.0, -5.0));
        // Someone moves the level elsewhere: the fader waits again.
        assert!(!pick_up(&mut p, -3.0, -20.0));
    }

    #[test]
    fn mappings_are_read_from_settings() {
        let s = json!({ "midi": { "maps": [
            { "dev": "nanoKONTROL2", "kind": "cc", "ch": 0, "num": 0, "action": "fader", "target": "Strip[0]" },
            { "kind": "note", "ch": 9, "num": 36, "action": "brb", "target": "" },
            { "kind": "cc" }
        ] } });
        let m = maps(&s);
        assert_eq!(m.len(), 2);
        assert_eq!(m[1].dev, "");
        assert_eq!(m[0].target, "Strip[0]");
    }
}
