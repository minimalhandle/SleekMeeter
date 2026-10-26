# AGENTS.md

Guidance for AI coding agents (Claude Code and others) working on Sleekmeeter.

## What this is
Sleekmeeter is a Tauri 2 desktop app (Windows only) that gives Voicemeeter (Standard, Banana, Potato) a modern UI. Rust backend in `src-tauri/`, plain HTML/CSS/JS frontend in `src/` (no framework, no bundler). Repo: `minimalhandle/SleekMeeter`. Licence: MIT.

## Layout
- `src/index.html`, `app.js`, `styles.css`: the UI. `themes.css` holds every theme, keyed by `[data-theme="id"]`. `engine.js` talks to Rust through Tauri, or runs a simulated Voicemeeter when opened in a plain browser. `osd.html` / `osd.js` is the volume overlay.
- `src-tauri/src/`: `vm.rs` (Voicemeeter Remote API), `gain.rs` / `fades.rs` (smooth mute fades and level glides), `routing.rs` / `appvol.rs` / `apps.rs` (per-app audio routing and volumes), `remote.rs` (phone remote and the HTTP API the Stream Deck plugin uses), `settings.rs`, `update.rs` (in-app updates), `sounds.rs` / `recorder.rs`, `obs.rs`, `twitch.rs`, and others.
- `src-tauri/installer-hooks.nsh`: NSIS hooks (the Voicemeeter check in the installer).
- `streamdeck/`: Stream Deck plugin (no dependencies; own WebSocket client in `bin/ws.js`).
- `scripts/package.ps1`: builds the release files into `dist\release`.
- `docs/screenshots`: images used by the README gallery.

## Build and run (Windows)
- `npm install`, then `npm run dev` to run, `npm run build` for a release exe, `npm run package` for installer, MSI and portable zip.
- UI-only work: `npm run preview` (or `python -m http.server 8000 --directory src`) and open in a browser; the simulator needs no Voicemeeter.
- Rust cannot be compiled on Linux/cloud sandboxes here. If you can't build, run `rustfmt --edition 2021 --check` on changed files, and say clearly that the change has not been compiled. Compile errors on the first Windows build are expected for untested Rust.

## Rules and conventions
- Frontend: plain JS, no dependencies. Keep everything working in the browser simulator (`engine.js` mock) as well as in Tauri.
- Themes are CSS only (variables and overrides under `[data-theme="id"]`); a new theme also needs an entry in the `THEMES` list in `app.js`, its variables in `osd.html`, a preview card, and a README gallery image. Removed themes go in the `RETIRED` map (and `settings.rs`) so users are moved to Console.
- Avoid HTML5 drag and drop (Tauri's webview intercepts it); use pointer events.
- Mute and level changes go through the `gain.rs` smoothing; don't write gain directly.
- Voicemeeter is never bundled or downloaded by Sleekmeeter. The installer only checks for it and offers to open VB-Audio's download page. Don't add code that downloads and runs executables (the old Setup.exe wrapper was flagged as malware).
- Sleekmeeter must not need administrator rights. Installs are per-user (NSIS); settings live in `%APPDATA%\Sleekmeeter` for installed copies.
- Keep the Stream Deck plugin working with the remote API (`/api/state`, `/api/gain`, `/api/action`); don't rename actions without updating `streamdeck/`.
- No new heavy dependencies; keep performance and startup fast.

## Docs and releases
- Update `CHANGELOG.md` (top section = current version) and the README for any user-visible change. The README is shown on GitHub, so check that tables, images and links render correctly there.
- Version lives in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`; keep them equal. The packaging script refuses mismatches.
- Releases are built and published by hand by the maintainer from their own PC (`npm run package`, then upload the files to a GitHub release). Release files: `Sleekmeeter-<ver>-setup.exe` (in-app updates look for the `-setup.exe` name), `Sleekmeeter-<ver>.msi`, `Sleekmeeter-<ver>-portable.zip`.
- Never store or reuse tokens or credentials. Don't push tags or create releases unless asked.

## Held features
Not built until the maintainer asks: VBAN, MIDI, audio callback / spectrum / loudness, FX / Karaoke / Pitch, parametric EQ, Patch, macro buttons, push-to-talk in the Stream Deck plugin. Sample-rate matching was declined; don't build it.
