// Draws every key: Afterclip's lit rewind ring, with the number or symbol where the logo has its A.
// Used by the plugin for live keys, and by scripts/build-plugin.js for the images keys start with.
// Stream Deck's SVG support is limited, so glow is built from layers rather than filters.
const RING = require('./ring.cjs');

const COLOURS = {
  ink: '#120f2e', panel: '#171433', ring: '#7c6cff', accent: '#5b49e6', text: '#ffffff', muted: '#9a95bd', soft: '#c9c1ff', fail: '#f0554f',
};
// The ring's size on a key, from the logo's shapes in ring.cjs.
const RING_RADIUS = 54;
const CENTRE = 72;

const text = (value, y, size, fill, weight = 700, opacity = 1) => `<text x="72" y="${y}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-weight="${weight}" font-size="${size}" fill="${fill}" fill-opacity="${opacity}">${value}</text>`;

const SYMBOLS = {
  record: (fill) => `<circle cx="72" cy="64" r="17" fill="${fill}"/>`,
  stop: (fill) => `<rect x="57" y="49" width="30" height="30" rx="6" fill="${fill}"/>`,
  mic: (fill) => `<rect x="63" y="38" width="18" height="33" rx="9" fill="${fill}"/><path d="M55 60a17 17 0 0 0 34 0M72 77v8" fill="none" stroke="${fill}" stroke-width="4.5" stroke-linecap="round"/>`,
  micMuted: (fill, background) => `${SYMBOLS.mic(fill)}<path d="M52 39l40 45" stroke="${background}" stroke-width="9"/><path d="M52 39l40 45" stroke="${fill}" stroke-width="4.5" stroke-linecap="round"/>`,
  clean: (fill) => `<path d="M68 38l6 18 18 6-18 6-6 18-6-18-18-6 18-6z" fill="${fill}"/><path d="M92 66l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="${fill}"/>`,
  marker: (fill) => `<path d="M60 86V42h28l-8 11 8 11H60" fill="${fill}" stroke="${fill}" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/>`,
  panel: (fill) => `<rect x="50" y="42" width="44" height="42" rx="7" fill="none" stroke="${fill}" stroke-width="4.5"/><circle cx="72" cy="60" r="8" fill="none" stroke="${fill}" stroke-width="4"/><path d="M58 76h28" stroke="${fill}" stroke-width="4" stroke-linecap="round"/>`,
  folder: (fill) => `<path d="M48 49a4 4 0 0 1 4-4h13l6 7h21a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H52a4 4 0 0 1-4-4z" fill="${fill}"/>`,
  edit: (fill) => `<path d="M52 42h40v42H52z" fill="none" stroke="${fill}" stroke-width="4.5" stroke-linejoin="round"/><path d="M63 42v42M81 42v42" stroke="${fill}" stroke-width="4"/><path d="M52 55h11M52 71h11M81 55h11M81 71h11" stroke="${fill}" stroke-width="3.5"/>`,
  copy: (fill, background) => `<rect x="50" y="38" width="30" height="36" rx="5" fill="none" stroke="${fill}" stroke-width="4.5"/><rect x="62" y="50" width="30" height="36" rx="5" fill="${background}" stroke="${fill}" stroke-width="4.5"/>`,
  camera: (fill, background) => `<path d="M50 50h9l5-8h16l5 8h9a3 3 0 0 1 3 3v27a3 3 0 0 1-3 3H50a3 3 0 0 1-3-3V53a3 3 0 0 1 3-3z" fill="${fill}"/><circle cx="72" cy="65" r="10" fill="${background}"/>`,
  alert: (fill) => `<rect x="67.5" y="38" width="9" height="30" rx="4.5" fill="${fill}"/><circle cx="72" cy="79" r="5.5" fill="${fill}"/>`,
  // Four corners pointing in: the same picture, smaller.
  compress: (fill) => `<path d="M50 42l13 13M63 45v10H53M94 42L81 55M81 45v10h10M50 86l13-13M63 83V73H53M94 86L81 73M81 83V73h10" fill="none" stroke="${fill}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  // A webcam on its stand.
  webcam: (fill, background) => `<circle cx="72" cy="58" r="19" fill="${fill}"/><circle cx="72" cy="58" r="7.5" fill="${background}"/><path d="M72 77v8M58 87h28" stroke="${fill}" stroke-width="4.5" stroke-linecap="round"/>`,
  webcamOff: (fill, background) => `${SYMBOLS.webcam(fill, background)}<path d="M50 38l44 48" stroke="${background}" stroke-width="9"/><path d="M50 38l44 48" stroke="${fill}" stroke-width="4.5" stroke-linecap="round"/>`,
  star: (fill) => `<path d="M72 38l7.6 15.4 17 2.5-12.3 12 2.9 16.9L72 76.8l-15.2 8 2.9-16.9-12.3-12 17-2.5z" fill="${fill}" stroke="${fill}" stroke-width="2" stroke-linejoin="round"/>`,
  // A phone held upright, with the webcam across its top.
  vertical: (fill) => `<rect x="57" y="38" width="30" height="50" rx="6" fill="none" stroke="${fill}" stroke-width="4.5"/><rect x="62.5" y="44" width="19" height="12" rx="2" fill="${fill}"/><rect x="62.5" y="60" width="19" height="22" rx="2" fill="${fill}" fill-opacity=".5"/>`,
  // A paper plane, for sending somewhere.
  send: (fill, background) => `<path d="M46 63l50-22-15 50-12-17z" fill="${fill}" stroke="${fill}" stroke-width="3" stroke-linejoin="round"/><path d="M69 74l27-33" stroke="${background}" stroke-width="3.5"/>`,
};

function ringLayer(colour, head, width, opacity) {
  const shape = RING.replace(/stroke-width="[^"]+"/, `stroke-width="${width}"`).replace('stroke="COLOUR"', `stroke="${colour}" stroke-linecap="round"`).replace('fill="COLOUR"', `fill="${head}"`);
  return `<g opacity="${opacity}">${shape}</g>`;
}

function keyBackground(top, bottom) {
  return `<defs><linearGradient id="back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`
    + '<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".14"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d8d2ff"/><stop offset="1" stop-color="#6a58f0"/></linearGradient></defs>'
    + '<rect width="144" height="144" fill="url(#back)"/><rect width="144" height="52" fill="url(#sheen)"/>';
}

const TONES = {
  normal: { top: '#231e52', bottom: COLOURS.ink, flat: COLOURS.ink, main: COLOURS.text, label: COLOURS.soft },
  active: { top: '#7362f5', bottom: '#3a2bb8', flat: COLOURS.accent, main: COLOURS.text, label: COLOURS.text },
  off: { top: COLOURS.panel, bottom: '#100e24', flat: COLOURS.panel, main: COLOURS.muted, label: COLOURS.muted },
  fail: { top: '#2a1a3f', bottom: COLOURS.ink, flat: COLOURS.ink, main: COLOURS.fail, label: COLOURS.text },
};

function ringFor(tone) {
  if (tone === 'off') return ringLayer(COLOURS.muted, COLOURS.muted, 7, 0.55);
  if (tone === 'active') return ringLayer('#ffffff', '#ffffff', 11, 0.22) + ringLayer('#ffffff', '#ffffff', 7, 1);
  if (tone === 'fail') return ringLayer(COLOURS.fail, COLOURS.fail, 12, 0.18) + ringLayer(COLOURS.fail, COLOURS.fail, 7, 1);
  return ringLayer(COLOURS.ring, COLOURS.ring, 15, 0.1) + ringLayer(COLOURS.ring, COLOURS.ring, 11, 0.2) + ringLayer('url(#lit)', COLOURS.soft, 7, 1);
}

/**
 * face: { big, small } for text in the ring, or { symbol, small }. tone: normal, active (lit, for saving,
 * recording or muted), off (dimmed, when the action isn't available), or fail. mark tags a key for the tests.
 */
function keySvg({ big, small, symbol, tone = 'normal', mark }) {
  const look = TONES[tone];
  const size = !big ? 0 : big.length > 3 ? 26 : big.length > 2 ? 33 : 44;
  const label = small ? text(small, symbol ? 103 : 97, small.length > 7 ? 10.5 : small.length > 5 ? 12 : 14, look.label, 600) : '';
  const middle = symbol ? SYMBOLS[symbol](look.main, look.flat) : text(big, small ? 79 : 86, size, look.main);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"${mark ? ` data-mark="${mark}"` : ''}>${keyBackground(look.top, look.bottom)}${ringFor(tone)}${middle}${label}</svg>`;
}

const clamp = (value) => Math.min(1, Math.max(0, value));

/** The ring as an arc from the top, clockwise. It leaves out the logo's gap, so it can close into a full circle. */
function arc(progress) {
  const angle = clamp(progress) * Math.PI * 2 * 0.9999 - Math.PI / 2;
  const x = (CENTRE + RING_RADIUS * Math.cos(angle)).toFixed(2);
  const y = (CENTRE + RING_RADIUS * Math.sin(angle)).toFixed(2);
  return `M72 ${CENTRE - RING_RADIUS}A${RING_RADIUS} ${RING_RADIUS} 0 ${progress > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

const TICK = [[52, 63], [66, 77], [93, 46]];

/** The tick, drawn along its length, so it can be stroked in. */
function tickPath(progress) {
  const lengths = TICK.slice(1).map(([x, y], i) => Math.hypot(x - TICK[i][0], y - TICK[i][1]));
  let left = clamp(progress) * (lengths[0] + lengths[1]);
  const points = [TICK[0]];
  lengths.forEach((length, i) => {
    const part = Math.min(left, length) / length;
    if (part > 0) points.push([TICK[i][0] + (TICK[i + 1][0] - TICK[i][0]) * part, TICK[i][1] + (TICK[i + 1][1] - TICK[i][1]) * part]);
    left -= Math.min(left, length);
  });
  return `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}`;
}

/**
 * One moment of the saved animation, as t goes from 0 to 1: the ring closes into a full lit circle,
 * a tick draws in, and a band of light crosses the key, like the shine on Afterclip's toast.
 */
function confirmSvg(label, t, mark) {
  const closing = clamp(t / 0.5);
  const drawing = clamp((t - 0.3) / 0.4);
  const shine = -70 + 300 * clamp((t - 0.25) / 0.6);
  const circle = (width, opacity) => `<path d="${arc(closing)}" fill="none" stroke="#ffffff" stroke-width="${width}" stroke-linecap="round" stroke-opacity="${opacity}"/>`;
  const tick = (width, opacity) => (drawing > 0 ? `<path d="${tickPath(drawing)}" fill="none" stroke="#ffffff" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${opacity}"/>` : '');
  const band = t < 0.85 ? `<polygon points="${shine},0 ${shine + 34},0 ${shine - 16},144 ${shine - 50},144" fill="#ffffff" fill-opacity=".2"/>` : '';
  const words = text(label, 103, label.length > 6 ? 12 : 15, '#ffffff', 700, clamp((t - 0.4) / 0.3));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"${mark ? ` data-mark="${mark}"` : ''}>${keyBackground('#7c6cff', '#3a2bb8')}${circle(18, 0.16)}${circle(13, 0.28)}${circle(8.5, 1)}${tick(13, 0.22)}${tick(7.5, 1)}${band}${words}</svg>`;
}

/** The small white icon in Stream Deck's action list. */
function listIcon(label) {
  const size = label.length > 1 ? 46 : 58;
  const ring = RING.replaceAll('COLOUR', '#ffffff');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 144 144">${ring}${text(label, 92, size, '#ffffff')}</svg>`;
}

module.exports = { keySvg, confirmSvg, listIcon, COLOURS };
