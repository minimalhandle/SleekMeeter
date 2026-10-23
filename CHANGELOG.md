# Changelog

## 0.10.0
- **Be right back:** a **BRB** button (and shortcut) that mutes your mic, turns the game down and plays music, all with fades, then puts everything back exactly as it was. Set it up in Settings → Stream mode
- **OBS Studio link:** follow your OBS scenes (load a Voicemeeter scene, or start or end Be right back, when OBS changes scene), act when you go live or the stream ends, and show a **LIVE** tag in the header. Needs OBS 28 or newer with its WebSocket server on
- **Mic level check:** talk for 8 seconds and Sleekmeeter says whether your mic is too quiet or too loud and can set the fader for you, plus an optional warning when a channel goes over 0 dB
- **Per-game profiles:** automatic rules can also switch your outputs and theme while an app runs, and put them back when it closes
- **Backup and layout:** save and restore your settings, reset the window layout, and **Check my setup** to find out why something isn't working
- Fixed: the tray panel's remembered position could be lost when settings were saved from the mixer window

## 0.9.0
- **The tray panel is docked by default:** double-click the tray icon and it snaps flush against the taskbar and clock, in exactly the same spot every time, whichever edge the taskbar is on. The pin button in its header (or Settings → Tray volume panel) undocks it so you can drag it by the header; it remembers where you put it
- **Four new themes that change the whole look, not just the colours:** **Glass** (frosted cards, capsule faders), **Ink** (light, minimal, big thin numbers), **Neon** (glowing synth night) and **Terminal** (green phosphor). Two more arrive too: **Bubblegum** (pink, with heart faders and cute emoji channel icons) and **Clean** (the least clutter of any theme). The theme picker in Settings is collapsed to three themes with a **Show all 12 themes** button. Everything works the same in all of them, including the tray panel, mini mode and the volume overlay

## 0.8.0
- **Output profiles** (**Outputs** in the header): save the devices your outputs are using as a named setup, like Headphones or Speakers, and switch between setups in one click. Turn on **Auto** for a setup and Sleekmeeter switches to it by itself when one of its devices connects, such as when you turn on a different headset. Shortcuts can switch to a chosen profile or step to the next one, with the on-screen overlay naming it
- **Push to talk and push to mute** shortcuts that only act while you hold the keys. With push to talk the mic starts out muted, opens when you press the keys and closes a moment after you let go (**Mic stays open** in Settings, so the end of a word isn't cut off). Push to mute does the opposite, and a channel you had already muted stays muted
- **App volumes** (**Apps** in the header): a volume slider and mute for each app that is playing sound, the same controls as Windows' volume mixer, so you can turn Discord down or mute a browser without touching the rest. Apps that are playing show a green dot
## 0.7.0
- **Themes** (Settings → Appearance): Console, Midnight, Analog, Studio (light), Minimal and OLED black. Each one previews itself in the picker, and the tray panel and volume overlay follow the theme you pick. If you used "Pure black for OLED", you start on OLED black
- **Settings → About** shows the Sleekmeeter version you're running and the Voicemeeter it's connected to; the tray icon's tooltip shows the version too
- Sleekmeeter keeps a log (`logs/sleekmeeter.log` next to the exe) of what it does and anything that goes wrong: starting up, connecting to Voicemeeter, scenes, the recorder, devices coming and going, engine restarts, failed actions and crashes. **Open log file** in Settings → About shows it, ready to attach to a bug report. It never grows past about 2 MB

## 0.6.1
- Fixed: MP3 recordings came out loud and badly distorted. Voicemeeter's MP3 encoder reads its audio as 16-bit, so MP3 now always records at 16-bit (the recorder's other formats keep the bit depth you pick, 24-bit by default)
- Only one Sleekmeeter runs at a time: starting it again (for example from a pinned taskbar icon after closing the window to the tray) brings the running one back instead of opening a second copy
- The recorder shows how loud the recording is, and warns when it goes over 0 dB (which distorts the file) or when nothing is selected to record

## 0.6.0
- **Talk-over ducking:** other audio turns down while you talk and comes back when you stop. Pick the channel that talks, the channels to turn down, how much, and the level it starts at; the slider lights up with your voice so you can set it by eye. Ducked channels show **Ducking**, and their faders still move freely
- **Smooth fades:** mute fades out and unmute fades in; typed levels, double-click to 0 dB, volume shortcuts and scene changes glide instead of jumping. Fade times are in Settings, and fades can be turned off
- **Recorder** (Banana and Potato): record and play with Voicemeeter's built-in recorder from a new **Rec** button. Pick inputs or outputs to record, the format, a file to play (open or drop it on the window), where it plays and how loud. The clock runs in the header while recording
- **Devices that come back:** when headphones or another device Voicemeeter uses comes back after being unplugged or disconnected, Sleekmeeter restarts the audio engine for you (Settings → Audio devices)
- New shortcut actions: turn talk-over ducking on or off, and start or stop recording, with the on-screen overlay confirming each

## 0.5.2
- Remembers the window's size, position and maximized state between launches (if that spot's monitor is gone, it opens centred instead)
- First launch opens the window just wide enough for your mixer, centred, instead of a fixed size with empty space
- Leaving mini mode goes back to your remembered size
- Update notifications also find releases marked as pre-release

## 0.5.1
- Smaller fader caps on the main mixer (32×38 instead of 46×54)
- No more stray horizontal scrollbar in mini mode

## 0.5.0
- New look, "Console": each channel is a hardware module with a glowing LED meter, a machined fader cap in its own slot, backlit routing and mute keys, and a big dB readout you can click to type a level
- Pure black theme for OLED screens (Settings → Appearance), also used by the tray panel and volume overlay
- Faster: meters and faders animate on the GPU without layout or repainting (in testing, repaints over 3 s of live meters dropped from about 2,500 to 4), and the meter loop idles when nothing moves
- Meter colours sit at their true levels: yellow from −9 dB, red above 0 dB, lined up with the fader scale
- Mica and Acrylic backdrops removed in favour of the new look

## 0.4.1
- Looks at home on Windows 11: Segoe UI Variable, Mica window backdrop, Acrylic tray panel, Fluent buttons, corners, focus rings and scrollbars, and toggle switches in Settings
- The connection dot pulses slowly while Voicemeeter is connected
- Each strip is as wide as its name, so names like "Speakers (Realtek(R) Audio)" show in full; mini mode and the tray panel widen their name column to match
- Input and output sections stay centred instead of stretching across a wide window
- Mute gets its own row on input strips, with Solo and Mono below
- The window appears once it's drawn, without a blank flash

## 0.4.0
- Works with Voicemeeter Standard and Potato as well as Banana; the layout adapts to the edition you run, with a denser layout for Potato's 16 channels
- **Start Voicemeeter** launches the edition you used last
- Update notifications: a header button when a newer release is on GitHub, with an option to skip a version or turn the check off
- Switch scenes automatically when an app starts or closes, set up in **Scenes → Switch automatically**

## 0.3.1
- Tray volume panel sizes itself to its content, no empty space at the bottom
- Screenshots in the README

## 0.3.0
- Right-click a fader (or press Enter on it) to type an exact level, like `-10`, `-10db` or `+3 dB`
- Double-click the tray icon for a pinned volume panel above the tray; also in the tray menu as **Open volume panel**
- Browser right-click menu removed outside text fields

## 0.2.0
- Channel colors, icons and hiding; LED-style meters
- Channel panel: device picker, pan, compressor, gate, EQ for virtual inputs, bus modes
- Mini mode and keep-on-top
- Global shortcuts with a shortcut recorder
- Volume overlay when levels change from another app, a MIDI controller or a Stream Deck
- Start with Windows, start Voicemeeter automatically, hide Voicemeeter's own window

## 0.1.0
- First version: fader-meters, routing, mute/solo/mono, renaming, scenes, tray icon
