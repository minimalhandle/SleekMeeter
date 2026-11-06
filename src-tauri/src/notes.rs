//! "What's new": the release notes, shown once after an update. They come from CHANGELOG.md,
//! built into the app, so nothing is downloaded.

use serde_json::{json, Value};

const CHANGELOG: &str = include_str!("../../CHANGELOG.md");
/// At most this many versions at once, newest first (a long gap shows the latest ones).
const MAX_SECTIONS: usize = 6;

type Section = (String, Vec<u64>, Vec<Value>);

/// Every version's section: (title such as "0.15.7 (test version)", version, its blocks).
/// A block is a point ("li"), a heading line written as **Heading** ("h"), or a line of text ("p").
fn sections(text: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(title) = line.strip_prefix("## ") {
            let version = crate::update::parts(title.split_whitespace().next().unwrap_or(""));
            out.push((title.trim().to_string(), version, Vec::new()));
            continue;
        }
        let Some(last) = out.last_mut() else { continue };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let heading = line
            .strip_prefix("**")
            .and_then(|l| l.strip_suffix("**"))
            .filter(|h| !h.contains("**"));
        let block = match (line.strip_prefix("- "), heading) {
            (Some(item), _) => json!({ "kind": "li", "text": item.trim() }),
            (None, Some(h)) => json!({ "kind": "h", "text": h.trim() }),
            _ => json!({ "kind": "p", "text": line }),
        };
        last.2.push(block);
    }
    // "Unreleased" and other headings without a version aren't notes yet.
    out.retain(|(_, v, blocks)| !v.is_empty() && blocks.iter().any(|b| b["kind"] == "li"));
    out
}

/// The notes for versions newer than `seen`, up to and including this one. With no `seen`
/// (an older copy that didn't record it), only this version's notes.
fn between(text: &str, seen: Option<&str>, current: &str) -> Vec<Value> {
    let now = crate::update::parts(current);
    let since = seen.map(crate::update::parts);
    let mut picked: Vec<_> = sections(text)
        .into_iter()
        .filter(|(_, v, _)| *v <= now && since.as_ref().map_or(*v == now, |s| v > s))
        .collect();
    picked.sort_by(|a, b| b.1.cmp(&a.1));
    picked
        .into_iter()
        .take(MAX_SECTIONS)
        .map(|(title, _, blocks)| json!({ "title": title, "blocks": blocks }))
        .collect()
}

/// What to show at this start, if anything, and the settings updated to remember it.
/// `had_settings` is false on a fresh install, which gets no "What's new".
pub fn on_start(settings: &mut Value, had_settings: bool) -> Vec<Value> {
    let current = crate::update::CURRENT;
    let seen = settings["seenVersion"].as_str().map(str::to_string);
    if seen.as_deref() == Some(current) {
        return Vec::new();
    }
    settings["seenVersion"] = json!(current);
    let _ = crate::settings::save(settings);
    match seen {
        Some(seen) => between(CHANGELOG, Some(&seen), current),
        None if had_settings => between(CHANGELOG, None, current),
        None => Vec::new(),
    }
}

/// The latest few versions' notes, for the What's new button.
pub fn recent() -> Vec<Value> {
    let now = crate::update::parts(crate::update::CURRENT);
    let mut all: Vec<_> = sections(CHANGELOG)
        .into_iter()
        .filter(|(_, v, _)| *v <= now)
        .collect();
    all.sort_by(|a, b| b.1.cmp(&a.1));
    all.into_iter()
        .take(3)
        .map(|(title, _, blocks)| json!({ "title": title, "blocks": blocks }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "# Changelog\r\n\r\n## Unreleased\r\n- not yet\r\n\r\n## 0.15.7 (test version)\r\n- **Seven**\r\n\r\n## 0.15.6 (test version)\r\nIntro line.\r\n\r\n**Group**\r\n- Six a\r\n- Six b\r\n\r\n## 0.15.5\r\n- Five\r\n\r\n## 0.15.3\r\n- Three\r\n";

    fn titles(v: &[Value]) -> Vec<&str> {
        v.iter().map(|s| s["title"].as_str().unwrap()).collect()
    }

    #[test]
    fn shows_every_version_since_the_one_last_seen() {
        let got = between(LOG, Some("0.15.5"), "0.15.7");
        assert_eq!(titles(&got), ["0.15.7 (test version)", "0.15.6 (test version)"]);
        assert_eq!(
            got[1]["blocks"],
            json!([
                { "kind": "p", "text": "Intro line." },
                { "kind": "h", "text": "Group" },
                { "kind": "li", "text": "Six a" },
                { "kind": "li", "text": "Six b" }
            ])
        );
        // A point that starts in bold stays a point.
        assert_eq!(got[0]["blocks"], json!([{ "kind": "li", "text": "**Seven**" }]));
        // Unreleased notes and versions after this one never show.
        assert_eq!(titles(&between(LOG, Some("0.15.3"), "0.15.6")), ["0.15.6 (test version)", "0.15.5"]);
        // Same version, or going back: nothing.
        assert!(between(LOG, Some("0.15.7"), "0.15.7").is_empty());
        assert!(between(LOG, Some("0.15.8"), "0.15.7").is_empty());
        // An older copy that didn't record a version: just this version's notes.
        assert_eq!(titles(&between(LOG, None, "0.15.7")), ["0.15.7 (test version)"]);
    }

    #[test]
    fn the_real_changelog_has_notes_for_this_version() {
        assert!(
            !between(CHANGELOG, None, crate::update::CURRENT).is_empty(),
            "CHANGELOG.md needs a section for {}",
            crate::update::CURRENT
        );
    }
}
