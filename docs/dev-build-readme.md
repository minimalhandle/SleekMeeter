# Sleekmeeter 0.22.0-beta.1 — local test build

This portable beta contains CPU noise removal, partial scenes, voice-aware ducking,
complete setup migration and automatic microphone level riding. Nothing was published.

## Run safely alongside your normal installation

Quit the normal Sleekmeeter from its tray menu first (closing its window leaves it running).
Run Sleekmeeter.exe from this folder. Beta settings and scenes stay in this folder;
your normal installation's settings are separate. Both copies control the same
Voicemeeter, so audio changes still affect your current Voicemeeter setup.
This build's version ends in -dev (for example 0.22.0-beta.1-dev) so it isn't mistaken for
an official release. Automatic update checks are on, and the updater offers the
published version as newer, so you can move this copy onto it once it's out.

## Try the five features

1. **CPU noise removal:** Settings → Microphone → Clean-up and plugins. Select a
   microphone, choose CPU · RNNoise, then enable noise removal. No NVIDIA runtime
   or model download is needed. Set Voicemeeter's Preferred Main SampleRate to
   48000 in its System Settings. Try strength and Hold to hear it without; the
   comparison keeps the extra model delay aligned.
2. **Partial scenes:** Scenes → Save selected controls only. Select channels and
   categories, name the scene and save. Change selected and unselected controls,
   preview, then apply. Only the selected categories/channels should restore.
   Test a mute-only scene while talk-over ducking is active. Old full scenes keep
   their existing behavior. Partial scenes apply immediately.
3. **Voice-aware ducking:** Settings → Mixer & devices → Talk-over ducking. Pick
   trigger/target inputs, enable ducking and voice-aware detection. Speaking must
   satisfy both the level threshold and speech confidence. Test keyboard noise,
   pauses, additional voice-chat triggers and attack/hold/release. Detection needs
   48 kHz and access to Voicemeeter's input insert. If unavailable, ducking releases.
4. **Complete migration:** Settings → System & backup → Backup and layout → Move
   your complete setup. Export, then import and review devices/plugins/apps. Map
   missing devices before applying. The live Voicemeeter snapshot is imported as
   a scene, to load explicitly after review; XML hardware names are not remapped.
   Settings and replaced files are backed up under migration-backups. External
   controls and plugins start off; restoring shortcuts/automation is opt-in.
   Restart the app after import. Sound clips have a 16 MB individual/64 MB total
   package limit; missing/oversized assets are reported. Plugin binaries are not
   included; matching local installations are required.
5. **Automatic mic level riding:** In Clean-up and plugins, enable automatic mic
   level riding on a hardware mic. Start at −20 dB RMS, +9/−12 dB limits and
   3 dB/s. Talk normally, then move farther away/closer and watch Current correction.
   Your fader stays where you put it. The rider requests no additional gain from
   silence or detected non-speech and has a peak ceiling. It cannot repair clipping
   in the microphone/interface. It also needs 48 kHz; works independently of noise
   removal and before VST3 plugins.

## What still needs listening tests

Automated verification: 127 Rust tests passed; five existing hardware-dependent
tests were skipped. The migration frontend regression and headless browser checks
for CPU/rider controls, ducking controls and partial scene save/preview also passed.

Real microphone quality, model speech detection accuracy, sustained latency/CPU use,
device switching, controllers, and transfer between different PCs need hands-on testing.
CPU processing adds a model frame (10 ms) plus the existing insert-worker delay.
NVIDIA effects remain available. Plugin snapshots use the latest persisted host state.
To return to the normal version, quit this beta and start your installed Sleekmeeter;
restore a Voicemeeter backup if you want to undo mixer changes.

Build from source again with npm run package:dev (output in dist\dev).
