# Mixer UI scripts

The mixer window's code, split by area. `index.html` loads the parts in number order as plain
`<script>` tags (no build step), after `icons.js` and `engine.js`.

| Part | What's in it |
|---|---|
| `01-core.js` | Shared helpers, settings, the channel model, faders, meters, incoming state, settings sliders |
| `02-drawer.js` | The channel drawer |
| `03-mix-views.js` | Output mix, live monitor, Potato output select, Game / Chat balance, offline overlay |
| `04-header-settings.js` | Header (pin, mini mode, more menu) and the settings dialog |
| `05-controls-scenes.js` | MIDI controllers, scenes, automatic scene switching |
| `06-updates.js` | Update notifications, Stream Deck plugin offer, What's new |
| `07-outputs.js` | Output profiles and fallbacks |
| `08-apps.js` | Per-app volume and routing, apps tray, saved assignments, signal paths, guided tests |
| `09-panel-recorder.js` | About and logs, fades and ducking, recorder, toasts, tray volume panel |
| `10-streaming.js` | Be right back, OBS, soundboard, Twitch, going live, loudness, Sleekmeeter Remote |
| `11-history.js` | Level history, mic clip warning |
| `12-mic.js` | Mic clean-up and plugins, Voicemeeter options, hear yourself, setup guide, mic chain, mic tune-up |
| `13-tools.js` | Check my setup, Windows sound output, crackle doctor, mic coach, backups, Quick Actions, Audio Event History ("My sound just cut out") |
| `14-start.js` | Themes, the title bar, and `init()`, which starts the app |

## Rules that keep this working

- **One shared scope.** Every part is a classic script, so a `const`, `let` or `function` at the
  top of one part is visible in all the others. Names must be unique across all parts.
- **Load order matters for code that runs while loading.** Code at the top level of a part runs
  as soon as that part loads, so it may only *call* things declared in the same or an earlier
  part. Event handlers and functions that run later can use anything. Helpers that are called
  while loading (such as `bindRange`) belong in `01-core.js`.
- **`init()` runs last** (end of `14-start.js`), once every part has loaded.
- Don't name a top-level binding after a real browser global (`history`, `name`, `status`,
  `top`, `location`…): it would hide that global from `engine.js` too.
