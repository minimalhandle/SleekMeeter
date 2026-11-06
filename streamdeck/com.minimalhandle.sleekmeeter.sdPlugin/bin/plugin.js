'use strict';
/*
 * Sleekmeeter for Stream Deck.
 * Talks to the Stream Deck app over its WebSocket and to Sleekmeeter's phone-remote server over HTTP.
 * No npm packages: the WebSocket client is in ws.js.
 */
const { Socket } = require('./ws');

const BASE_UUID = 'com.minimalhandle.sleekmeeter';
const A = (n) => `${BASE_UUID}.${n}`;

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];

/* ------------------------------------------------------------------ connection to Sleekmeeter */
let conn = { base: 'http://127.0.0.1:8787', key: '' };
let address = '';

function parseAddress(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^[A-Za-z0-9_-]{12,}$/.test(t)) return { base: 'http://127.0.0.1:8787', key: t }; // just the key
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `http://${t}`);
    return { base: `${u.protocol}//${u.host}`, key: u.searchParams.get('k') || '' };
  } catch (_) {
    return null;
  }
}

async function api(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(conn.base + path, {
      method,
      headers: { 'X-Key': conn.key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ state */
let st = null;          // last /api/state
let levels = null;      // last /api/levels: { inputs, outputs }, each [[left, right] in dB]
let apps = [];          // last /api/apps
let appsStatus = 'offline'; // 'ok' | 'offline' | 'key' | 'old'
let status = 'offline'; // 'ok' | 'offline' | 'key' | 'novm'
const local = {};       // key -> { db, until }: levels we just set, shown until Sleekmeeter catches up
const contexts = new Map(); // context -> { action, settings, controller, last }

const channels = () => (st ? [...(st.strips || []), ...(st.buses || [])] : []);
const chan = (key) => channels().find((c) => c.key === key);
const gainOf = (c) => {
  const l = local[c.key];
  return l && Date.now() < l.until ? l.db : c.gain;
};
const muteOf = (c) => {
  const l = local[`${c.key}#mute`];
  return l && Date.now() < l.until ? l.v : c.mute;
};

/* ------------------------------------------------------------------ Stream Deck socket */
let ws = null;
function send(obj) { if (ws && ws.open) ws.send(JSON.stringify(obj)); }
const setImage = (context, image) => send({ event: 'setImage', context, payload: { image, target: 0 } });
const setFeedback = (context, payload) => send({ event: 'setFeedback', context, payload });
const showAlert = (context) => send({ event: 'showAlert', context });
const showOk = (context) => send({ event: 'showOk', context });

/* ------------------------------------------------------------------ live Studio artwork */
const studio = require('./studio');
const { MediaSession } = require('./media-session');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MIC_DEFAULT = 'Strip[0]';

// Optimistic route state remains shared by rendering and action handling.
function routeOf(ch, bus) {
  const l = local[`${ch.key}#${bus}`];
  if (l && Date.now() < l.until) return l.v;
  const list = bus[0] === 'A' ? ch.a : ch.b;
  const n = Number(bus.slice(1)) - 1;
  return Array.isArray(list) && n >= 0 && n < list.length ? !!list[n] : null;
}
const breath = () => Math.round((0.5 - 0.5 * Math.cos(((Date.now() % 3200) / 3200) * 2 * Math.PI)) * 16) / 16;
// Meter reading for a channel in whole dB, so a steady signal doesn't redraw the dial.
function levelOf(ch) {
  const m = /^(Strip|Bus)\[(\d+)\]$/.exec(ch.key);
  const pair = m && levels && (m[1] === 'Strip' ? levels.inputs : levels.outputs);
  const reading = pair && pair[Number(m[2])];
  return Array.isArray(reading) ? Math.round(Math.max(...reading)) : null;
}
const drawingState = () => ({ st, status, chan, gainOf, muteOf, routeOf, breath, levelOf });
const MEDIA_ACTIONS = ['nowplaying', 'nowplayingkey', 'trackdial'];
const media = new MediaSession(() => { for (const [context, c] of contexts) if (MEDIA_ACTIONS.includes(c.action)) render(context); });
// Changing page or opening a folder hides every action for a moment, so the worker outlives that.
const MEDIA_LINGER_MS = 60000;
let mediaLinger = null;
const syncMedia = () => {
  if ([...contexts.values()].some(c => MEDIA_ACTIONS.includes(c.action))) {
    clearTimeout(mediaLinger); mediaLinger = null;
    media.start();
  } else if (!mediaLinger) {
    mediaLinger = setTimeout(() => { mediaLinger = null; media.stop(); }, MEDIA_LINGER_MS);
  }
};
const mediaFor = (c) => media.snapshot((c.settings || {}).mediaSource);
const renderKey = (c) => c.action === 'nowplayingkey' ? studio.renderNowPlayingKey(c, mediaFor(c)) : studio.renderKey(c, drawingState());
const renderDial = (c) => {
  if (c.action === 'nowplaying') return studio.renderNowPlaying(c, drawingState(), mediaFor(c));
  if (c.action === 'trackdial') return studio.renderTrackDial(c, mediaFor(c));
  if (c.action === 'appvolume') return studio.renderAppDial(c, { status: appsStatus, app: appOf((c.settings || {}).exe) });
  if (c.action === 'mixdial') return renderMixDial(c);
  return studio.renderDial(c, drawingState());
};

const lastDrawn = new Map();
function render(context) {
  const c = contexts.get(context);
  if (!c) return;
  if (c.controller === 'Encoder') {
    const img = renderDial(c);
    if (lastDrawn.get(context) !== img) { lastDrawn.set(context, img); setFeedback(context, { canvas: img }); }
    return;
  }
  const img = renderKey(c);
  if (img && lastDrawn.get(context) !== img) { lastDrawn.set(context, img); setImage(context, img); }
}
const renderAll = () => { for (const k of contexts.keys()) render(k); };

/* ------------------------------------------------------------------ polling */
let pollTimer = null;
let pulseTimer = null;
let levelTimer = null;
let appTimer = null;
// Lit route keys breathe slowly, so they're redrawn a few times a second.
function pulseTick() {
  for (const [ctx, c] of contexts) {
    if (c.action !== 'route' || status !== 'ok' || !st) continue;
    const ch = chan((c.settings || {}).channel || MIC_DEFAULT);
    if (ch && routeOf(ch, (c.settings || {}).bus || 'B1')) render(ctx);
  }
}
// Dials with a meter ask for levels on their own fast timer; an older app has no such route.
let levelsBusy = false;
let levelsRetry = 0;
const wantsLevels = () => status === 'ok' && [...contexts.values()].some(c => ['channel', 'nowplaying'].includes(c.action) && (c.settings || {}).showMeter !== false);
async function levelTick() {
  if (levelsBusy || Date.now() < levelsRetry || !wantsLevels()) return;
  levelsBusy = true;
  try {
    levels = (await api('GET', '/api/levels')).levels;
    for (const [ctx, c] of contexts) if (['channel', 'nowplaying'].includes(c.action)) render(ctx);
  } catch (_) {
    levels = null;
    levelsRetry = Date.now() + 30000;
  } finally {
    levelsBusy = false;
  }
}
// App volumes are only read while an app dial is on screen or its settings are open.
async function pollApps() {
  try {
    apps = (await api('GET', '/api/apps')).apps || [];
    appsStatus = 'ok';
  } catch (e) {
    apps = [];
    appsStatus = e.status === 401 ? 'key' : e.status === 400 ? 'old' : 'offline';
  }
  for (const [ctx, c] of contexts) if (c.action === 'appvolume') render(ctx);
}
function appTick() {
  if ([...contexts.values()].some(c => c.action === 'appvolume')) pollApps();
}
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    st = await api('GET', '/api/state');
    status = st.connected ? 'ok' : 'novm';
  } catch (e) {
    status = e.status === 401 ? 'key' : 'offline';
    if (status !== 'key') st = status === 'offline' ? null : st;
  } finally {
    polling = false;
  }
  syncMedia();
  renderAll();
}
function startPolling() {
  syncMedia();
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, 450);
  if (!pulseTimer) pulseTimer = setInterval(pulseTick, 220);
  if (!levelTimer) levelTimer = setInterval(levelTick, 125);
  if (!appTimer) { appTimer = setInterval(appTick, 1500); appTick(); }
}
function stopPollingIfIdle() {
  syncMedia();
  if (contexts.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (contexts.size === 0 && pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
  if (contexts.size === 0 && levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  if (contexts.size === 0 && appTimer) { clearInterval(appTimer); appTimer = null; }
}

/* ------------------------------------------------------------------ doing things */
async function act(context, action, target) {
  try {
    await api('POST', '/api/action', { action, target: target || '' });
    setTimeout(poll, 120);
  } catch (e) {
    showAlert(context);
    if (e.status === 401) { status = 'key'; renderAll(); }
  }
}

const gainTimers = {};
const gainDirty = {};
async function pushGain(key) {
  if (gainTimers[key]) { gainDirty[key] = true; return; }
  gainTimers[key] = setTimeout(() => {
    delete gainTimers[key];
    if (gainDirty[key]) { delete gainDirty[key]; pushGain(key); }
  }, 70);
  const l = local[key];
  if (!l) return;
  try { await api('POST', '/api/gain', { key, db: l.db }); } catch (e) { if (e.status === 401) { status = 'key'; renderAll(); } }
}
function setLevel(key, db) {
  const v = Math.round(clamp(db, -60, 12) * 10) / 10;
  local[key] = { db: v, until: Date.now() + 1200 };
  pushGain(key);
  renderAll();
}

function toggleMute(context, key) {
  const ch = chan(key);
  if (!ch) { showAlert(context); return; }
  local[`${key}#mute`] = { v: !muteOf(ch), until: Date.now() + 900 };
  renderAll();
  act(context, 'mute', key);
}

function toggleRoute(context, key, bus) {
  const ch = chan(key);
  if (!ch || routeOf(ch, bus) === null) { showAlert(context); return; }
  local[`${key}#${bus}`] = { v: !routeOf(ch, bus), until: Date.now() + 900 };
  renderAll();
  act(context, 'route', `${key}.${bus}`);
}

function rotate(c, ticks) {
  const ch = chan((c.settings || {}).channel);
  if (!ch) return;
  const step = Number((c.settings || {}).step) || 1;
  // A quick spin moves further per click.
  const t = Math.abs(ticks) > 1 ? ticks * (1 + (Math.abs(ticks) - 1) * 0.5) : ticks;
  setLevel(ch.key, gainOf(ch) + t * step);
}

/* ------------------------------------------------------------------ Potato output mix */
// An input's level on one output (Potato's gain layers), and the output the faders set.
function layerOf(ch, idx) {
  const l = local[`${ch.key}#L${idx}`];
  if (l && Date.now() < l.until) return l.db;
  return ((ch.layers || [])[idx]);
}
function renderMixDial(c) {
  const s = c.settings || {}, e = drawingState(), ch = chan(s.channel), bus = s.bus || 'B1', idx = studio.busIndex(st, bus);
  if (ch && st && !(ch.layers || []).length) return studio.renderNote('POTATO ONLY', 'Needs Voicemeeter Potato');
  const v = ch ? layerOf(ch, idx) : undefined;
  return studio.renderDial(c, { ...e, chan: () => ch && { ...ch, name: `${ch.name} on ${bus}` }, gainOf: (x) => (v === undefined ? gainOf(x) : v) });
}
const layerTimers = {};
function pushLayer(key, idx) {
  const id = `${key}#L${idx}`;
  if (layerTimers[id]) { layerTimers[id] = 'again'; return; }
  layerTimers[id] = setTimeout(() => { const again = layerTimers[id] === 'again'; delete layerTimers[id]; if (again) pushLayer(key, idx); }, 70);
  const l = local[id];
  if (l) api('POST', '/api/layer', { key, bus: idx, db: l.db }).catch(() => {});
}
function setLayer(context, c, db) {
  const s = c.settings || {}, ch = chan(s.channel), idx = studio.busIndex(st, s.bus || 'B1');
  if (!ch || idx < 0 || !(ch.layers || []).length) { showAlert(context); return; }
  local[`${ch.key}#L${idx}`] = { db: Math.round(clamp(db, -60, 12) * 10) / 10, until: Date.now() + 1200 };
  pushLayer(ch.key, idx);
  render(context);
}
function rotateLayer(context, c, ticks) {
  const s = c.settings || {}, ch = chan(s.channel), idx = studio.busIndex(st, s.bus || 'B1');
  if (!ch) { showAlert(context); return; }
  const now = layerOf(ch, idx);
  const t = Math.abs(ticks) > 1 ? ticks * (1 + (Math.abs(ticks) - 1) * 0.5) : ticks;
  setLayer(context, c, (now === undefined ? gainOf(ch) : now) + t * (Number(s.step) || 1));
}
// The main level: the gain layers then match it again on this output.
function matchMain(context, c) {
  const ch = chan((c.settings || {}).channel);
  if (ch) setLayer(context, c, gainOf(ch)); else showAlert(context);
}
async function pickMixFor(context, c) {
  const want = (c.settings || {}).bus || 'all', idx = studio.busIndex(st, want);
  const sel = st ? (st.buses || []).findIndex((b) => b.sel) : -1;
  const pick = want === 'all' || sel === idx ? -1 : idx;
  if (st) (st.buses || []).forEach((b, j) => { b.sel = j === pick; });
  renderAll();
  try { await api('POST', '/api/mixfor', { bus: pick }); } catch (_) { showAlert(context); }
}

/* ------------------------------------------------------------------ media and app dials */
function mediaCommand(context, what, source) {
  if (!media.command(what, source)) showAlert(context);
}
// A fast spin skips one track, not ten.
let lastSkip = 0;
function skipTrack(context, c, ticks) {
  if (!ticks || Date.now() - lastSkip < 350) return;
  lastSkip = Date.now();
  mediaCommand(context, ticks > 0 ? 'next' : 'previous', (c.settings || {}).mediaSource);
}

const appLocal = {}; // exe -> { volume?, mute?, until }: changes we just made, shown until Windows catches up
function appOf(exe) {
  const app = apps.find((a) => a.exe === exe);
  if (!app) return null;
  const l = appLocal[exe];
  return l && Date.now() < l.until ? { ...app, ...l } : app;
}
const appSending = {};
async function sendAppVolume(context, exe) {
  if (appSending[exe]) { appSending[exe] = 'again'; return; }
  appSending[exe] = 'yes';
  try {
    await api('POST', '/api/appvolume', { exe, volume: appLocal[exe].volume });
  } catch (_) {
    showAlert(context);
  }
  const again = appSending[exe] === 'again';
  delete appSending[exe];
  if (again) sendAppVolume(context, exe);
}
function rotateApp(context, c, ticks) {
  const s = c.settings || {};
  const app = appOf(s.exe);
  if (!app) { showAlert(context); return; }
  const volume = clamp(Math.round(app.volume + ticks * (Number(s.step) || 2)), 0, 100);
  appLocal[s.exe] = { ...appLocal[s.exe], volume, until: Date.now() + 1800 };
  render(context);
  sendAppVolume(context, s.exe);
}
async function toggleAppMute(context, c) {
  const exe = (c.settings || {}).exe;
  const app = appOf(exe);
  if (!app) { showAlert(context); return; }
  appLocal[exe] = { ...appLocal[exe], mute: !app.mute, until: Date.now() + 1800 };
  render(context);
  try { await api('POST', '/api/appvolume', { exe, mute: !app.mute }); } catch (_) { showAlert(context); }
}

function onKeyDown(context, c) {
  const s = c.settings || {};
  switch (c.action) {
    case 'mute': return toggleMute(context, s.channel);
    case 'route': return toggleRoute(context, s.channel || MIC_DEFAULT, s.bus || 'B1');
    case 'mixfor': return pickMixFor(context, c);
    case 'mic': {
      const key = s.channel || MIC_DEFAULT;
      const ch = chan(key);
      if (!ch) return showAlert(context);
      // "Hold to talk": the mic opens only while the key is held.
      if (s.mode === 'ptt') { if (muteOf(ch)) toggleMute(context, key); return; }
      return toggleMute(context, key);
    }
    case 'level': {
      const ch = chan(s.channel);
      if (!ch) return showAlert(context);
      const amt = Number(s.amount);
      if ((s.mode || 'up') === 'set') return setLevel(ch.key, Number.isFinite(amt) ? amt : 0);
      const d = (Number.isFinite(amt) && amt > 0 ? amt : 2) * (s.mode === 'down' ? -1 : 1);
      return setLevel(ch.key, gainOf(ch) + d);
    }
    case 'scene': return s.scene ? act(context, 'scene', s.scene) : showAlert(context);
    case 'sound': return s.sound ? act(context, 'sound', s.sound) : showAlert(context);
    case 'soundstop': return act(context, 'soundstop');
    case 'brb': return act(context, 'brb');
    case 'record': return act(context, 'record');
    case 'duck': return act(context, 'duck');
    case 'output': return s.output ? act(context, 'output', s.output) : act(context, 'outputnext');
    case 'nowplayingkey': return (s.press || 'playpause') === 'none' ? undefined : mediaCommand(context, s.press || 'playpause', s.mediaSource);
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ property inspector */
function listsFor(context) {
  return {
    event: 'lists',
    status,
    address,
    strips: st ? st.strips : [],
    buses: st ? st.buses : [],
    scenes: st ? st.scenes : [],
    sounds: st ? st.sounds : [],
    outputs: st ? st.outputs : [],
    apps: apps.map((a) => ({ exe: a.exe, name: a.name })),
    appsStatus,
  };
}
function toPI(action, context, payload) {
  send({ event: 'sendToPropertyInspector', action, context, payload });
}
function setAddress(text) {
  address = String(text || '').trim();
  const p = parseAddress(address);
  if (p) conn = p;
  send({ event: 'setGlobalSettings', context: args.pluginUUID, payload: { address } });
  status = 'offline';
  poll();
}

/* ------------------------------------------------------------------ Stream Deck events */
function onMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch (_) { return; }
  const ctx = m.context;
  switch (m.event) {
    case 'didReceiveGlobalSettings': {
      const a = (m.payload && m.payload.settings && m.payload.settings.address) || '';
      if (a !== address) {
        address = a;
        const p = parseAddress(a);
        if (p) conn = p;
        poll();
      }
      break;
    }
    case 'willAppear': {
      const action = String(m.action || '').slice(BASE_UUID.length + 1);
      contexts.set(ctx, { action, settings: (m.payload && m.payload.settings) || {}, controller: (m.payload && m.payload.controller) || 'Keypad' });
      lastDrawn.delete(ctx);
      startPolling();
      render(ctx);
      break;
    }
    case 'willDisappear':
      contexts.delete(ctx);
      lastDrawn.delete(ctx);
      stopPollingIfIdle();
      break;
    case 'didReceiveSettings': {
      const c = contexts.get(ctx);
      if (c) { c.settings = (m.payload && m.payload.settings) || {}; syncMedia(); lastDrawn.delete(ctx); render(ctx); }
      break;
    }
    case 'keyUp': {
      const c = contexts.get(ctx);
      if (c && c.action === 'mic' && (c.settings || {}).mode === 'ptt') {
        const key = (c.settings || {}).channel || MIC_DEFAULT;
        const ch = chan(key);
        if (ch && !muteOf(ch)) toggleMute(ctx, key);
      }
      break;
    }
    case 'keyDown': {
      const c = contexts.get(ctx);
      if (c) onKeyDown(ctx, c);
      break;
    }
    case 'dialRotate': {
      const c = contexts.get(ctx);
      if (c && ['channel', 'nowplaying'].includes(c.action)) rotate(c, (m.payload && m.payload.ticks) || 0);
      else if (c && c.action === 'trackdial') skipTrack(ctx, c, (m.payload && m.payload.ticks) || 0);
      else if (c && c.action === 'appvolume') rotateApp(ctx, c, (m.payload && m.payload.ticks) || 0);
      else if (c && c.action === 'mixdial') rotateLayer(ctx, c, (m.payload && m.payload.ticks) || 0);
      break;
    }
    case 'dialDown': {
      const c = contexts.get(ctx);
      if (c && c.action === 'appvolume') { if (((c.settings || {}).press || 'mute') === 'mute') toggleAppMute(ctx, c); break; }
      if (c && c.action === 'mixdial') { if (((c.settings || {}).press || 'match') === 'match') matchMain(ctx, c); break; }
      if (!c || !['channel', 'nowplaying', 'trackdial'].includes(c.action)) break;
      const s = c.settings || {};
      const what = s.press || (c.action === 'trackdial' ? 'playpause' : 'mute');
      if (what === 'mute') toggleMute(ctx, s.channel);
      else if (what === 'zero') { const ch = chan(s.channel); if (ch) setLevel(ch.key, 0); }
      else if (['playpause', 'next', 'previous'].includes(what)) { if (!media.command(what, s.mediaSource)) showAlert(ctx); }
      break;
    }
    case 'touchTap': {
      const c = contexts.get(ctx);
      if (c && c.action === 'appvolume') { if (((c.settings || {}).tap || 'mute') === 'mute') toggleAppMute(ctx, c); break; }
      if (c && c.action === 'mixdial') { if (((c.settings || {}).tap || 'match') === 'match') matchMain(ctx, c); break; }
      if (!c || !['channel', 'nowplaying', 'trackdial'].includes(c.action)) break;
      const s = c.settings || {};
      const what = s.tap || (c.action === 'channel' ? 'mute' : 'playpause');
      if (what === 'mute') toggleMute(ctx, s.channel);
      else if (['playpause', 'next', 'previous'].includes(what)) { if (!media.command(what, s.mediaSource)) showAlert(ctx); }
      break;
    }
    case 'sendToPlugin': {
      const p = m.payload || {};
      if (p.event === 'lists') { const fresh = contexts.get(ctx) && contexts.get(ctx).action === 'appvolume' ? Promise.all([poll(), pollApps()]) : poll(); fresh.then(() => toPI(m.action, ctx, listsFor(ctx))); toPI(m.action, ctx, listsFor(ctx)); }
      else if (p.event === 'address') { setAddress(p.value); setTimeout(() => toPI(m.action, ctx, listsFor(ctx)), 900); }
      break;
    }
    default:
  }
}

function connect() {
  ws = new Socket(`ws://127.0.0.1:${args.port}`);
  ws.on('open', () => {
    send({ event: args.registerEvent, uuid: args.pluginUUID });
    send({ event: 'getGlobalSettings', context: args.pluginUUID });
  });
  ws.on('message', onMessage);
  ws.on('close', () => { media.stop(); process.exit(0); });
  ws.on('error', () => { media.stop(); process.exit(1); });
}

if (args.port && args.pluginUUID && args.registerEvent) connect();
else console.error('Started without Stream Deck arguments');
