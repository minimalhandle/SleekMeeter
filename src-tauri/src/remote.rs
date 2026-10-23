//! Phone remote: a small web page on your own network that works the mixer.
//!
//! Off by default. When it's on, Sleekmeeter listens on a port and serves a page; the address
//! contains a secret key, and every request that changes something has to carry it. It never
//! leaves your network: nothing is sent to the internet, and the port isn't opened on your router.

use crate::{actions, fades, Settings, Vm};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const PAGE: &str = include_str!("../remote.html");
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
];

static STATUS: Mutex<Value> = Mutex::new(Value::Null);

fn publish(v: Value) {
    *STATUS.lock().unwrap() = v;
}

/// { running, message, urls }
pub fn status() -> Value {
    let s = STATUS.lock().unwrap().clone();
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
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let r = &s["remote"];
    let c = Cfg {
        on: r["on"].as_bool().unwrap_or(false),
        port: r["port"]
            .as_u64()
            .filter(|p| *p >= 1024 && *p < 65536)
            .unwrap_or(8787) as u16,
        key: r["key"].as_str().unwrap_or("").to_string(),
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

fn state_json(app: &AppHandle) -> Value {
    let vm = app.state::<Vm>();
    let snap = vm.last.lock().unwrap().clone();
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
                })
            })
            .collect()
    };
    let (sounds, profiles, brb_set) = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
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
    json!({
        "connected": snap["connected"].as_bool().unwrap_or(false),
        "brb": snap["brb"].as_bool().unwrap_or(false),
        "brbSet": brb_set,
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

fn handle(app: &AppHandle, c: &Cfg, stream: &mut TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let Some(req) = read_request(stream) else {
        return;
    };
    if req.method == "GET" && (req.path == "/" || req.path == "/index.html") {
        return respond(stream, "200 OK", "text/html; charset=utf-8", PAGE);
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
    let listener = TcpListener::bind(("0.0.0.0", c.port)).map_err(|e| {
        format!(
            "Couldn't start on port {}: {e}. Try another port in Settings",
            c.port
        )
    })?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let host = lan_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "this-pc".to_string());
    publish(json!({
        "running": true,
        "message": "On",
        "urls": [format!("http://{host}:{}/?k={}", c.port, c.key)],
    }));
    log_info!("Phone remote listening on port {}", c.port);
    let mut idle_ticks = 0u32;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let app = app.clone();
                let c = c.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_nonblocking(false);
                    handle(&app, &c, &mut stream);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                idle_ticks += 1;
                if idle_ticks % 20 == 0 && cfg(app) != *c {
                    return Ok(());
                }
            }
            Err(e) => return Err(format!("The phone remote stopped: {e}")),
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
                log_warn!("Phone remote: {message}");
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
    fn keys_are_compared_whole() {
        assert!(same("abcd1234", "abcd1234"));
        assert!(!same("abcd1234", "abcd1235"));
        assert!(!same("abcd", "abcd1234"));
    }

    #[test]
    fn only_channels_can_have_a_level_set() {
        assert!(is_channel("Strip[2]") && is_channel("Bus[0]"));
        assert!(!is_channel("Command.Shutdown"));
    }
}
