//! Twitch chat commands.
//!
//! Sleekmeeter joins your channel's chat as a silent, anonymous viewer (no sign-in, nothing is
//! ever posted) and watches for the commands you set up, like `!brb` or `!sound airhorn`.
//! A command only runs when it comes from someone you allow: just you, you and your mods, or
//! everyone. Chat text is never run as anything else: only a command you added can do something.

use crate::{actions, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const SERVER: &str = "irc.chat.twitch.tv:6667";
const RETRY: Duration = Duration::from_secs(5);

static STATUS: Mutex<Value> = Mutex::new(Value::Null);

fn idle(message: &str) -> Value {
    json!({ "connected": false, "message": message, "last": "" })
}

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
    let _ = app.emit("twitch-status", v);
}

#[derive(PartialEq, Clone)]
struct Cfg {
    on: bool,
    channel: String,
    who: String,
}

/// Lower case, no #, only letters, digits and underscores (what Twitch channel names allow).
fn clean_channel(s: &str) -> String {
    s.trim()
        .trim_start_matches('#')
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(25)
        .collect()
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let t = &s["twitch"];
    let c = Cfg {
        on: t["on"].as_bool().unwrap_or(false),
        channel: clean_channel(t["channel"].as_str().unwrap_or("")),
        who: t["who"].as_str().unwrap_or("mods").to_string(),
    };
    c
}

struct Chat {
    name: String,
    broadcaster: bool,
    moderator: bool,
    text: String,
}

/// Pick a chat message apart: `@tags :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :text`.
fn parse_message(line: &str) -> Option<Chat> {
    let (tags, rest) = match line.strip_prefix('@') {
        Some(r) => r.split_once(' ')?,
        None => ("", line),
    };
    let (head, text) = rest.split_once(" PRIVMSG ")?;
    let text = text.split_once(" :")?.1.to_string();
    let nick = head.trim_start_matches(':').split('!').next()?.to_string();
    let mut name = nick;
    let (mut broadcaster, mut moderator) = (false, false);
    for tag in tags.split(';') {
        let Some((k, v)) = tag.split_once('=') else {
            continue;
        };
        match k {
            "display-name" if !v.is_empty() => name = v.to_string(),
            "mod" => moderator = v == "1",
            "badges" => {
                broadcaster = v.split(',').any(|b| b.starts_with("broadcaster/"));
            }
            _ => {}
        }
    }
    name.truncate(30);
    Some(Chat {
        name,
        broadcaster,
        moderator: moderator || broadcaster,
        text,
    })
}

fn allowed(who: &str, c: &Chat) -> bool {
    match who {
        "everyone" => true,
        "broadcaster" => c.broadcaster,
        _ => c.moderator,
    }
}

/// Run the command a chat message starts with, if there is one set up for it.
fn handle(
    app: &AppHandle,
    who: &str,
    c: &Chat,
    cooldowns: &mut HashMap<String, Instant>,
) -> Option<String> {
    let mut words = c.text.trim().splitn(2, char::is_whitespace);
    let first = words.next()?.to_lowercase();
    let arg = words.next().unwrap_or("").trim().to_string();
    if !first.starts_with('!') {
        return None;
    }
    let (found, cooldown) = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        let t = &s["twitch"];
        let hit = t["commands"].as_array().and_then(|list| {
            list.iter()
                .find(|x| {
                    x["cmd"]
                        .as_str()
                        .map(|n| n.trim().to_lowercase() == first)
                        .unwrap_or(false)
                })
                .cloned()
        });
        (hit, t["cooldown"].as_f64().unwrap_or(3.0).clamp(0.0, 600.0))
    };
    let command = found?;
    if !allowed(who, c) {
        return None;
    }
    if let Some(at) = cooldowns.get(&first) {
        if at.elapsed().as_secs_f64() < cooldown {
            return None;
        }
    }
    cooldowns.insert(first.clone(), Instant::now());
    let action = command["action"].as_str().unwrap_or("").to_string();
    // A command with no fixed target uses what was typed after it: "!sound airhorn".
    let fixed = command["target"].as_str().unwrap_or("").to_string();
    let target = if fixed.is_empty() { arg } else { fixed };
    log_info!("Twitch: {} ran {first} ({action})", c.name);
    if let Err(e) = actions::perform(app, &action, &target) {
        log_warn!("Twitch {first}: {e}");
    }
    Some(format!("{first} from {}", c.name))
}

fn connect(channel: &str) -> Result<TcpStream, String> {
    let addr = SERVER
        .to_socket_addrs()
        .map_err(|e| format!("Couldn't find Twitch: {e}"))?
        .next()
        .ok_or("Couldn't find Twitch")?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(8))
        .map_err(|e| format!("Couldn't reach Twitch chat: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    // An anonymous "justinfan" login can read chat but never post.
    let hello = format!(
        "CAP REQ :twitch.tv/tags\r\nPASS SCHMOOPIIE\r\nNICK justinfan48213\r\nJOIN #{channel}\r\n"
    );
    stream
        .write_all(hello.as_bytes())
        .map_err(|e| format!("Couldn't join chat: {e}"))?;
    Ok(stream)
}

/// One connection, until it drops or the settings change.
fn session(app: &AppHandle, c: &Cfg) -> Result<(), String> {
    let stream = connect(&c.channel)?;
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut buf: Vec<u8> = Vec::new();
    let mut last = String::new();
    let mut cooldowns: HashMap<String, Instant> = HashMap::new();
    let mut joined = false;
    publish(
        app,
        json!({ "connected": false, "message": "Joining chat…", "last": "" }),
    );
    loop {
        if cfg(app) != *c {
            return Ok(());
        }
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => return Err("Twitch closed the connection".into()),
            Ok(_) if buf.ends_with(b"\n") => {}
            Ok(_) => continue,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(e) => return Err(format!("Lost the Twitch chat connection: {e}")),
        }
        let line = String::from_utf8_lossy(&buf).trim_end().to_string();
        buf.clear();
        if line.starts_with("PING") {
            let _ = writer.write_all(b"PONG :tmi.twitch.tv\r\n");
        } else if line.contains(" PRIVMSG ") {
            if let Some(chat) = parse_message(&line) {
                if let Some(ran) = handle(app, &c.who, &chat, &mut cooldowns) {
                    last = ran;
                    publish(
                        app,
                        json!({ "connected": true, "message": format!("In #{} chat", c.channel), "last": last }),
                    );
                }
            }
        } else if !joined && line.contains(" 366 ") {
            joined = true;
            publish(
                app,
                json!({ "connected": true, "message": format!("In #{} chat", c.channel), "last": last }),
            );
        } else if line.contains(" NOTICE ") && line.to_lowercase().contains("login") {
            return Err("Twitch refused the connection".into());
        }
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error = String::new();
        loop {
            let c = cfg(&app);
            if !c.on || c.channel.is_empty() {
                let msg = if c.on {
                    "Enter your channel name"
                } else {
                    "Off"
                };
                if status()["message"] != json!(msg) {
                    publish(&app, idle(msg));
                }
                last_error.clear();
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let message = match session(&app, &c) {
                Ok(()) => String::new(),
                Err(e) => e,
            };
            if message.is_empty() {
                continue;
            }
            if message != last_error {
                log_warn!("Twitch: {message}");
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
    fn reads_a_chat_message_with_badges() {
        let line = "@badges=moderator/1,subscriber/6;display-name=SomeMod;mod=1 :somemod!somemod@somemod.tmi.twitch.tv PRIVMSG #me :!brb now";
        let c = parse_message(line).unwrap();
        assert_eq!(c.name, "SomeMod");
        assert!(c.moderator && !c.broadcaster);
        assert_eq!(c.text, "!brb now");
        assert!(allowed("mods", &c));
        assert!(!allowed("broadcaster", &c));
    }

    #[test]
    fn the_broadcaster_counts_as_a_mod() {
        let line =
            "@badges=broadcaster/1;display-name=Me :me!me@me.tmi.twitch.tv PRIVMSG #me :hello";
        let c = parse_message(line).unwrap();
        assert!(c.broadcaster && c.moderator);
    }

    #[test]
    fn viewers_are_only_allowed_when_everyone_is() {
        let c = parse_message(":v!v@v.tmi.twitch.tv PRIVMSG #me :!brb").unwrap();
        assert!(!allowed("mods", &c));
        assert!(allowed("everyone", &c));
    }

    #[test]
    fn channel_names_are_cleaned() {
        assert_eq!(clean_channel("  #MyChannel_1 "), "mychannel_1");
        assert_eq!(clean_channel("a b/c"), "abc");
    }
}
