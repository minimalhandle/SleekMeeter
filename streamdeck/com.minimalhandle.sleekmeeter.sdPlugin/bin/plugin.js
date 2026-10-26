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

/* ------------------------------------------------------------------ drawing */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svgUri = (svg) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
const FONT = "font-family=\"Segoe UI, Arial, sans-serif\"";
const AMBER = '#ffb02e', CYAN = '#3ec6e8', RED = '#ff4d5e', GREEN = '#43e08a', PINK = '#ff7ab6', VIOLET = '#a98bff';
const fmtDb = (v) => (v <= -60 ? '-∞' : `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)}`);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const typeColor = (key) => (String(key).startsWith('Bus') ? CYAN : AMBER);

function fit(text, max) {
  const t = String(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
// Up to two lines of centred text, sized to fit.
function lines(text, x, y, color, size) {
  const t = String(text).trim();
  const per = Math.floor(120 / (size * 0.56));
  let rows = [t];
  if (t.length > per) {
    const cut = t.lastIndexOf(' ', per);
    const at = cut > 2 ? cut : per;
    rows = [t.slice(0, at).trim(), fit(t.slice(at).trim(), per)];
  }
  const start = y - ((rows.length - 1) * size * 1.15) / 2;
  return rows.map((r, i) => `<text x="${x}" y="${start + i * size * 1.15}" ${FONT} font-size="${size}" font-weight="700" fill="${color}" text-anchor="middle" dominant-baseline="middle">${esc(r)}</text>`).join('');
}
function keySvg(bg, inner, border) {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="14" fill="${bg}"/>${border ? `<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="${border}" stroke-width="4"/>` : ''}${inner}</svg>`);
}
const label = (text, color = '#9aa3b2') => `<text x="72" y="22" ${FONT} font-size="15" font-weight="600" fill="${color}" text-anchor="middle" letter-spacing="1">${esc(text)}</text>`;
const speaker = (x, y, s, color, slash) => `<g transform="translate(${x} ${y}) scale(${s})" fill="${color}"><path d="M-22 -9h12l16 -14v46l-16 -14h-12z"/>${slash ? '' : `<path d="M14 -12q10 12 0 24" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/><path d="M22 -22q18 22 0 44" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>`}${slash ? `<path d="M12 -14l22 28M34 -14l-22 28" stroke="${RED}" stroke-width="6" stroke-linecap="round"/>` : ''}</g>`;

// A big microphone: green LIVE when open, red with a line through it when muted.
const micGlyph = (color) => `<g fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"><rect x="58" y="22" width="28" height="52" rx="14" fill="${color}" stroke="none"/><path d="M46 60a26 26 0 0 0 52 0"/><path d="M72 88v14M58 104h28"/></g>`;
const MIC_DEFAULT = 'Strip[0]';

function offlineKey(title) {
  const msg = status === 'key' ? ['Wrong key', 'Open the action settings'] : status === 'novm' ? ['Voicemeeter', 'isn’t running'] : ['Sleekmeeter', 'not found'];
  return keySvg('#16181d', `${label(title)}<text x="72" y="74" ${FONT} font-size="17" font-weight="700" fill="#e8ebf2" text-anchor="middle">${esc(msg[0])}</text><text x="72" y="98" ${FONT} font-size="13" fill="#8b93a3" text-anchor="middle">${esc(msg[1])}</text>`);
}

function renderKey(c) {
  const s = c.settings || {};
  const ok = status === 'ok' && st;
  switch (c.action) {
    case 'mute': {
      const ch = ok && chan(s.channel);
      if (!ok) return offlineKey('MUTE');
      if (!ch) return keySvg('#16181d', `${label('MUTE')}${lines('Pick a channel', 72, 78, '#e8ebf2', 17)}`);
      const m = muteOf(ch);
      return keySvg(m ? '#4a1822' : '#16181d', `<text x="72" y="26" ${FONT} font-size="${ch.name.length > 9 ? 15 : 18}" font-weight="700" fill="${m ? '#ffd0d6' : typeColor(ch.key)}" text-anchor="middle">${esc(fit(ch.name, 12))}</text>${speaker(72, 70, 1.15, m ? '#ffd0d6' : '#e8ebf2', m)}<text x="72" y="124" ${FONT} font-size="20" font-weight="700" fill="${m ? '#ffd0d6' : '#9aa3b2'}" text-anchor="middle">${m ? 'MUTED' : `${fmtDb(gainOf(ch))} dB`}</text>`, m ? RED : null);
    }
    case 'mic': {
      if (!ok) return offlineKey('MIC');
      const ch = chan(s.channel || MIC_DEFAULT);
      if (!ch) return keySvg('#16181d', `${label('MIC')}${lines('Pick a channel', 72, 78, '#e8ebf2', 17)}`);
      const m = muteOf(ch);
      const name = `<text x="72" y="24" ${FONT} font-size="${ch.name.length > 9 ? 14 : 17}" font-weight="700" fill="${m ? '#ffc2ca' : '#8be8b3'}" text-anchor="middle">${esc(fit(ch.name, 12))}</text>`;
      if (m) {
        return keySvg('#5a1224', `${name}${micGlyph('#ffb3bd')}<path d="M40 42L108 110" stroke="#5a1224" stroke-width="17" stroke-linecap="round"/><path d="M40 42L108 110" stroke="${RED}" stroke-width="9" stroke-linecap="round"/><text x="72" y="134" ${FONT} font-size="20" font-weight="800" fill="#ffd0d6" text-anchor="middle" letter-spacing="2">MUTED</text>`, RED);
      }
      return keySvg('#0d2a1c', `${name}${micGlyph(GREEN)}<text x="72" y="134" ${FONT} font-size="20" font-weight="800" fill="#a8f0c9" text-anchor="middle" letter-spacing="2">LIVE</text>`, GREEN);
    }
    case 'level': {
      const ch = ok && chan(s.channel);
      if (!ok) return offlineKey('LEVEL');
      if (!ch) return keySvg('#16181d', `${label('LEVEL')}${lines('Pick a channel', 72, 78, '#e8ebf2', 17)}`);
      const mode = s.mode || 'up';
      const amt = Number(s.amount) || 2;
      const big = mode === 'set' ? `${fmtDb(Number(s.amount) || 0)}` : `${mode === 'up' ? '+' : '−'}${amt}`;
      const arrow = mode === 'up' ? '<path d="M72 36l22 26h-14v18h-16v-18h-14z" fill="#43e08a"/>' : mode === 'down' ? '<path d="M72 80l22 -26h-14v-18h-16v18h-14z" fill="#ff7ab6"/>' : '<rect x="30" y="52" width="84" height="8" rx="4" fill="#4b5262"/><circle cx="84" cy="56" r="13" fill="#a98bff"/>';
      return keySvg('#16181d', `<text x="72" y="24" ${FONT} font-size="${ch.name.length > 9 ? 15 : 18}" font-weight="700" fill="${typeColor(ch.key)}" text-anchor="middle">${esc(fit(ch.name, 12))}</text>${arrow}<text x="72" y="116" ${FONT} font-size="24" font-weight="700" fill="#e8ebf2" text-anchor="middle">${esc(big)} dB</text>`);
    }
    case 'scene': {
      if (!ok) return offlineKey('SCENE');
      return keySvg('#241b3a', `${label('SCENE', '#b9a4ff')}${s.scene ? lines(s.scene, 72, 80, '#f3eeff', 22) : lines('Pick a scene', 72, 80, '#e8ebf2', 17)}`, VIOLET);
    }
    case 'sound': {
      if (!ok) return offlineKey('SOUND');
      return keySvg('#3a1d2c', `<path d="M58 34l30 18l-30 18z" fill="${PINK}" transform="translate(-2 -2)"/>${s.sound ? lines(s.sound, 72, 106, '#ffe3ef', 19) : lines('Pick a sound', 72, 106, '#e8ebf2', 16)}`, PINK);
    }
    case 'soundstop':
      return keySvg('#16181d', `<rect x="48" y="30" width="48" height="48" rx="8" fill="#e8ebf2"/>${lines('Stop sounds', 72, 108, '#9aa3b2', 17)}`);
    case 'brb': {
      if (!ok) return offlineKey('BRB');
      const on = !!st.brb;
      return keySvg(on ? '#46300a' : '#16181d', `${label('BE RIGHT BACK', on ? '#ffd27a' : '#9aa3b2')}<g fill="${on ? AMBER : '#e8ebf2'}"><rect x="52" y="38" width="14" height="44" rx="4"/><rect x="78" y="38" width="14" height="44" rx="4"/></g><text x="72" y="116" ${FONT} font-size="22" font-weight="700" fill="${on ? '#ffd27a' : '#9aa3b2'}" text-anchor="middle">${on ? 'ON' : st.brbSet ? 'off' : 'not set up'}</text>`, on ? AMBER : null);
    }
    case 'record': {
      if (!ok) return offlineKey('RECORD');
      const on = !!st.recording;
      return keySvg(on ? '#4a1822' : '#16181d', `${label('RECORD', on ? '#ffd0d6' : '#9aa3b2')}<circle cx="72" cy="66" r="${on ? 26 : 24}" fill="${on ? RED : '#e8ebf2'}"/><text x="72" y="116" ${FONT} font-size="22" font-weight="700" fill="${on ? '#ffd0d6' : '#9aa3b2'}" text-anchor="middle">${on ? 'REC' : 'off'}</text>`, on ? RED : null);
    }
    case 'duck': {
      if (!ok) return offlineKey('DUCKING');
      const on = !!st.duck;
      const bars = [46, 34, 22, 14].map((h, i) => `<rect x="${34 + i * 20}" y="${74 - h}" width="12" height="${h}" rx="4" fill="${on ? GREEN : '#e8ebf2'}" opacity="${1 - i * 0.12}"/>`).join('');
      return keySvg(on ? '#10372a' : '#16181d', `${label('TALK-OVER', on ? '#a8f0c9' : '#9aa3b2')}${bars}<text x="72" y="116" ${FONT} font-size="22" font-weight="700" fill="${on ? '#a8f0c9' : '#9aa3b2'}" text-anchor="middle">${on ? 'ON' : 'off'}</text>`, on ? GREEN : null);
    }
    case 'output': {
      if (!ok) return offlineKey('OUTPUT');
      const name = s.output || '';
      const active = name && st.outputNow === name;
      return keySvg(active ? '#0f2f3a' : '#16181d', `${label('OUTPUT', active ? '#9fe3f7' : '#9aa3b2')}<path d="M34 64h44m-14 -16l16 16l-16 16" fill="none" stroke="${active ? CYAN : '#e8ebf2'}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="88" y="46" width="24" height="36" rx="5" fill="${active ? CYAN : '#e8ebf2'}"/>${lines(name || 'Next output', 72, 114, active ? '#9fe3f7' : '#e8ebf2', 17)}`, active ? CYAN : null);
    }
    default:
      return null;
  }
}

// The touch-strip panel for a dial: 200 x 100.
function renderDial(c) {
  const s = c.settings || {};
  const wrap = (inner, bg = '#14171c') => svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" rx="10" fill="${bg}"/>${inner}</svg>`);
  if (status !== 'ok' || !st) {
    const msg = status === 'key' ? 'Wrong key' : status === 'novm' ? 'Voicemeeter not running' : 'Sleekmeeter not found';
    return wrap(`<text x="100" y="46" ${FONT} font-size="16" font-weight="700" fill="#e8ebf2" text-anchor="middle">${esc(msg)}</text><text x="100" y="68" ${FONT} font-size="12" fill="#8b93a3" text-anchor="middle">${status === 'key' ? 'Check the action settings' : 'Is Sleekmeeter open?'}</text>`);
  }
  const ch = chan(s.channel);
  if (!ch) return wrap(`<text x="100" y="50" ${FONT} font-size="16" font-weight="700" fill="#e8ebf2" text-anchor="middle">Pick a channel</text><text x="100" y="72" ${FONT} font-size="12" fill="#8b93a3" text-anchor="middle">Open the action settings</text>`);
  const g = gainOf(ch), m = muteOf(ch);
  const col = typeColor(ch.key);
  const frac = clamp((g + 60) / 72, 0, 1);
  const unity = (60 / 72) * 170 + 15;
  const bar = `<rect x="15" y="80" width="170" height="8" rx="4" fill="#2a2f39"/><rect x="15" y="80" width="${(170 * frac).toFixed(1)}" height="8" rx="4" fill="${m ? '#4b5262' : col}"/><rect x="${unity.toFixed(1)}" y="76" width="2" height="16" fill="#8b93a3"/>`;
  const name = `<text x="15" y="25" ${FONT} font-size="${ch.name.length > 11 ? 14 : 17}" font-weight="700" fill="${m ? '#8b93a3' : col}">${esc(fit(ch.name, 16))}</text>`;
  if (m) {
    return wrap(`${name}<text x="185" y="25" ${FONT} font-size="12" font-weight="700" fill="${RED}" text-anchor="end" letter-spacing="1">MUTED</text>${speaker(52, 54, 0.8, '#8b93a3', true)}<text x="185" y="62" ${FONT} font-size="30" font-weight="700" fill="#6c7585" text-anchor="end">${esc(fmtDb(g))}</text>${bar}`, '#241418');
  }
  return wrap(`${name}<text x="185" y="62" ${FONT} font-size="${Math.abs(g) >= 10 ? 38 : 42}" font-weight="700" fill="#f2f4f8" text-anchor="end">${esc(fmtDb(g))}<tspan font-size="14" fill="#8b93a3" dx="3">dB</tspan></text>${bar}`);
}

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
  renderAll();
}
function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, 450);
}
function stopPollingIfIdle() {
  if (contexts.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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

function rotate(c, ticks) {
  const ch = chan((c.settings || {}).channel);
  if (!ch) return;
  const step = Number((c.settings || {}).step) || 1;
  // A quick spin moves further per click.
  const t = Math.abs(ticks) > 1 ? ticks * (1 + (Math.abs(ticks) - 1) * 0.5) : ticks;
  setLevel(ch.key, gainOf(ch) + t * step);
}

function onKeyDown(context, c) {
  const s = c.settings || {};
  switch (c.action) {
    case 'mute': return toggleMute(context, s.channel);
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
      if (c) { c.settings = (m.payload && m.payload.settings) || {}; lastDrawn.delete(ctx); render(ctx); }
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
      if (c && c.action === 'channel') rotate(c, (m.payload && m.payload.ticks) || 0);
      break;
    }
    case 'dialDown': {
      const c = contexts.get(ctx);
      if (!c || c.action !== 'channel') break;
      const s = c.settings || {};
      const what = s.press || 'mute';
      if (what === 'mute') toggleMute(ctx, s.channel);
      else if (what === 'zero') { const ch = chan(s.channel); if (ch) setLevel(ch.key, 0); }
      break;
    }
    case 'touchTap': {
      const c = contexts.get(ctx);
      if (!c || c.action !== 'channel') break;
      const s = c.settings || {};
      if ((s.tap || 'mute') === 'mute') toggleMute(ctx, s.channel);
      break;
    }
    case 'sendToPlugin': {
      const p = m.payload || {};
      if (p.event === 'lists') { poll().then(() => toPI(m.action, ctx, listsFor(ctx))); toPI(m.action, ctx, listsFor(ctx)); }
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
  ws.on('close', () => process.exit(0));
  ws.on('error', () => process.exit(1));
}

if (args.port && args.pluginUUID && args.registerEvent) connect();
else console.error('Started without Stream Deck arguments');
