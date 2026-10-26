# Sleekmeeter for Stream Deck

A Stream Deck plugin for Sleekmeeter. Built for the **Stream Deck +** (four dials), and every key action works on any Stream Deck.

## Install

1. Open Sleekmeeter → **Settings → Phone remote**, turn it on, and click **Copy** next to the address.
2. Double-click **`Sleekmeeter.streamDeckPlugin`** in this folder. The Stream Deck app installs it.
3. Drag **Channel level** onto a dial, pick a channel in the settings below, and paste the address into **Connection**. Press **Connect**. You only paste it once; every other button uses the same address.

## What's in it

| Action | Where | What it does |
| --- | --- | --- |
| **Channel level** | Dial | Turn to change the level, press to mute or unmute, tap the screen to mute. The screen shows the name, level and a bar. |
| **Mute mic** | Key | A key just for your microphone. Green **LIVE** with a mic when it's open, red **MUTED** with the mic crossed out when it's muted, so you can see it at a glance. Uses your first input unless you pick another channel, and can be set to **Hold to talk**. |
| **Mute channel** | Key | Mute or unmute; turns red when muted and shows the level. |
| **Level step** | Key | Turn a channel up or down by a set amount, or jump it to a fixed level. |
| **Load scene** | Key | Load a Sleekmeeter scene. |
| **Play sound** | Key | Play a soundboard sound. |
| **Stop sounds** | Key | Stop everything that's playing. |
| **Be right back** | Key | Turn Be right back on or off, and shows its state. |
| **Record** | Key | Start or stop the recorder, and shows its state. |
| **Talk-over ducking** | Key | Turn ducking on or off, and shows its state. |
| **Output profile** | Key | Switch to an output profile, or the next one. |

Four dials, four channels: add **Channel level** to each dial and pick Mic, Discord, Desktop and so on.

## How it works

The plugin talks to the phone-remote server Sleekmeeter already runs on your PC (the same one your phone uses). Nothing goes over the internet. It reads the state about twice a second so the keys and dials stay in step with Sleekmeeter, Voicemeeter and your other controllers.

If a button says **Sleekmeeter not found**, check Sleekmeeter is open and the phone remote is on. **Wrong key** means the address was changed with "Make a new key"; paste the new one.

## Files

`com.minimalhandle.sleekmeeter.sdPlugin/` is the plugin itself (plain Node.js, no packages). To rebuild the installer file, zip that folder and rename the zip to `Sleekmeeter.streamDeckPlugin`.
