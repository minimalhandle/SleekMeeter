//! Thin, safe wrapper around VoicemeeterRemote64.dll (the official Voicemeeter Remote API).
//!
//! The DLL ships with Voicemeeter itself. We find it through the same registry key the
//! SDK example uses (VB:Voicemeeter {17359A74-1236-5467} → UninstallString), load it at
//! runtime and resolve the handful of VBVMR_* functions the mixer needs.
//! Per the SDK docs every call is thread-safe and non-blocking, except GetLevel, which
//! must only be called from one thread (our poll thread).

use libloading::Library;
use serde_json::{json, Value};
use std::ffi::{c_char, CString};
use std::path::{Path, PathBuf};

type FnVoid = unsafe extern "system" fn() -> i32;
type FnLongIn = unsafe extern "system" fn(i32) -> i32;
type FnLongOut = unsafe extern "system" fn(*mut i32) -> i32;
type FnGetFloat = unsafe extern "system" fn(*const c_char, *mut f32) -> i32;
type FnGetStringW = unsafe extern "system" fn(*const c_char, *mut u16) -> i32;
type FnGetLevel = unsafe extern "system" fn(i32, i32, *mut f32) -> i32;
type FnSetFloat = unsafe extern "system" fn(*const c_char, f32) -> i32;
type FnSetStringW = unsafe extern "system" fn(*const c_char, *const u16) -> i32;
type FnDevDescW = unsafe extern "system" fn(i32, *mut i32, *mut u16, *mut u16) -> i32;

/// Bus modes Voicemeeter Banana offers (Bus[i].mode.<name>).
pub const BUS_MODES: &[&str] = &[
    "normal",
    "Amix",
    "Bmix",
    "Repeat",
    "Composite",
    "TVMix",
    "UpMix21",
    "UpMix41",
    "UpMix61",
    "CenterOnly",
    "LFEOnly",
    "RearOnly",
];

pub struct Api {
    _lib: Library,
    login: FnVoid,
    logout: FnVoid,
    run: FnLongIn,
    get_type: FnLongOut,
    get_version: FnLongOut,
    is_dirty: FnVoid,
    get_float: FnGetFloat,
    get_string_w: FnGetStringW,
    get_level: FnGetLevel,
    set_float: FnSetFloat,
    set_string_w: FnSetStringW,
    in_dev_count: FnVoid,
    in_dev_desc: FnDevDescW,
    out_dev_count: FnVoid,
    out_dev_desc: FnDevDescW,
}

/// Strip/bus counts for each Voicemeeter edition (from VoicemeeterRemote.h).
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub hw_strips: usize,
    pub virt_strips: usize,
    pub hw_buses: usize,
    pub virt_buses: usize,
}

impl Layout {
    pub fn for_edition(edition: i32) -> Layout {
        match edition {
            1 => Layout {
                hw_strips: 2,
                virt_strips: 1,
                hw_buses: 1,
                virt_buses: 1,
            },
            3 => Layout {
                hw_strips: 5,
                virt_strips: 3,
                hw_buses: 5,
                virt_buses: 3,
            },
            _ => Layout {
                hw_strips: 3,
                virt_strips: 2,
                hw_buses: 3,
                virt_buses: 2,
            }, // Banana
        }
    }
    pub fn strips(&self) -> usize {
        self.hw_strips + self.virt_strips
    }
    pub fn buses(&self) -> usize {
        self.hw_buses + self.virt_buses
    }
}

fn err_text(code: i32) -> String {
    match code {
        -1 => "Voicemeeter reported an error".into(),
        -2 => "Voicemeeter isn't running".into(),
        -3 => "Voicemeeter doesn't know that setting".into(),
        n => format!("Voicemeeter returned error {n}"),
    }
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "Setting names can't contain null characters".to_string())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Folder where Voicemeeter is installed, read from its uninstall registry key.
#[cfg(windows)]
pub fn install_dir() -> Option<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;
    const KEY: &str =
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(KEY, KEY_READ)
        .or_else(|_| hklm.open_subkey_with_flags(KEY, KEY_READ | KEY_WOW64_32KEY))
        .ok()?;
    let uninstall: String = key.get_value("UninstallString").ok()?;
    let uninstall = uninstall.trim().trim_matches('"');
    Path::new(uninstall).parent().map(Path::to_path_buf)
}

#[cfg(not(windows))]
pub fn install_dir() -> Option<PathBuf> {
    None
}

impl Api {
    /// Load the DLL from the Voicemeeter install folder. `None` means Voicemeeter isn't installed.
    pub fn load() -> Option<Api> {
        let dir = install_dir()?;
        let dll = if cfg!(target_pointer_width = "64") {
            "VoicemeeterRemote64.dll"
        } else {
            "VoicemeeterRemote.dll"
        };
        Self::load_from(&dir.join(dll)).ok()
    }

    fn load_from(path: &Path) -> Result<Api, libloading::Error> {
        unsafe {
            let lib = Library::new(path)?;
            macro_rules! sym {
                ($name:literal, $t:ty) => {
                    *lib.get::<$t>(concat!($name, "\0").as_bytes())?
                };
            }
            // Copy every function pointer out first; the Library must outlive them,
            // which it does because it is stored in the same struct.
            let login = sym!("VBVMR_Login", FnVoid);
            let logout = sym!("VBVMR_Logout", FnVoid);
            let run = sym!("VBVMR_RunVoicemeeter", FnLongIn);
            let get_type = sym!("VBVMR_GetVoicemeeterType", FnLongOut);
            let get_version = sym!("VBVMR_GetVoicemeeterVersion", FnLongOut);
            let is_dirty = sym!("VBVMR_IsParametersDirty", FnVoid);
            let get_float = sym!("VBVMR_GetParameterFloat", FnGetFloat);
            let get_string_w = sym!("VBVMR_GetParameterStringW", FnGetStringW);
            let get_level = sym!("VBVMR_GetLevel", FnGetLevel);
            let set_float = sym!("VBVMR_SetParameterFloat", FnSetFloat);
            let set_string_w = sym!("VBVMR_SetParameterStringW", FnSetStringW);
            let in_dev_count = sym!("VBVMR_Input_GetDeviceNumber", FnVoid);
            let in_dev_desc = sym!("VBVMR_Input_GetDeviceDescW", FnDevDescW);
            let out_dev_count = sym!("VBVMR_Output_GetDeviceNumber", FnVoid);
            let out_dev_desc = sym!("VBVMR_Output_GetDeviceDescW", FnDevDescW);
            Ok(Api {
                in_dev_count,
                in_dev_desc,
                out_dev_count,
                out_dev_desc,
                _lib: lib,
                login,
                logout,
                run,
                get_type,
                get_version,
                is_dirty,
                get_float,
                get_string_w,
                get_level,
                set_float,
                set_string_w,
            })
        }
    }

    /// Call once at startup. Works whether or not Voicemeeter is running.
    pub fn login(&self) -> i32 {
        unsafe { (self.login)() }
    }
    /// Call once at exit.
    pub fn logout(&self) -> i32 {
        unsafe { (self.logout)() }
    }

    /// 1 = something changed, 0 = nothing changed, < 0 = Voicemeeter not reachable.
    pub fn is_dirty(&self) -> i32 {
        unsafe { (self.is_dirty)() }
    }

    pub fn edition(&self) -> Option<i32> {
        let mut t = 0;
        (unsafe { (self.get_type)(&mut t) } == 0).then_some(t)
    }

    pub fn version(&self) -> Option<String> {
        let mut v = 0i32;
        if unsafe { (self.get_version)(&mut v) } != 0 {
            return None;
        }
        let v = v as u32;
        Some(format!(
            "{}.{}.{}.{}",
            v >> 24,
            (v >> 16) & 0xff,
            (v >> 8) & 0xff,
            v & 0xff
        ))
    }

    /// Start Voicemeeter. Tries the 64-bit build of the given edition first.
    pub fn run(&self, edition: i32) -> Result<(), String> {
        let first = unsafe { (self.run)(edition + 3) };
        if first == 0 {
            return Ok(());
        }
        match unsafe { (self.run)(edition) } {
            0 => Ok(()),
            -1 => Err("Voicemeeter isn't installed".into()),
            n => Err(format!("Couldn't start Voicemeeter (error {n})")),
        }
    }

    pub fn get_float(&self, name: &str) -> Option<f32> {
        let n = cstr(name).ok()?;
        let mut v = 0f32;
        (unsafe { (self.get_float)(n.as_ptr(), &mut v) } == 0).then_some(v)
    }

    pub fn get_bool(&self, name: &str) -> bool {
        self.get_float(name).map(|v| v != 0.0).unwrap_or(false)
    }

    pub fn get_string(&self, name: &str) -> Option<String> {
        let n = cstr(name).ok()?;
        let mut buf = [0u16; 512];
        if unsafe { (self.get_string_w)(n.as_ptr(), buf.as_mut_ptr()) } != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    pub fn set_float(&self, name: &str, value: f32) -> Result<(), String> {
        let n = cstr(name)?;
        match unsafe { (self.set_float)(n.as_ptr(), value) } {
            0 => Ok(()),
            e => Err(err_text(e)),
        }
    }

    pub fn set_string(&self, name: &str, value: &str) -> Result<(), String> {
        let n = cstr(name)?;
        let w = wide(value);
        match unsafe { (self.set_string_w)(n.as_ptr(), w.as_ptr()) } {
            0 => Ok(()),
            e => Err(err_text(e)),
        }
    }

    /// Read the current value, add `delta`, clamp and write it back (used by hotkeys).
    pub fn nudge(&self, name: &str, delta: f32, min: f32, max: f32) -> Result<f32, String> {
        let v = (self.get_float(name).unwrap_or(0.0) + delta).clamp(min, max);
        self.set_float(name, v)?;
        Ok(v)
    }

    /// Flip a 0/1 parameter (used by hotkeys).
    pub fn toggle(&self, name: &str) -> Result<bool, String> {
        let on = !self.get_bool(name);
        self.set_float(name, if on { 1.0 } else { 0.0 })?;
        Ok(on)
    }

    /// Audio devices Voicemeeter can use, as [{ type: "wdm" | "ks" | "mme" | "asio", name }].
    pub fn devices(&self) -> Value {
        let list = |count: FnVoid, desc: FnDevDescW| -> Vec<Value> {
            let n = unsafe { count() }.max(0);
            let mut out = Vec::new();
            for i in 0..n {
                let mut kind = 0i32;
                let mut name = [0u16; 512];
                let mut hw = [0u16; 512];
                if unsafe { desc(i, &mut kind, name.as_mut_ptr(), hw.as_mut_ptr()) } != 0 {
                    continue;
                }
                let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
                let name = String::from_utf16_lossy(&name[..end]);
                let kind = match kind {
                    1 => "mme",
                    3 => "wdm",
                    4 => "ks",
                    5 => "asio",
                    _ => continue,
                };
                if !name.is_empty() {
                    out.push(json!({ "type": kind, "name": name }));
                }
            }
            out
        };
        json!({
            "inputs": list(self.in_dev_count, self.in_dev_desc),
            "outputs": list(self.out_dev_count, self.out_dev_desc),
        })
    }

    /// Linear level → dBFS. kind: 1 = post-fader input, 3 = output.
    fn level_db(&self, kind: i32, channel: usize) -> f32 {
        let mut v = 0f32;
        if unsafe { (self.get_level)(kind, channel as i32, &mut v) } != 0 || v <= 1e-6 {
            return -200.0;
        }
        20.0 * v.log10()
    }

    /// [left, right] dBFS of a channel block: max of even channels / max of odd channels,
    /// so 8-channel virtual strips and buses still read as a stereo pair.
    fn pair(&self, kind: i32, base: usize, count: usize) -> [f32; 2] {
        let mut lr = [-200f32; 2];
        for c in 0..count {
            let db = self.level_db(kind, base + c);
            let side = c % 2;
            if db > lr[side] {
                lr[side] = db;
            }
        }
        lr
    }

    /// Meter data for every strip and bus. Must be called from the poll thread only.
    pub fn levels(&self, layout: &Layout) -> Value {
        let mut inputs = Vec::new();
        let mut ch = 0;
        for _ in 0..layout.hw_strips {
            inputs.push(self.pair(1, ch, 2));
            ch += 2;
        }
        for _ in 0..layout.virt_strips {
            inputs.push(self.pair(1, ch, 8));
            ch += 8;
        }
        let outputs: Vec<[f32; 2]> = (0..layout.buses())
            .map(|j| self.pair(3, j * 8, 8))
            .collect();
        json!({ "inputs": inputs, "outputs": outputs })
    }

    /// Full mixer snapshot in the shape the UI expects.
    pub fn snapshot(&self, edition: i32) -> Value {
        let l = Layout::for_edition(edition);
        let round = |v: Option<f32>| (v.unwrap_or(0.0) * 100.0).round() / 100.0;

        let strips: Vec<Value> = (0..l.strips())
            .map(|i| {
                let p = |k: &str| format!("Strip[{i}].{k}");
                let hw = i < l.hw_strips;
                let a: Vec<u8> = (1..=l.hw_buses).map(|k| self.get_bool(&p(&format!("A{k}"))) as u8).collect();
                let b: Vec<u8> = (1..=l.virt_buses).map(|k| self.get_bool(&p(&format!("B{k}"))) as u8).collect();
                let eq: Vec<f32> = if hw {
                    Vec::new()
                } else {
                    (1..=3).map(|k| round(self.get_float(&p(&format!("EQGain{k}"))))).collect()
                };
                json!({
                    "label": self.get_string(&p("Label")).unwrap_or_default(),
                    "device": if hw { self.get_string(&p("device.name")).unwrap_or_default() } else { String::new() },
                    "gain": round(self.get_float(&p("Gain"))),
                    "mute": self.get_bool(&p("Mute")),
                    "solo": self.get_bool(&p("Solo")),
                    "mono": self.get_bool(&p("Mono")),
                    "mc": self.get_bool(&p("MC")),
                    "a": a,
                    "b": b,
                    "pan": round(self.get_float(&p("Pan_x"))),
                    "comp": round(self.get_float(&p("Comp"))),
                    "gate": round(self.get_float(&p("Gate"))),
                    "eq": eq,
                })
            })
            .collect();

        let buses: Vec<Value> = (0..l.buses())
            .map(|j| {
                let p = |k: &str| format!("Bus[{j}].{k}");
                let hw = j < l.hw_buses;
                json!({
                    "label": self.get_string(&p("Label")).unwrap_or_default(),
                    "device": if hw { self.get_string(&p("device.name")).unwrap_or_default() } else { String::new() },
                    "gain": round(self.get_float(&p("Gain"))),
                    "mute": self.get_bool(&p("Mute")),
                    "mono": self.get_bool(&p("Mono")),
                    "eq": self.get_bool(&p("EQ.on")),
                    "mode": BUS_MODES.iter().find(|m| self.get_bool(&p(&format!("mode.{m}")))).copied().unwrap_or("normal"),
                })
            })
            .collect();

        json!({
            "installed": true,
            "connected": true,
            "edition": edition,
            "version": self.version().unwrap_or_default(),
            "strips": strips,
            "buses": buses,
        })
    }
}
