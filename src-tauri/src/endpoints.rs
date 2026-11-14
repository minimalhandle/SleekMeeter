//! Windows' list of audio endpoints, read from the registry Windows keeps of them: each one's
//! name, whether it's working, the format Windows runs it at ("48000 Hz, 2 channels") and the
//! driver it hangs off, which is how a Bluetooth headset is told apart from a cable.
//!
//! The crackle doctor (crackle.rs) compares the formats with Voicemeeter's, and the Bluetooth
//! watcher (btwatch.rs) finds headsets whose mic an app has opened.

/// One playback or recording endpoint.
#[derive(Clone, Debug, Default)]
pub struct Endpoint {
    /// Recording device (a mic) rather than playback.
    pub capture: bool,
    /// The registry key: the second half of Windows' endpoint id.
    pub guid: String,
    /// Working right now (plugged in, enabled).
    pub active: bool,
    /// "Headphones (FiiO K11)", as Windows' sound settings show it.
    pub full: String,
    /// The driver path ("{1}.BTHENUM\…", "{1}.USB\VID_…").
    pub path: String,
    /// The sample rate Windows runs the device at in shared mode.
    pub rate: Option<u32>,
}

impl Endpoint {
    /// The id Windows' audio API uses for this endpoint.
    pub fn id(&self) -> String {
        let flow = if self.capture { 1 } else { 0 };
        format!("{{0.0.{flow}.00000000}}.{}", self.guid)
    }

    /// Bluetooth audio (classic stereo, hands-free or LE Audio). A USB dongle that talks
    /// Bluetooth itself looks like any USB headset to Windows, so it isn't counted.
    pub fn is_bluetooth(&self) -> bool {
        is_bluetooth_path(&self.path) || self.full.to_lowercase().contains("hands-free")
    }
}

/// Windows' driver paths for Bluetooth audio: BTHENUM (stereo, and the newer combined
/// endpoint), BTHHFENUM (hands-free), BTHLEDEVICE / BTHLE (LE Audio).
pub fn is_bluetooth_path(path: &str) -> bool {
    let p = path.to_uppercase();
    ["BTHENUM", "BTHHFENUM", "BTHLE"]
        .iter()
        .any(|k| p.contains(k))
}

/// Rate and channel count from the device-format property. In the registry it's a property
/// value: 8 bytes of header (the value's type and flags) and then a WAVEFORMATEX. Plain
/// WAVEFORMATEX bytes work too.
pub fn parse_format(bytes: &[u8]) -> Option<(u32, u16)> {
    let read = |b: &[u8]| -> Option<(u32, u16)> {
        if b.len() < 16 {
            return None;
        }
        let tag = u16::from_le_bytes([b[0], b[1]]);
        // PCM, IEEE float, or WAVE_FORMAT_EXTENSIBLE
        if !matches!(tag, 1 | 3 | 0xFFFE) {
            return None;
        }
        let channels = u16::from_le_bytes([b[2], b[3]]);
        let rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
        ((8000..=768_000).contains(&rate) && (1..=32).contains(&channels))
            .then_some((rate, channels))
    };
    if bytes.len() >= 24 && bytes[0] == 0x41 && bytes[1..4] == [0, 0, 0] {
        if let Some(f) = read(&bytes[8..]) {
            return Some(f);
        }
    }
    read(bytes)
}

/// Every endpoint Windows knows (working or not).
#[cfg(windows)]
pub fn list() -> Vec<Endpoint> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    const ROOT: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio";
    const DESC: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2"; // "Headphones"
    const ADAPTER: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6"; // "FiiO K11"
    const PATH: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},2"; // "{1}.USB\VID_…"
    const FORMAT: &str = "{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0"; // PKEY_AudioEngine_DeviceFormat
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut out = Vec::new();
    for (flow, capture) in [("Render", false), ("Capture", true)] {
        let Ok(list) = hklm.open_subkey_with_flags(format!(r"{ROOT}\{flow}"), KEY_READ) else {
            continue;
        };
        for guid in list.enum_keys().flatten() {
            let Ok(dev) = list.open_subkey_with_flags(&guid, KEY_READ) else {
                continue;
            };
            // 1 = active; 2 disabled, 4 not present, 8 unplugged
            let active = dev.get_value::<u32, _>("DeviceState").unwrap_or(0) == 1;
            let Ok(props) = dev.open_subkey_with_flags("Properties", KEY_READ) else {
                continue;
            };
            let desc: String = props.get_value(DESC).unwrap_or_default();
            let adapter: String = props.get_value(ADAPTER).unwrap_or_default();
            let full = match (desc.is_empty(), adapter.is_empty()) {
                (false, false) => format!("{desc} ({adapter})"),
                (true, false) => adapter,
                (false, true) => desc,
                _ => continue,
            };
            let format = props
                .get_raw_value(FORMAT)
                .ok()
                .and_then(|v| parse_format(&v.bytes));
            out.push(Endpoint {
                capture,
                guid,
                active,
                full,
                path: props.get_value(PATH).unwrap_or_default(),
                rate: format.map(|f| f.0),
            });
        }
    }
    out
}

#[cfg(not(windows))]
pub fn list() -> Vec<Endpoint> {
    Vec::new()
}

/// The working endpoint Voicemeeter's device name `assigned` means, if Windows lists it.
/// Recording devices for inputs, playback devices for outputs.
pub fn find<'a>(list: &'a [Endpoint], assigned: &str, capture: bool) -> Option<&'a Endpoint> {
    let matching =
        |e: &&Endpoint| e.capture == capture && crate::devwatch::same_device(assigned, &e.full);
    list.iter()
        .filter(|e| e.active)
        .find(matching)
        .or_else(|| list.iter().find(matching))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_registry_format_value() {
        // As Windows stores it: VT_BLOB header, then WAVEFORMATEXTENSIBLE, 2 ch at 48 kHz.
        let v = [
            0x41, 0, 0, 0, 1, 0, 0, 0, 0xfe, 0xff, 2, 0, 0x80, 0xbb, 0, 0, 0, 0x65, 4, 0, 6, 0,
            0x18, 0,
        ];
        assert_eq!(parse_format(&v), Some((48000, 2)));
        // 44.1 kHz
        let v = [
            0x41, 0, 0, 0, 1, 0, 0, 0, 0xfe, 0xff, 2, 0, 0x44, 0xac, 0, 0, 0x98, 9, 4, 0, 6, 0,
            0x18, 0,
        ];
        assert_eq!(parse_format(&v), Some((44100, 2)));
        // A mono 16 kHz hands-free mic, as plain WAVEFORMATEX.
        let v = [1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0];
        assert_eq!(parse_format(&v), Some((16000, 1)));
        assert_eq!(parse_format(&[0x41, 0, 0, 0]), None);
        assert_eq!(parse_format(&[9; 24]), None);
    }

    #[test]
    fn tells_bluetooth_from_usb() {
        assert!(is_bluetooth_path(
            r"{1}.BTHENUM\{0000110b-0000-1000-8000-00805f9b34fb}_VID&0001"
        ));
        assert!(is_bluetooth_path(r"{1}.BTHHFENUM\BthHFPAudio\8&2a"));
        assert!(is_bluetooth_path(r"{1}.BTHLEDEVICE\{0000184e}"));
        assert!(!is_bluetooth_path(
            r"{1}.USB\VID_3542&PID_3001&MI_02\9&25C9461A&0&0002"
        ));
        assert!(!is_bluetooth_path(r"{1}.ROOT\MEDIA\0000"));
        let e = Endpoint {
            full: "Headset (WH-1000XM4 Hands-Free AG Audio)".into(),
            ..Default::default()
        };
        assert!(e.is_bluetooth());
    }

    #[test]
    fn endpoint_ids_follow_the_flow() {
        let mut e = Endpoint {
            guid: "{abc}".into(),
            ..Default::default()
        };
        assert_eq!(e.id(), "{0.0.0.00000000}.{abc}");
        e.capture = true;
        assert_eq!(e.id(), "{0.0.1.00000000}.{abc}");
    }
}

/// Prints what Windows reports on this PC: `cargo test endpoints_on_this_pc -- --ignored --nocapture`.
#[cfg(all(test, windows))]
mod this_pc {
    #[test]
    #[ignore]
    fn endpoints_on_this_pc() {
        for e in super::list().iter().filter(|e| e.active) {
            println!(
                "{} {:>6} bt={} {}",
                if e.capture { "rec " } else { "play" },
                e.rate.map(|r| r.to_string()).unwrap_or_default(),
                e.is_bluetooth(),
                e.full
            );
        }
        println!("power plan: {:?}", crate::crackle::power_plan_for_test());
        println!("bluetooth mics in use: {:?}", crate::btwatch::scan_for_test());
    }
}
