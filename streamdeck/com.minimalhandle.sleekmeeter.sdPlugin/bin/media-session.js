'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

// A restarted worker takes a moment to report, so the last track stands in if it's this recent.
const REMEMBER_MS = 10 * 60 * 1000;
// A pressed play or pause shows at once, and only reverts if the player hasn't agreed by then.
const EXPECT_MS = 1500;

// One hidden, on-demand Windows worker for all Now Playing dials. No tokens or web requests.
class MediaSession {
  constructor(onUpdate, launch = spawn) {
    this.onUpdate = onUpdate;
    this.launch = launch;
    this.child = null;
    this.players = {};
    this.retryAfter = 0;
    this.lastUpdate = 0;
    this.remembered = null;
    this.rememberedAt = 0;
    this.expected = null;
  }
  start() {
    if (this.child || Date.now() < this.retryAfter) return;
    this.retryAfter = Date.now() + 10000;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = this.launch(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'media-session.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { this.stop(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/^\uFEFF/, '').trim(); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (!value.players || typeof value.players !== 'object') continue;
          this.players = value.players;
          this.lastUpdate = Date.now();
          this.onUpdate();
        } catch (_) { /* ignore a malformed diagnostic line */ }
      }
    });
    // Drain the error pipe without storing media details or logging them.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const closed = () => {
      if (this.child !== child) return;
      this.child = null; this.players = {}; this.lastUpdate = 0; this.onUpdate();
    };
    child.on('error', closed);
    child.on('close', closed);
  }
  snapshot(source = 'spotify', now = Date.now()) {
    let players = this.players;
    if (!this.lastUpdate && this.child) {
      // The worker is starting: that says nothing about the player, so don't report it as missing.
      if (!this.remembered || now - this.rememberedAt > REMEMBER_MS) return { available: false, loading: true };
      players = this.remembered;
    } else if (!this.lastUpdate || now - this.lastUpdate > 8000) return { available: false, reason: 'Waiting for media' };
    const item = players[source === 'auto' ? 'auto' : 'spotify'];
    if (!item || !item.available) return { available: false, reason: item && item.reason || 'No media session' };
    const duration = Math.max(0, Number(item.duration) || 0);
    const elapsed = item.playing ? Math.max(0, Math.min(8, (now - (Number(item.capturedAt) || now)) / 1000)) : 0;
    let position = Math.max(0, (Number(item.position) || 0) + elapsed);
    if (duration) position = Math.min(duration, position);
    const art = typeof item.art === 'string' && item.art.length <= 100000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.art) ? item.art : '';
    return { available: true, title: String(item.title || 'Untitled'), artist: String(item.artist || ''), source: String(item.source || ''), playing: this.expectedPlaying(item, now), position, duration, art };
  }
  expectedPlaying(item, now) {
    const expected = this.expected;
    if (!expected || expected.source !== String(item.source || '')) return !!item.playing;
    if (now >= expected.until || expected.playing === !!item.playing) { this.expected = null; return !!item.playing; }
    return expected.playing;
  }
  command(command, source = 'spotify') {
    if (!['playpause', 'next', 'previous'].includes(command)) return false;
    this.start();
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    const shown = command === 'playpause' ? this.snapshot(source) : null;
    this.child.stdin.write(JSON.stringify({ command, source: source === 'auto' ? 'auto' : 'spotify' }) + '\n');
    if (shown && shown.available) {
      this.expected = { source: shown.source, playing: !shown.playing, until: Date.now() + EXPECT_MS };
      this.onUpdate();
    }
    return true;
  }
  stop() {
    const child = this.child;
    if (this.lastUpdate) { this.remembered = this.players; this.rememberedAt = this.lastUpdate; }
    this.child = null; this.players = {}; this.lastUpdate = 0; this.expected = null;
    if (child) { child.stdin.end(); const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1200); timer.unref(); }
  }
}
module.exports = { MediaSession };
