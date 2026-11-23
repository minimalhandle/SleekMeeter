//! Sleekmeeter Remote: a small web server on your own network that works the mixer. It serves
//! the phone page and the OBS overlay, and the HTTP API the Stream Deck plugin uses.
//!
//! Off by default. When it's on, Sleekmeeter listens on a port and serves a page; the address
//! contains a secret key, and every request that changes something has to carry it. It never
//! leaves your network: nothing is sent to the internet, and the port isn't opened on your router.

use crate::LockExt;

use crate::{actions, fades, Settings, Vm};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const PAGE: &str = include_str!("../remote.html");
const OVERLAY: &str = include_str!("../overlay.html");
/// Actions the phone is allowed to run.
const ALLOWED: &[&str] = &[
    "brb",
    "scene",
    "sound",
    "soundstop",
    "output",
    "outputnext",
    "duck",
    "record",
    "mute",
    "route",
    "routeswap",
    "replay",
    "musicguard",
    "partmute",
    "micfx",
    "chatgame",
    "chatchat",
    "chatcentre",
];

static STATUS: Mutex<Value> = Mutex::new(Value::Null);
static LEVELS: Mutex<Value> = Mutex::new(Value::Null);
/// When the OBS overlay or Stream Deck last asked for meters (milliseconds since start), 0 if never.
static METERS_SEEN: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True while an OBS overlay or Stream Deck meter is showing, so the meters keep being read with
/// the window hidden.
pub fn meters_wanted() -> bool {
    let seen = METERS_SEEN.load(Ordering::Relaxed);
    seen != 0 && now_ms().saturating_sub(seen) < 5000
}

/// The latest meter readings, kept for the overlay.
pub fn set_levels(levels: &Value) {
    *LEVELS.locked() = levels.clone();
}

fn overlay_json(app: &AppHandle) -> Value {
    METERS_SEEN.store(now_ms(), Ordering::Relaxed);
    let vm = app.state::<Vm>();
    let snap = vm.last.locked().clone();
    let strips: Vec<Value> = snap["strips"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| json!({ "mute": c["mute"].as_bool().unwrap_or(false) }))
        .collect();
    let (name, age) = crate::sounds::last_played();
    json!({
        "brb": snap["brb"].as_bool().unwrap_or(false),
        "strips": strips,
        "levels": LEVELS.locked().clone(),
        "sound": if name.is_empty() { Value::Null } else { json!({ "name": name, "ageMs": age }) },
    })
}

fn publish(v: Value) {
    *STATUS.locked() = v;
}

/// { running, message, urls }
pub fn status() -> Value {
    let s = STATUS.locked().clone();
    if s.is_null() {
        json!({ "running": false, "message": "Off", "urls": [] })
    } else {
        s
    }
}

#[derive(PartialEq, Clone)]
struct Cfg {
    on: bool,
    port: u16,
    key: String,
    /// Who can connect: "pc" (this PC only), "private" (the network, but only this PC while
    /// Windows calls the network Public), or "network".
    scope: String,
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.locked();
    let r = &s["remote"];
    let c = Cfg {
        on: r["on"].as_bool().unwrap_or(false),
        port: r["port"]
            .as_u64()
            .filter(|p| *p >= 1024 && *p < 65536)
            .unwrap_or(8787) as u16,
        key: r["key"].as_str().unwrap_or("").to_string(),
        scope: match r["scope"].as_str() {
            Some("pc") => "pc".into(),
            Some("private") => "private".into(),
            _ => "network".into(),
        },
    };
    c
}

/// This PC's address on the local network.
fn lan_ip() -> Option<IpAddr> {
    // Connecting a UDP socket sends nothing; it only asks Windows which address would be used.
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// Addresses that can only be on your own network (or this PC): private ranges, link-local,
/// and the shared range VPNs like Tailscale use. Anything else is turned away.
fn local_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return local_peer(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// True when Windows calls a network this PC is connected to Public (cafés, hotels, or a home
/// network nobody marked as private).
#[cfg(windows)]
pub fn on_public_network() -> bool {
    use windows::Win32::Networking::NetworkListManager::{
        INetworkListManager, NetworkListManager, NLM_ENUM_NETWORK_CONNECTED,
        NLM_NETWORK_CATEGORY_PUBLIC,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        let started = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let check = || -> windows::core::Result<bool> {
            let m: INetworkListManager = CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL)?;
            let nets = m.GetNetworks(NLM_ENUM_NETWORK_CONNECTED)?;
            loop {
                let mut item = [None];
                let mut fetched = 0u32;
                if nets.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                    return Ok(false);
                }
                if let Some(net) = &item[0] {
                    if net.GetCategory()? == NLM_NETWORK_CATEGORY_PUBLIC {
                        return Ok(true);
                    }
                }
            }
        };
        let public = check().unwrap_or(false);
        if started {
            CoUninitialize();
        }
        public
    }
}

#[cfg(not(windows))]
pub fn on_public_network() -> bool {
    false
}

/// Same answer in the same time whether the first byte or the last differs.
fn same(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

struct Request {
    method: String,
    path: String,
    key: String,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if data.len() > 16 * 1024 {
            return None;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let path = target.split('?').next().unwrap_or("").to_string();
    let (mut key, mut length) = (String::new(), 0usize);
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            match k.trim().to_lowercase().as_str() {
                "x-key" => key = v.trim().to_string(),
                "content-length" => length = v.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    let length = length.min(4096);
    let mut body = data[header_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Some(Request {
        method,
        path,
        key,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn respond(stream: &mut TcpStream, code: &str, kind: &str, body: &str) {
    let text = format!(
        "HTTP/1.1 {code}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(text.as_bytes());
}

/// { key: "Strip[2]", bus: 7, db: -6 } → ("Strip[2].GainLayer[7]", -6.0).
fn layer_change(body: &Value) -> Result<(String, f32), String> {
    let key = body["key"].as_str().unwrap_or("");
    let bus = body["bus"].as_u64().unwrap_or(99) as usize;
    if !key.starts_with("Strip[") || !is_channel(key) || bus >= crate::layers::LAYERS {
        return Err("Pick an input and an output".into());
    }
    let db = body["db"].as_f64().unwrap_or(0.0).clamp(-60.0, 12.0) as f32;
    Ok((format!("{key}.GainLayer[{bus}]"), db))
}

fn state_json(app: &AppHandle) -> Value {
    let vm = app.state::<Vm>();
    let snap = vm.last.locked().clone();
    let list = |name: &str, prefix: &str, fallback: &str| -> Vec<Value> {
        snap[name]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, c)| {
                let label = c["label"].as_str().unwrap_or("").trim();
                json!({
                    "key": format!("{prefix}[{i}]"),
                    "name": if label.is_empty() { format!("{fallback} {}", i + 1) } else { label.to_string() },
                    "gain": c["gain"].as_f64().unwrap_or(0.0),
                    "mute": c["mute"].as_bool().unwrap_or(false),
                    // Hardware channels: the Windows device Voicemeeter uses ("" for virtual ones).
                    // Lets other apps, like a visualizer, listen to the same audio.
                    "device": c["device"].as_str().unwrap_or(""),
                    // Which A/B buses an input feeds (1 = on); null for outputs.
                    "a": c["a"].clone(),
                    "b": c["b"].clone(),
                    // Potato: an input's level on each output, and the output the faders set.
                    "layers": c["layers"].clone(),
                    "sel": c["sel"].clone(),
                    // Inputs: the outputs it's muted on by Mute on one output ("B1" …).
                    "partMute": c["partMute"].clone(),
                })
            })
            .collect()
    };
    let (sounds, profiles, brb_set) = {
        let state = app.state::<Settings>();
        let s = state.0.locked();
        let sounds: Vec<Value> = s["soundboard"]["sounds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x["name"].as_str().map(|n| json!(n)))
            .collect();
        let profiles: Vec<Value> = s["outputProfiles"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x["name"].as_str().map(|n| json!(n)))
            .collect();
        let brb_set = s["brb"]["mute"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false)
            || s["brb"]["lower"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false)
            || s["brb"]["play"]
                .as_str()
                .map(|p| !p.is_empty())
                .unwrap_or(false);
        (sounds, profiles, brb_set)
    };
    let (duck, guard_set, replay_on, balance_set) = {
        let state = app.state::<Settings>();
        let s = state.0.locked();
        let g = &s["musicGuard"];
        (
            s["ducking"]["on"].as_bool().unwrap_or(false),
            g["on"].as_bool().unwrap_or(false)
                && g["strip"].as_str().map(|x| !x.is_empty()).unwrap_or(false),
            s["replay"]["on"].as_bool().unwrap_or(false),
            s["chatBalance"].is_object() || s["chatBalanceLive"].is_object(),
        )
    };
    json!({
        "connected": snap["connected"].as_bool().unwrap_or(false),
        "recording": snap["recorder"]["recording"].as_bool().unwrap_or(false),
        "duck": duck,
        "brb": snap["brb"].as_bool().unwrap_or(false),
        "brbSet": brb_set,
        "musicGuard": snap["musicGuard"].as_bool().unwrap_or(false),
        "musicGuardSet": guard_set,
        "replay": replay_on,
        // Game / Chat: -100 (all game) to 100 (all chat), and whether its inputs are chosen.
        "balance": crate::chat_balance::status(app)["position"].as_i64().unwrap_or(0),
        "balanceSet": balance_set,
        // Mics with clean-up or plugins set up, and whether each is on: { "Strip[0]": { "on" } }.
        "micFx": crate::micfx::api_state(app),
        "strips": list("strips", "Strip", "Input"),
        "buses": list("buses", "Bus", "Output"),
        "scenes": crate::scene_list().unwrap_or_default(),
        "sounds": sounds,
        "outputs": profiles,
        "outputNow": snap["outputProfile"],
    })
}

fn is_channel(k: &str) -> bool {
    k.starts_with("Strip[") || k.starts_with("Bus[")
}

/// The meters on their own, cheap enough for a Stream Deck dial to ask several times a second.
fn levels_json() -> Value {
    METERS_SEEN.store(now_ms(), Ordering::Relaxed);
    json!({ "levels": LEVELS.locked().clone() })
}

/// Apps with an audio session, without the process ids the app's own window uses for routing.
fn apps_json() -> Result<Value, String> {
    let apps: Vec<Value> = crate::appvol::list()?
        .into_iter()
        .map(|a| {
            json!({
                "exe": a["exe"],
                "name": a["name"],
                "volume": a["volume"],
                "mute": a["mute"],
                "active": a["active"],
            })
        })
        .collect();
    Ok(json!({ "apps": apps }))
}

/// What a request wants to change on an app: its name, then volume (0–100) and/or mute.
fn app_change(body: &Value) -> Result<(String, Option<f32>, Option<bool>), String> {
    let exe = body["exe"].as_str().unwrap_or("").trim();
    let volume = body["volume"].as_f64().map(|v| v.clamp(0.0, 100.0) as f32);
    let mute = body["mute"].as_bool();
    if exe.is_empty() {
        return Err("No app given".to_string());
    }
    if volume.is_none() && mute.is_none() {
        return Err("Nothing to change".to_string());
    }
    Ok((exe.to_string(), volume, mute))
}

fn handle(app: &AppHandle, c: &Cfg, stream: &mut TcpStream) {
    if !stream
        .peer_addr()
        .map(|a| local_peer(a.ip()))
        .unwrap_or(false)
    {
        return; // not from this network: no answer at all
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let Some(req) = read_request(stream) else {
        return;
    };
    if req.method == "GET" && (req.path == "/" || req.path == "/index.html") {
        return respond(stream, "200 OK", "text/html; charset=utf-8", PAGE);
    }
    if req.method == "GET" && req.path == "/overlay" {
        return respond(stream, "200 OK", "text/html; charset=utf-8", OVERLAY);
    }
    if !req.path.starts_with("/api/") {
        return respond(stream, "404 Not Found", "text/plain", "Not found");
    }
    if !same(&req.key, &c.key) {
        std::thread::sleep(Duration::from_millis(400)); // slows down guessing
        return respond(
            stream,
            "401 Unauthorized",
            "application/json",
            r#"{"error":"Wrong key"}"#,
        );
    }
    let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
    let result: Result<Value, String> = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/state") => Ok(state_json(app)),
        ("GET", "/api/overlay") => Ok(overlay_json(app)),
        ("GET", "/api/levels") => Ok(levels_json()),
        ("GET", "/api/apps") => apps_json(),
        ("POST", "/api/appvolume") => app_change(&body).and_then(|(exe, volume, mute)| {
            crate::appvol::set(&exe, volume, mute).map(|_| json!({}))
        }),
        ("POST", "/api/gain") => {
            let key = body["key"].as_str().unwrap_or("");
            let db = body["db"].as_f64().unwrap_or(0.0).clamp(-60.0, 12.0) as f32;
            match (is_channel(key), app.state::<Vm>().api.clone()) {
                (true, Some(api)) => {
                    fades::set_float(app, &api, &format!("{key}.Gain"), db).map(|_| json!({}))
                }
                (false, _) => Err("Not a channel".to_string()),
                (_, None) => Err("Voicemeeter isn't running".to_string()),
            }
        }
        ("POST", "/api/layer") => match (layer_change(&body), app.state::<Vm>().api.clone()) {
            (Ok((name, db)), Some(api)) => api.set_float(&name, db).map(|_| json!({})),
            (Err(e), _) => Err(e),
            (_, None) => Err("Voicemeeter isn't available".to_string()),
        },
        ("POST", "/api/mixfor") => match app.state::<Vm>().api.clone() {
            // -1 = every output again; otherwise only that output (Voicemeeter allows several).
            Some(api) => {
                let pick = body["bus"].as_i64().unwrap_or(-1);
                (0..crate::layers::LAYERS as i64)
                    .try_for_each(|j| {
                        api.set_float(&format!("Bus[{j}].Sel"), if j == pick { 1.0 } else { 0.0 })
                    })
                    .map(|_| json!({}))
            }
            None => Err("Voicemeeter isn't available".to_string()),
        },
        // Game / Chat from a dial: { "amount": 5 } moves it toward chat, -5 toward game.
        ("POST", "/api/balance") => {
            let amount = body["amount"].as_i64().unwrap_or(0).clamp(-200, 200) as i32;
            crate::chat_balance::change(app, None, amount, true, false)
                .map(|v| json!({ "position": v["position"] }))
        }
        ("POST", "/api/action") => {
            let action = body["action"].as_str().unwrap_or("");
            let target = body["target"].as_str().unwrap_or("");
            if ALLOWED.contains(&action) {
                actions::perform(app, action, target).map(|_| json!({}))
            } else {
                Err("That action isn't available from the phone".to_string())
            }
        }
        _ => Err("Not found".to_string()),
    };
    match result {
        Ok(v) => respond(stream, "200 OK", "application/json", &v.to_string()),
        Err(e) => respond(
            stream,
            "400 Bad Request",
            "application/json",
            &json!({ "error": e }).to_string(),
        ),
    }
}

/// Serve until the settings change. Returns an error message if it can't start.
fn serve(app: &AppHandle, c: &Cfg) -> Result<(), String> {
    let public = on_public_network();
    let pc_only = c.scope == "pc" || (c.scope == "private" && public);
    let listener = TcpListener::bind((if pc_only { "127.0.0.1" } else { "0.0.0.0" }, c.port))
        .map_err(|e| {
            format!(
                "Couldn't start on port {}: {e}. Try another port in Settings",
                c.port
            )
        })?;
    let host = if pc_only {
        "localhost".to_string()
    } else {
        lan_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| "this-pc".to_string())
    };
    publish(json!({
        "running": true,
        "message": "On",
        "pcOnly": pc_only,
        "publicNetwork": public,
        "urls": [format!("http://{host}:{}/?k={}", c.port, c.key)],
    }));
    log_info!("Sleekmeeter Remote listening on port {}", c.port);
    // accept() waits without using any CPU. A watcher checks the settings once a second and the
    // network every 10 s; when either changes it connects to the listener to wake it up.
    let stop = Arc::new(AtomicBool::new(false));
    {
        let (app, c, stop) = (app.clone(), c.clone(), stop.clone());
        let port = c.port;
        std::thread::spawn(move || {
            let mut ticks = 0u32;
            while !stop.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_secs(1));
                ticks += 1;
                // A network that becomes (or stops being) Public changes who may connect.
                let network_changed =
                    c.scope == "private" && ticks % 10 == 0 && on_public_network() != public;
                if cfg(&app) != c || network_changed {
                    stop.store(true, Ordering::Release);
                    let _ = std::net::TcpStream::connect_timeout(
                        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                        Duration::from_secs(1),
                    );
                }
            }
        });
    }
    loop {
        let accepted = listener.accept();
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        match accepted {
            Ok((mut stream, _)) => {
                let app = app.clone();
                let c = c.clone();
                std::thread::spawn(move || handle(&app, &c, &mut stream));
            }
            Err(e) => {
                stop.store(true, Ordering::Release);
                return Err(format!("Sleekmeeter Remote stopped: {e}"));
            }
        }
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error = String::new();
        loop {
            let c = cfg(&app);
            if !c.on {
                publish(json!({ "running": false, "message": "Off", "urls": [] }));
                last_error.clear();
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            if c.key.len() < 8 {
                publish(json!({ "running": false, "message": "Make a key first", "urls": [] }));
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let message = match serve(&app, &c) {
                Ok(()) => String::new(),
                Err(e) => e,
            };
            if message.is_empty() {
                continue;
            }
            if message != last_error {
                log_warn!("Sleekmeeter Remote: {message}");
                last_error = message.clone();
            }
            publish(json!({ "running": false, "message": message, "urls": [] }));
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_changes_need_an_input_and_an_output() {
        assert_eq!(
            layer_change(&json!({ "key": "Strip[2]", "bus": 7, "db": -80 })),
            Ok(("Strip[2].GainLayer[7]".to_string(), -60.0))
        );
        assert!(layer_change(&json!({ "key": "Bus[2]", "bus": 1 })).is_err());
        assert!(layer_change(&json!({ "key": "Strip[2]", "bus": 8 })).is_err());
    }

    /// Prints what Windows says about the networks here: cargo test network_category -- --ignored --nocapture
    #[test]
    #[ignore]
    fn network_category() {
        println!("public network: {}", on_public_network());
    }

    #[test]
    fn only_local_addresses_may_connect() {
        for ok in [
            "127.0.0.1",
            "192.168.1.20",
            "10.0.0.5",
            "172.20.1.1",
            "169.254.3.3",
            "100.101.102.103",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.2",
        ] {
            assert!(local_peer(ok.parse().unwrap()), "{ok}");
        }
        for bad in [
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2001:db8::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!local_peer(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn keys_are_compared_whole() {
        assert!(same("abcd1234", "abcd1234"));
        assert!(!same("abcd1234", "abcd1235"));
        assert!(!same("abcd", "abcd1234"));
    }

    #[test]
    fn app_changes_need_an_app_and_something_to_change() {
        let (exe, volume, mute) =
            app_change(&json!({ "exe": "discord.exe", "volume": 140.0 })).unwrap();
        assert_eq!(exe, "discord.exe");
        assert_eq!(volume, Some(100.0));
        assert_eq!(mute, None);
        assert_eq!(
            app_change(&json!({ "exe": "discord.exe", "mute": true }))
                .unwrap()
                .2,
            Some(true)
        );
        assert!(app_change(&json!({ "exe": "discord.exe" })).is_err());
        assert!(app_change(&json!({ "volume": 50.0 })).is_err());
    }

    #[test]
    fn only_channels_can_have_a_level_set() {
        assert!(is_channel("Strip[2]") && is_channel("Bus[0]"));
        assert!(!is_channel("Command.Shutdown"));
    }
}
