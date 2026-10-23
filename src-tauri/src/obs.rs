//! Link to OBS Studio (its built-in WebSocket server, obs-websocket 5, OBS 28 and newer).
//!
//! Sleekmeeter listens to OBS and reacts:
//! - when OBS switches scene, run the rule you set for that scene (load a Voicemeeter scene,
//!   start or end Be right back);
//! - when you go live or the stream ends, do the same;
//! - show a LIVE marker in the mixer.
//!
//! Streaming to Twitch from OBS is covered by this: OBS tells us when the stream starts and
//! stops. Sleekmeeter never changes anything in OBS.
//!
//! OBS: Tools → WebSocket Server Settings → Enable (the default port is 4455).

use crate::{brb, load_scene_auto, Settings};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

/// Scene and stream events (4 = scenes, 64 = outputs).
const EVENTS: u64 = 4 | 64;
const RETRY: Duration = Duration::from_secs(3);

static STATUS: Mutex<Value> = Mutex::new(Value::Null);

fn idle(message: &str) -> Value {
    json!({ "connected": false, "live": false, "scene": null, "scenes": [], "message": message })
}

/// What the mixer shows about OBS right now.
pub fn status() -> Value {
    let s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        idle("Off")
    } else {
        s
    }
}

fn publish(app: &AppHandle, v: Value) {
    *STATUS.lock().unwrap() = v.clone();
    let _ = app.emit("obs-status", v);
}

struct Cfg {
    on: bool,
    host: String,
    port: u16,
    password: String,
}

impl PartialEq for Cfg {
    fn eq(&self, o: &Cfg) -> bool {
        self.on == o.on && self.host == o.host && self.port == o.port && self.password == o.password
    }
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let o = &s["obs"];
    let host = o["host"]
        .as_str()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = o["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p < 65536)
        .unwrap_or(4455) as u16;
    let c = Cfg {
        on: o["on"].as_bool().unwrap_or(false),
        host,
        port,
        password: o["password"].as_str().unwrap_or("").to_string(),
    };
    c
}

/// obs-websocket 5's password proof: base64(sha256(base64(sha256(password + salt)) + challenge)).
fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    b64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    match e {
        tungstenite::Error::Io(io) => matches!(
            io.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ),
        _ => false,
    }
}

/// Wait up to `wait` for the next JSON message. `Ok(None)` when nothing arrived in time.
fn read_json(ws: &mut Ws, wait: Duration) -> Result<Option<Value>, String> {
    let until = Instant::now() + wait;
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let text: &str = &t;
                return serde_json::from_str(text)
                    .map(Some)
                    .map_err(|e| format!("OBS sent something unreadable: {e}"));
            }
            Ok(Message::Close(frame)) => {
                let code: u16 = frame.map(|f| u16::from(f.code)).unwrap_or(0);
                return Err(if code == 4009 {
                    "OBS refused the password".to_string()
                } else {
                    format!("OBS closed the connection ({code})")
                });
            }
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {
                if Instant::now() >= until {
                    return Ok(None);
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn request(ws: &mut Ws, kind: &str, id: &str) -> Result<(), String> {
    let msg = json!({ "op": 6, "d": { "requestType": kind, "requestId": id } });
    ws.send(Message::Text(msg.to_string().into()))
        .map_err(|e| e.to_string())
}

/// Connect, sign in, and return a socket that times out every 400 ms so the caller can poll.
fn connect(c: &Cfg) -> Result<Ws, String> {
    let url = format!("ws://{}:{}", c.host, c.port);
    let (mut ws, _) = tungstenite::connect(url).map_err(|e| {
        let text = e.to_string();
        if text.contains("10061") || text.to_lowercase().contains("refused") {
            "OBS isn't running, or its WebSocket server is off (OBS: Tools → WebSocket Server Settings)"
                .to_string()
        } else {
            format!("Couldn't reach OBS: {text}")
        }
    })?;
    if let MaybeTlsStream::Plain(s) = ws.get_mut() {
        let _ = s.set_read_timeout(Some(Duration::from_millis(400)));
        let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
    }
    let hello = read_json(&mut ws, Duration::from_secs(5))?.ok_or("OBS didn't answer")?;
    let mut identify = json!({ "op": 1, "d": { "rpcVersion": 1, "eventSubscriptions": EVENTS } });
    if let (Some(challenge), Some(salt)) = (
        hello["d"]["authentication"]["challenge"].as_str(),
        hello["d"]["authentication"]["salt"].as_str(),
    ) {
        if c.password.is_empty() {
            return Err("OBS needs a password: enter it in Settings → OBS".into());
        }
        identify["d"]["authentication"] = json!(auth_string(&c.password, salt, challenge));
    }
    ws.send(Message::Text(identify.to_string().into()))
        .map_err(|e| e.to_string())?;
    loop {
        match read_json(&mut ws, Duration::from_secs(5))? {
            Some(m) if m["op"].as_u64() == Some(2) => return Ok(ws),
            Some(_) => {}
            None => return Err("OBS didn't finish signing in".into()),
        }
    }
}

#[derive(Default)]
struct Obs {
    scenes: Vec<String>,
    scene: Option<String>,
    live: bool,
}

fn publish_state(app: &AppHandle, o: &Obs) {
    publish(
        app,
        json!({ "connected": true, "live": o.live, "scene": o.scene, "scenes": o.scenes,
                "message": if o.live { "Connected to OBS, live" } else { "Connected to OBS" } }),
    );
}

/// What a rule or the live/offline settings can do.
fn act(app: &AppHandle, what: &str, scene: &str, because: &str) {
    match what {
        "scene" if !scene.is_empty() => load_scene_auto(app, scene, because),
        "brb-on" => brb::set(app, true),
        "brb-off" => brb::set(app, false),
        _ => {}
    }
}

/// OBS switched to `name`: run the first rule for it.
fn on_scene(app: &AppHandle, name: &str) {
    let rule = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        let found = s["obs"]["rules"].as_array().and_then(|rules| {
            rules
                .iter()
                .find(|r| {
                    r["obs"]
                        .as_str()
                        .map(|n| n.trim().eq_ignore_ascii_case(name))
                        .unwrap_or(false)
                })
                .cloned()
        });
        found
    };
    if let Some(r) = rule {
        let because = format!("OBS scene {name}");
        act(
            app,
            r["do"].as_str().unwrap_or("scene"),
            r["scene"].as_str().unwrap_or(""),
            &because,
        );
    }
}

/// The stream started or ended.
fn on_live(app: &AppHandle, live: bool) {
    let (what, scene) = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        let o = &s["obs"];
        let (d, sc) = if live {
            ("liveDo", "liveScene")
        } else {
            ("offDo", "offScene")
        };
        let out = (
            o[d].as_str().unwrap_or("").to_string(),
            o[sc].as_str().unwrap_or("").to_string(),
        );
        out
    };
    let because = if live {
        "going live"
    } else {
        "the stream ending"
    };
    log_info!("OBS: {because}");
    act(app, &what, &scene, because);
}

/// One connection, from signing in until it drops or the settings change.
fn session(app: &AppHandle, c: &Cfg) -> Result<(), String> {
    let mut ws = connect(c)?;
    log_info!("Connected to OBS at {}:{}", c.host, c.port);
    let mut o = Obs::default();
    request(&mut ws, "GetSceneList", "scenes")?;
    request(&mut ws, "GetStreamStatus", "stream")?;
    publish_state(app, &o);
    loop {
        if cfg(app) != *c {
            let _ = ws.close(None);
            return Ok(());
        }
        let Some(m) = read_json(&mut ws, Duration::from_millis(900))? else {
            continue;
        };
        match m["op"].as_u64() {
            Some(7) => {
                let d = &m["d"]["responseData"];
                match m["d"]["requestId"].as_str() {
                    Some("scenes") => {
                        // OBS lists scenes bottom to top; show them like OBS does.
                        o.scenes = d["scenes"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .rev()
                                    .filter_map(|s| s["sceneName"].as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        o.scene = d["currentProgramSceneName"].as_str().map(String::from);
                    }
                    Some("stream") => o.live = d["outputActive"].as_bool().unwrap_or(false),
                    _ => continue,
                }
                publish_state(app, &o);
            }
            Some(5) => {
                let d = &m["d"]["eventData"];
                match m["d"]["eventType"].as_str() {
                    Some("CurrentProgramSceneChanged") => {
                        if let Some(name) = d["sceneName"].as_str() {
                            o.scene = Some(name.to_string());
                            publish_state(app, &o);
                            on_scene(app, name);
                        }
                    }
                    Some("StreamStateChanged") => {
                        let live = d["outputActive"].as_bool().unwrap_or(false);
                        if live != o.live {
                            o.live = live;
                            publish_state(app, &o);
                            on_live(app, live);
                        }
                    }
                    Some("SceneListChanged")
                    | Some("SceneCreated")
                    | Some("SceneRemoved")
                    | Some("SceneNameChanged") => request(&mut ws, "GetSceneList", "scenes")?,
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error = String::new();
        loop {
            let c = cfg(&app);
            if !c.on {
                if status()["message"] != json!("Off") {
                    publish(&app, idle("Off"));
                }
                last_error.clear();
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let message = match session(&app, &c) {
                Ok(()) => String::new(), // settings changed: reconnect straight away
                Err(e) => e,
            };
            if message.is_empty() {
                continue;
            }
            if message != last_error {
                log_warn!("OBS: {message}");
                last_error = message.clone();
            }
            publish(&app, idle(&message));
            std::thread::sleep(RETRY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_proof_matches_the_obs_websocket_example() {
        // From the obs-websocket 5 protocol documentation.
        let proof = auth_string(
            "supersecretpassword",
            "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
            "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=",
        );
        assert_eq!(proof, "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
    }
}
