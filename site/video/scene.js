// Sleekmeeter showcase: a Stream Deck + in a dark studio, drawn with the plugins' own key renderers.
// Frames are rendered one at a time (window.video.renderFrame) so the result is the same on every run.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const params = new URLSearchParams(location.search);
export const FPS = 30;
export const DURATION = 45;
const SAMPLES = Number(params.get('samples')) || 24;
const SHUTTER = 0.5 / FPS;
const W = innerWidth, H = innerHeight;

// Where each part of the film starts.
const T = { keys: 5, dials: 10, playing: 15.5, route: 20, stream: 23.8, orbit: 27.5, clipKeys: 31.5, clipApp: 35.7, end: 38.5 };
const SONG = { title: 'Night Owl', artist: 'Broke For Free', duration: 194, cover: 'assets/night-owl.jpg' };

// ---------- small helpers ----------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (x, a = 0, b = 1) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const ease = u => u * u * (3 - 2 * u);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const svgUri = svg => 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
// Smooth pseudo-random signal in 0..1 that stands in for an audio level.
const wobble = (t, seed) => clamp(.5 + .22 * Math.sin(t * 7.3 + seed) + .17 * Math.sin(t * 13.1 + seed * 2.7) + .13 * Math.sin(t * 23.7 + seed * 5.1) + .1 * Math.sin(t * 3.1 + seed * 1.3));

// ---------- the story: what the mixer and the clipper are doing at time t ----------
// Every key press in the film: which key slot (0-7, left to right, top row first) goes down, and when.
const PRESS = {
  mute: { key: 0, t: 6.5 }, unmute: { key: 0, t: 8.3 },
  routeB1: { key: 1, t: 21.2 }, swap: { key: 3, t: 22.4 },
  brb: { key: 0, t: 24.8 }, horn: { key: 4, t: 26.3 },
  record: { key: 5, t: 28.7 }, output: { key: 7, t: 30.0 },
  save: { key: 1, t: 34.2 }, // the Afterclip "30 SEC" key
};
const PRESSES = Object.values(PRESS);
const did = (press, t) => t >= press.t + .09;
const pressDepth = (key, t) => PRESSES.reduce((d, p) => p.key !== key ? d : Math.max(d, t < p.t ? 0 : t < p.t + .09 ? (t - p.t) / .09 : 1 - smooth(t, p.t + .16, p.t + .34)), 0);
const brbOn = t => did(PRESS.brb, t) && t < T.orbit;
// Be right back fades the game and music down; before that the Game dial is turned up by hand.
const brbFade = t => brbOn(t) ? smooth(t, PRESS.brb.t + .09, PRESS.brb.t + 1.2) : 0;
const gameGain = t => lerp(-8.5, -3, ease(clamp((t - 11.2) / 2.6))) - 21 * brbFade(t);
function mixer(t) {
  const micMuted = (did(PRESS.mute, t) && !did(PRESS.unmute, t)) || brbOn(t);
  const swapped = did(PRESS.swap, t) && t < T.stream, musicGain = -14 - 16 * brbFade(t);
  const chans = {
    'Strip[0]': { key: 'Strip[0]', name: 'Mic', gain: -2.5, mute: micMuted, partMute: [], level: micMuted ? -60 : -34 + 26 * wobble(t, 1) },
    'Strip[1]': { key: 'Strip[1]', name: 'Game', gain: gameGain(t), mute: false, level: gameGain(t) - 26 + 22 * wobble(t, 4) },
    'Strip[2]': { key: 'Strip[2]', name: 'Music', gain: musicGain, mute: false, level: musicGain - 26 + 22 * wobble(t * .8, 9) },
    'Strip[3]': { key: 'Strip[3]', name: 'Studio mic', gain: 0, mute: false, level: -30 },
  };
  // Which input goes to which output. The swap key trades the two mics on B2.
  const routes = { 'Strip[0]:A1': false, 'Strip[0]:B1': did(PRESS.routeB1, t), 'Strip[0]:B2': !swapped, 'Strip[3]:B2': swapped, 'Strip[1]:A1': true, 'Strip[1]:B1': false, 'Strip[1]:B2': true };
  const e = {
    status: 'ok',
    st: { brbSet: true, brb: brbOn(t), recording: did(PRESS.record, t), duck: true, outputNow: did(PRESS.output, t) ? 'Speakers' : 'Headphones', micFx: { 'Strip[0]': { on: true } } },
    chan: k => chans[k] || null, gainOf: c => c.gain, muteOf: c => c.mute, routeOf: (c, bus) => !!routes[`${c.key}:${bus}`],
    levelOf: c => c.level, breath: () => .5 + .5 * Math.sin(t * 2.4),
  };
  const media = { available: true, title: SONG.title, artist: SONG.artist, position: 47 + t, duration: SONG.duration, playing: true, art: cover.small };
  return { e, media, discord: 64 };
}
// The deck has more than one page of keys. `lead` is how long after the page's part starts that its keys
// turn over, one by one; a negative lead means the page is already showing when the camera cuts to it.
const PAGES = [
  { id: 'route', t0: T.route, t1: T.stream, lead: .35 },
  { id: 'stream', t0: T.stream, t1: T.orbit, lead: -1 },
  { id: 'clip', t0: T.clipKeys, t1: T.end, lead: .55 },
];
const flipTime = (page, slot) => page.t0 + page.lead + slot * .07;
const pageAt = (slot, t) => { const p = PAGES.find(p => t >= p.t0 && t < p.t1 && t >= flipTime(p, slot)); return p ? p.id : 'main'; };
const onClipPage = (slot, t) => pageAt(slot, t) === 'clip';
const flipDim = (slot, t) => PAGES.reduce((dim, p) => t >= p.t0 && t < p.t1 ? Math.min(dim, clamp(Math.abs(t - flipTime(p, slot)) / .13)) : dim, 1);
function clipKeys(t) {
  const s = t - PRESS.save.t - .09;
  const save = s < 0 ? clipArt.keySvg({ big: '30', small: 'SEC' }) : s < .5 ? clipArt.keySvg({ big: '30', small: 'SAVING', tone: 'active' }) : s < 3.2 ? clipArt.confirmSvg('SAVED', (s - .5) / 1.0) : clipArt.keySvg({ big: '30', small: 'SEC' });
  return [
    clipArt.keySvg({ big: '15', small: 'SEC' }), save, clipArt.keySvg({ big: '1', small: 'MIN' }), clipArt.keySvg({ big: 'FULL', small: 'BUFFER' }),
    clipArt.keySvg({ symbol: 'record', small: 'REC' }), clipArt.keySvg({ symbol: 'mic', small: 'MIC ON' }), clipArt.keySvg({ symbol: 'clean', small: 'CLEAN MIC' }), clipArt.keySvg({ symbol: 'folder', small: 'CLIPS' }),
  ].map(svgUri);
}
// Afterclip's dials use Stream Deck's built-in layout: a title, an icon, a value and a bar.
function clipPanel({ title, value, icon, fill }) {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><defs><clipPath id="i"><rect x="12" y="36" width="50" height="50" rx="7"/></clipPath></defs><rect width="200" height="100" fill="#000"/>`
    + `<text x="12" y="24" font-family="Segoe UI, sans-serif" font-size="14" font-weight="600" fill="#d6d6de">${title}</text><image x="12" y="36" width="50" height="50" href="${svgUri(clipArt.keySvg(icon))}" clip-path="url(#i)"/>`
    + `<text x="188" y="62" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="21" font-weight="600" fill="#fff">${value}</text>`
    + `<rect x="74" y="76" width="114" height="6" rx="3" fill="#26262f"/><rect x="74" y="76" width="${(114 * clamp(fill)).toFixed(1)}" height="6" rx="3" fill="#7c6cff"/></svg>`);
}

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(30, W / H, 1, 400);

// Studio reflections: a few softboxes on black, so glossy keys and metal dials pick up clean highlights.
{
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x000000);
  const box = (w, h, pos, look, power) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(power), side: THREE.DoubleSide })); m.position.copy(pos); m.lookAt(look); env.add(m); };
  // Nothing sits where the tilted screens would mirror it straight into the camera.
  box(70, 16, V(0, 40, -44), V(0, 6, 0), 6);     // back rim, high
  box(8, 60, V(-54, 16, 4), V(0, 6, 0), 3.4);    // left strip
  box(8, 40, V(54, 14, -8), V(0, 6, 0), 1.6);    // right strip, dimmer
  box(14, 14, V(-6, 54, -6), V(0, 0, 0), 1.1);   // small top light for the dial caps
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, .03).texture;
}

// Lights
const keyLight = new THREE.SpotLight(0xfff4e8, 0, 0, .36, 1, 0);
// From the upper left, so its mirror image in the glossy face lands off to the right, away from every camera.
const KEY_POS = V(-36, 35, 14);
keyLight.position.copy(KEY_POS);
keyLight.target.position.set(0, 5, 0);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -.0004;
keyLight.shadow.normalBias = .03;
keyLight.shadow.camera.near = 20; keyLight.shadow.camera.far = 95;
scene.add(keyLight, keyLight.target);
// Two tight edge lights so the dials and the body's rim read against the dark.
const rimLight = new THREE.SpotLight(0xc4d4ff, 0, 0, .32, 1, 0); rimLight.position.set(-22, 24, -28); rimLight.target.position.set(0, 6, 0);
const sideLight = new THREE.SpotLight(0xffe2c4, 0, 0, .32, 1, 0); sideLight.position.set(-34, 10, 12); sideLight.target.position.set(0, 5, 1);
scene.add(rimLight, rimLight.target, sideLight, sideLight.target);
const RIM_COOL = new THREE.Color(0xc4d4ff), RIM_CLIP = new THREE.Color(0x9d8cff);

// Floor and backdrop
const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: .8, metalness: 0, envMapIntensity: .04 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
const backdropMat = new THREE.ShaderMaterial({
  uniforms: { gain: { value: 0 }, tint: { value: new THREE.Color(.36, .375, .4) } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'uniform float gain;uniform vec3 tint;varying vec2 vUv;void main(){vec2 p=(vUv-vec2(.5,.4))*vec2(1.7,2.3);float g=exp(-dot(p,p)*9.)*smoothstep(.2,.62,vUv.y);gl_FragColor=vec4(tint*g*gain,1.);}',
});
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(260, 120), backdropMat);
backdrop.position.set(0, 40, -75); scene.add(backdrop);
const GLOW_NEUTRAL = new THREE.Color(.36, .375, .4), GLOW_CLIP = new THREE.Color(.3, .25, .62);

// ---------- the deck: a Stream Deck + shaped controller (no maker's marks) ----------
function roundedRect(w, h, r, cy = 0) {
  const s = new THREE.Shape(), x = -w / 2, y = cy - h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  return s;
}
// A rounded slab whose front face sits at z = 0 and whose body extends back to -depth.
function slab(w, h, r, depth, bevel, hole) {
  const shape = roundedRect(w - bevel * 2, h - bevel * 2, Math.max(.01, r - bevel));
  if (hole) shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5, curveSegments: 24 });
  g.translate(0, 0, -depth + bevel);
  return g;
}
// The face is 14 x 13.8 cm, nearly square like the real one, and leans back 35 degrees on a flat foot.
const FACE_W = 14, FACE_H = 13.8, PLATE = .38, BODY_D = 2.0;
const TILT = THREE.MathUtils.degToRad(35);
const deck = new THREE.Group();
deck.rotation.x = -TILT;
deck.position.set(0, FACE_H / 2 * Math.cos(TILT) + BODY_D * Math.sin(TILT), 0);
scene.add(deck);

const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x0d0e10, roughness: .5, clearcoat: .3, clearcoatRoughness: .4 });
const wellMat = new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: .38, clearcoat: .5, clearcoatRoughness: .3 });
const glossMat = new THREE.MeshPhysicalMaterial({ color: 0x030304, roughness: .16, clearcoat: 1, clearcoatRoughness: .08 });
const shadowed = m => { m.castShadow = true; m.receiveShadow = true; return m; };

// Front plate with the long dial well cut out of it, over a solid back.
const WELL = { y: -4.4, w: 12.1, h: 2.7 };
{
  const hole = roundedRect(WELL.w, WELL.h, WELL.h / 2 - .02, WELL.y);
  deck.add(shadowed(new THREE.Mesh(slab(FACE_W, FACE_H, 1.3, PLATE, .1, hole), bodyMat)));
  const back = shadowed(new THREE.Mesh(slab(FACE_W, FACE_H, 1.3, BODY_D - PLATE, .26), bodyMat)); back.position.z = -PLATE; deck.add(back);
  const well = new THREE.Mesh(slab(WELL.w + .1, WELL.h + .1, WELL.h / 2, .06, .01), wellMat); well.position.set(0, WELL.y, -PLATE + .05); well.receiveShadow = true; deck.add(well);
  // The stand: a spine down the back and a flat foot reaching behind.
  const spine = shadowed(new THREE.Mesh(slab(10.4, 5.2, .6, 1.0, .14), bodyMat)); spine.position.set(0, -4.2, -BODY_D + .1); deck.add(spine);
  const foot = shadowed(new THREE.Mesh(slab(10.4, 10.6, 1.1, .95, .16), bodyMat));
  foot.rotation.x = -Math.PI / 2; foot.position.set(0, .95, -3.1); scene.add(foot);
}

function screenTexture(w, h) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { canvas, ctx: canvas.getContext('2d'), tex };
}
const screenMat = tex => new THREE.MeshPhysicalMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, roughness: .25, clearcoat: 1, clearcoatRoughness: .05, envMapIntensity: .14 });

// Keys: 4 x 2
const KEY_X = [-4.425, -1.475, 1.475, 4.425], KEY_Y = [4.5, 1.72], KEY_SIZE = 2.12, KEY_RISE = .3;
const keys = [];
const keyGeo = slab(KEY_SIZE, KEY_SIZE, .34, .5, .08), keyScreenGeo = new THREE.PlaneGeometry(1.9, 1.9);
for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
  const g = new THREE.Group(); g.position.set(KEY_X[c], KEY_Y[r], KEY_RISE);
  g.add(shadowed(new THREE.Mesh(keyGeo, glossMat)));
  const s = screenTexture(576, 576), mat = screenMat(s.tex);
  const face = new THREE.Mesh(keyScreenGeo, mat); face.position.z = .004; g.add(face);
  deck.add(g); keys.push({ group: g, mat, ...s, uri: '' });
}
// Touch strip: a glass bar with four 200 x 100 panels side by side
const STRIP_Y = -1.3, STRIP_W = 11.8, STRIP_H = STRIP_W / 8;
{
  const glass = new THREE.Mesh(slab(12.7, 2.2, .32, .16, .04), glossMat); glass.position.set(0, STRIP_Y, .06); glass.receiveShadow = true; deck.add(glass);
}
const strip = screenTexture(3200, 400);
strip.mat = screenMat(strip.tex); strip.uris = ['', '', '', ''];
{ const m = new THREE.Mesh(new THREE.PlaneGeometry(STRIP_W, STRIP_H), strip.mat); m.position.set(0, STRIP_Y, .066); deck.add(m); }

// Dials: solid knurled knobs standing in the well
const DIAL_X = KEY_X, DIAL_Y = WELL.y, DIAL_R = .76, DIAL_H = 1.2;
const dials = [];
{
  // Machined metal like the real knobs: a diamond-knurled grip (rows of tiny raised dots), a polished
  // chamfer, and a flat top turned on a lathe, whose circular grain throws a bow-tie highlight.
  const AROUND = 46, wallH = DIAL_H - .09, UP = Math.round(AROUND * wallH / (2 * Math.PI * DIAL_R));
  const knurl = document.createElement('canvas'); knurl.width = 2048; knurl.height = 512;
  const k = knurl.getContext('2d'), px = k.createImageData(2048, 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 2048; x++) {
    const a = Math.PI * (x / 2048 * AROUND + y / 512 * UP), b = Math.PI * (x / 2048 * AROUND - y / 512 * UP);
    const edge = smooth(Math.min(y, 511 - y), 0, 26); // smooth bands at the top and bottom of the grip
    const h = 255 * Math.pow(Math.abs(Math.sin(a) * Math.sin(b)), .7) * edge, i = (y * 2048 + x) * 4;
    px.data[i] = px.data[i + 1] = px.data[i + 2] = h; px.data[i + 3] = 255;
  }
  k.putImageData(px, 0, 0);
  const bump = new THREE.CanvasTexture(knurl); bump.wrapS = THREE.RepeatWrapping; bump.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // Lathed surfaces are drawn on both sides, so no angle can look through a knob.
  const metal = { color: 0x8b8e94, metalness: 1, envMapIntensity: 2.6, side: THREE.DoubleSide };
  const wallMat = new THREE.MeshStandardMaterial({ ...metal, roughness: .34, bumpMap: bump, bumpScale: 2.4 });
  const chamferMat = new THREE.MeshStandardMaterial({ ...metal, roughness: .16 });
  const topMat = new THREE.MeshPhysicalMaterial({ ...metal, roughness: .3, anisotropy: 1 });
  const profile = pts => pts.map(p => new THREE.Vector2(p[0], p[1]));
  const wall = new THREE.LatheGeometry(profile([[DIAL_R, 0], [DIAL_R, wallH]]), 160);
  const chamfer = new THREE.LatheGeometry(profile([[DIAL_R, wallH], [DIAL_R - .09, DIAL_H]]), 160);
  const top = new THREE.LatheGeometry(profile([[.001, DIAL_H], [DIAL_R - .09, DIAL_H]]), 160);
  const core = new THREE.CylinderGeometry(DIAL_R - .03, DIAL_R - .03, DIAL_H - .1, 48); core.translate(0, (DIAL_H - .1) / 2, 0);
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: .6 });
  for (const x of DIAL_X) {
    const g = new THREE.Group(); g.position.set(x, DIAL_Y, -PLATE + .08); g.rotation.x = Math.PI / 2; // lathe axis (y) -> face normal (z)
    const spin = new THREE.Group(); g.add(spin);
    spin.add(shadowed(new THREE.Mesh(wall, wallMat)), shadowed(new THREE.Mesh(chamfer, chamferMat)), shadowed(new THREE.Mesh(top, topMat)), shadowed(new THREE.Mesh(core, coreMat)));
    deck.add(g); dials.push(spin);
  }
}
deck.updateMatrixWorld(true);
const L = (x, y, z = 0) => deck.localToWorld(V(x, y, z)); // a point on the deck face, in world space
const DECK_MID = L(0, 0, 0);

// ---------- the Afterclip panel that floats beside the deck ----------
function appWindow(w, h, radius) {
  const tex = new THREE.Texture(); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { map: { value: tex }, gain: { value: 0 }, size: { value: new THREE.Vector2(w, h) }, radius: { value: radius } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform sampler2D map;uniform float gain;uniform float radius;uniform vec2 size;varying vec2 vUv;
      void main(){vec2 p=(vUv-.5)*size;vec2 q=abs(p)-size*.5+vec2(radius);float d=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
      float a=1.-smoothstep(-.05,.05,d);vec3 c=texture2D(map,vUv).rgb*1.25*gain;
      c+=vec3(.5,.55,.65)*smoothstep(-.16,-.02,d)*.22*gain;gl_FragColor=vec4(c,a*smoothstep(0.,.05,gain));}`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); mesh.visible = false; scene.add(mesh);
  return { mesh, mat, tex };
}
const CLIP_H = 18, CLIP_W = CLIP_H * 420 / 700, CLIP_POS = V(14.5, 10.4, -4);
const clipWin = appWindow(CLIP_W, CLIP_H, .7); clipWin.mesh.position.copy(CLIP_POS); clipWin.mesh.rotation.y = -.3;

// ---------- screens, drawn by the plugins' own renderers ----------
let studio, clipArt;
const cover = { small: '', large: '' };
const loadImage = async src => { const img = new Image(); img.src = src; await img.decode(); return img; };
// Runs a CommonJS file from one of the plugins in the page.
async function commonJs(url, requires = () => ({})) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', await fetch(url).then(r => r.text()))(requires, module, module.exports);
  return module.exports;
}
async function loadAssets() {
  const base = '/streamdeck/com.minimalhandle.sleekmeeter.sdPlugin/bin/';
  const symbols = await fetch(base + 'symbols.json').then(r => r.json());
  studio = await commonJs(base + 'studio.js', () => symbols);
  const ring = await commonJs('afterclip/ring.cjs');
  clipArt = await commonJs('afterclip/key-art.cjs', () => ring);
  // The plugin accepts small PNG covers only, so it is given one, and a sharper copy is swapped in afterwards for the close-ups.
  const art = await loadImage(SONG.cover);
  const scaled = (size, type, quality) => { const c = document.createElement('canvas'); c.width = c.height = size; c.getContext('2d').drawImage(art, 0, 0, size, size); return c.toDataURL(type, quality); };
  for (const size of [128, 112, 96, 80, 64]) { cover.small = scaled(size, 'image/png'); if (cover.small.length <= 100000) break; }
  cover.large = scaled(512, 'image/jpeg', .92);
  clipWin.tex.image = await loadImage('afterclip/home.png'); clipWin.tex.needsUpdate = true;
}
const sharpCover = uri => uri.split(encodeURIComponent(cover.small)).join(encodeURIComponent(cover.large));
const images = new Map();
function svgImage(uri) {
  if (!images.has(uri)) { if (images.size > 60) images.clear(); const img = new Image(); img.src = uri; images.set(uri, img.decode().then(() => img)); }
  return images.get(uri);
}
async function updateScreens(t) {
  const { e, media, discord } = mixer(t);
  const key = (action, settings) => studio.renderKey({ action, settings }, e);
  const uris = [
    key('mic', { channel: 'Strip[0]' }), key('route', { channel: 'Strip[0]', bus: 'B2' }), key('sound', { sound: 'Airhorn' }), key('scene', { scene: 'Gaming' }),
    key('mute', { channel: 'Strip[1]' }), key('record', {}), key('duck', {}), key('output', {}),
  ];
  const panels = [
    // Now Playing appears once, on the first dial; the second dial is the mic's level with its live meter.
    sharpCover(studio.renderNowPlaying({ settings: { channel: 'Strip[2]' } }, e, media)), studio.renderDial({ settings: { channel: 'Strip[0]' } }, e),
    studio.renderDial({ settings: { channel: 'Strip[1]' } }, e), studio.renderAppDial({ settings: { exe: 'discord.exe', appName: 'Discord' } }, { status: 'ok', app: { name: 'Discord', volume: discord, mute: false } }),
  ];
  if (t >= T.route && t < T.orbit) {
    const mic = 'Strip[0]', game = 'Strip[1]';
    const pages = {
      route: () => [
        key('route', { channel: mic, bus: 'A1' }), key('route', { channel: mic, bus: 'B1' }), key('route', { channel: mic, bus: 'B2' }),
        key('swap', { channel: mic, bus: 'B2', label: 'Headset', channel2: 'Strip[3]', bus2: 'B2', label2: 'Studio mic' }),
        key('route', { channel: game, bus: 'A1' }), key('route', { channel: game, bus: 'B1' }), key('partmute', { channel: mic }), key('level', { channel: game, mode: 'up', amount: 2 }),
      ],
      stream: () => [
        key('brb', {}), key('record', {}), key('duck', {}), key('micfx', { channel: mic }),
        key('sound', { sound: 'Airhorn' }), key('sound', { sound: 'Applause' }), key('soundstop', {}), key('scene', { scene: 'Streaming' }),
      ],
    };
    const drawn = {};
    uris.forEach((_, i) => { const id = pageAt(i, t); if (pages[id]) uris[i] = (drawn[id] ||= pages[id]())[i]; });
  }
  if (t >= T.clipKeys && t < T.end) {
    const clip = clipKeys(t);
    clip.forEach((uri, i) => { if (onClipPage(i, t)) uris[i] = uri; });
    const saving = t >= PRESS.save.t + .09 && t < PRESS.save.t + .6;
    if (onClipPage(8, t)) panels[0] = clipPanel({ title: 'Mic in clips', value: '100%', icon: { symbol: 'mic', small: '100%' }, fill: .5 });
    if (onClipPage(9, t)) panels[1] = clipPanel({ title: 'Save a clip', value: saving ? 'Saving' : 'Last 30 sec', icon: { big: '30', small: 'SEC', tone: saving ? 'active' : 'normal' }, fill: .62 + (t - T.clipKeys) * .012 });
  }
  await Promise.all([
    ...uris.map(async (uri, i) => { const k = keys[i]; if (k.uri === uri) return; const img = await svgImage(uri); k.ctx.clearRect(0, 0, 576, 576); k.ctx.drawImage(img, 0, 0, 576, 576); k.tex.needsUpdate = true; k.uri = uri; }),
    ...panels.map(async (uri, i) => { if (strip.uris[i] === uri) return; const img = await svgImage(uri); strip.ctx.drawImage(img, i * 800, 0, 800, 400); strip.tex.needsUpdate = true; strip.uris[i] = uri; }),
  ]);
}

// ---------- camera ----------
// Each shot gives position, target, lens and how much is in focus. L(x, y, z) is a point relative to the deck face.
const mixV = (a, b, u) => a.clone().lerp(b, u);
const SHOTS = [
  { t0: 0, cam: u => ({ pos: mixV(V(-18, 12.5, 43), V(-13, 11.5, 35), ease(u * .9)), tgt: V(0, 6.6, 0), fov: 27, ap: .09 }) },
  { t0: T.keys, cam: u => ({ pos: mixV(L(-8.2, .6, 6.2), L(-3, 1.2, 5.7), u), tgt: mixV(L(-4.2, 3.6), L(-1.3, 3.4), u), fov: 30, ap: .1 }) },
  { t0: T.dials, cam: u => ({ pos: mixV(L(4.8, -10.2, 6.6), L(3, -9.8, 7.2), u), tgt: mixV(L(1.9, -3.3), L(1.5, -3.2), u), focus: L(1.475, -3.6, .9), fov: 26, ap: .09 }) },
  { t0: T.playing, cam: u => ({ pos: mixV(L(-7.8, -4.4, 5.6), L(-4.2, -4.1, 5.2), u), tgt: mixV(L(-4.8, -1.0), L(-2.9, -1.0), u), fov: 26, ap: .11 }) },
  { t0: T.route, cam: u => ({ pos: mixV(L(-1.2, -6.5, 16), L(-2.2, -5.6, 15), u), tgt: mixV(L(-2.4, 2.6), L(-2.4, 2.8), u), fov: 30, ap: .09 }) },
  { t0: T.stream, cam: u => ({ pos: mixV(L(-6.5, -7.5, 17.5), L(-5, -6.5, 16.2), u), tgt: mixV(L(-2.6, 1.1), L(-2.6, 1.3), u), fov: 30, ap: .08 }) },
  { t0: T.orbit, cam: u => { const a = lerp(.62, .2, u); /* from the right: seen from the left, the key light flares off the keys' bevelled edges */ return { pos: V(Math.sin(a) * 31, 21, Math.cos(a) * 31), tgt: V(0, 6, 0), fov: 28, ap: .1 }; } },
  { t0: T.clipKeys, cam: u => ({ pos: mixV(L(-1.4, -1.8, 15.5), L(-2.6, -.9, 14), ease(u)), tgt: mixV(L(-2.3, 2.6), L(-2.6, 2.9), ease(u)), fov: 30, ap: .09 }) },
  { t0: T.clipApp, cam: u => ({ pos: mixV(V(-5, 11, 46), V(-3, 11.5, 43), ease(u)), tgt: V(-1, 8.6, 0), focus: mixV(DECK_MID, CLIP_POS, .5), fov: 29, ap: .07 }) },
  { t0: T.end, cam: u => ({ pos: mixV(V(-8.5, 13, 47), V(-7, 12.5, 44), ease(u)), tgt: V(7.4, 7.2, 0), focus: DECK_MID, fov: 27, ap: .08 }) },
];
SHOTS.forEach((s, i) => { s.t1 = i + 1 < SHOTS.length ? SHOTS[i + 1].t0 : DURATION; });
const shotAt = t => SHOTS.find(s => t < s.t1) || SHOTS[SHOTS.length - 1];
const right = V(), up = V();
function placeCamera(t, jx, jy) {
  const s = shotAt(t), c = s.cam(clamp((t - s.t0) / (s.t1 - s.t0)));
  camera.fov = c.fov; camera.updateProjectionMatrix();
  camera.position.copy(c.pos); camera.up.set(0, 1, 0); camera.lookAt(c.tgt); camera.updateMatrix();
  // Thin-lens blur: move the camera across the aperture and pivot about the plane in focus.
  right.setFromMatrixColumn(camera.matrix, 0); up.setFromMatrixColumn(camera.matrix, 1);
  const off = right.multiplyScalar(jx * c.ap).add(up.multiplyScalar(jy * c.ap));
  const fwd = c.tgt.clone().sub(c.pos).normalize(), focus = c.focus || c.tgt;
  const plane = c.pos.clone().add(fwd.multiplyScalar(fwd.dot(focus.clone().sub(c.pos))));
  camera.position.add(off); camera.lookAt(plane);
}

// ---------- per-moment scene state ----------
const during = (t, a, b) => t >= a && t < b;
function applyState(t) {
  const intro = i => t > 6 ? 1 : (() => { const u = (t - 1.5 - i * .13) / .55; return u <= 0 ? 0 : u < .25 ? u * 4 * .55 : u < .4 ? .35 : smooth(u, .4, 1) * .65 + .35; })();
  const clip = during(t, T.clipKeys, T.end);
  keys.forEach((k, i) => {
    const d = pressDepth(i, t);
    k.group.position.z = KEY_RISE - .12 * d;
    // Afterclip's keys are filled with colour, so they need less light than Sleekmeeter's dark ones.
    k.mat.emissiveIntensity = (onClipPage(i, t) ? 1.15 : 2.3) * intro(i) * (1 + .4 * d) * (clip ? flipDim(i, t) : 1);
  });
  strip.mat.emissiveIntensity = 2.3 * intro(8.5);
  dials[2].rotation.y = -(gameGain(t) + 8.5) * .42;
  dials[0].rotation.y = .5; dials[1].rotation.y = -.9; dials[3].rotation.y = 1.3;
  const light = smooth(t, .15, 2.2);
  const purple = clip ? smooth(t, T.clipKeys + .4, T.clipKeys + 1.2) : 0;
  keyLight.intensity = 3.4 * light; sideLight.intensity = 1.6 * light; scene.environmentIntensity = .55 * light;
  rimLight.intensity = (during(t, T.keys, T.dials) ? .6 : during(t, T.route, T.orbit) || during(t, T.clipKeys, T.clipApp) ? .9 : during(t, T.orbit, T.clipKeys) ? .35 : 2.2) * light;
  rimLight.color.copy(RIM_COOL).lerp(RIM_CLIP, purple);
  backdropMat.uniforms.gain.value = light * (1 + .5 * purple);
  backdropMat.uniforms.tint.value.copy(GLOW_NEUTRAL).lerp(GLOW_CLIP, purple);
  const cw = during(t, T.clipApp, T.end);
  clipWin.mesh.visible = cw; clipWin.mat.uniforms.gain.value = cw ? .82 * smooth(t, T.clipApp, T.clipApp + .5) : 0;
}

// ---------- captions, end card and fades (DOM, drawn over the canvas) ----------
const CAPTIONS = [
  { t0: 6.0, t1: 9.7, html: 'Mute, route, record.\n<span class="dim">One press.</span>' },
  { t0: 10.7, t1: 15.2, html: 'Every channel\n<span class="dim">on a dial.</span>' },
  { t0: 16.2, t1: 19.7, html: 'See what’s playing.\n<span class="dim">Turn it up.</span>' },
  { t0: 20.7, t1: 23.55, html: 'Route it\nanywhere.\n<span class="dim">One key each.</span>' },
  { t0: 24.3, t1: 27.25, html: 'Be right back.\n<span class="dim">Mic off.\nGame down.</span>' },
  { t0: 28.1, t1: 31.2, html: 'Your stream,\n<span class="dim">under your fingers.</span>' },
  { t0: 32.5, t1: 35.45, html: 'Same deck.\n<span class="clip">Afterclip.</span>\n<span class="dim">Clip the last 30 s.</span>' },
  { t0: 36.0, t1: 38.25, html: '<span class="clip">Afterclip</span>\n<span class="dim">Save the moment\nafter it happens.</span>' },
];
const CUTS = SHOTS.slice(1).map(s => s.t0);
const el = id => document.getElementById(id);
const scrim = el('scrim'), cap = el('caption'), end = el('end'), also = el('also'), fade = el('fade');
let capShown = null;
function updateDom(t) {
  const c = CAPTIONS.find(c => t >= c.t0 && t < c.t1);
  if (c) {
    if (capShown !== c) { cap.innerHTML = c.html; capShown = c; }
    const a = smooth(t, c.t0, c.t0 + .5) * (1 - smooth(t, c.t1 - .35, c.t1));
    cap.style.opacity = a; cap.style.transform = `translateY(${(1 - smooth(t, c.t0, c.t0 + .7)) * 1.2}vh)`;
    scrim.style.opacity = a;
  } else { cap.style.opacity = 0; scrim.style.opacity = 0; }
  const out = 1 - smooth(t, DURATION - .5, DURATION - .05);
  const e = smooth(t, T.end + 1.3, T.end + 2.4), a = smooth(t, T.end + 2.7, T.end + 3.7);
  end.style.opacity = e * out; end.style.transform = `translateY(calc(-50% + ${(1 - e) * 1.5}vh))`;
  also.style.opacity = a; also.style.transform = `translateY(${(1 - a) * 1}vh)`;
  let f = 1 - smooth(t, 0, 1.1);
  for (const cut of CUTS) f = Math.max(f, 1 - Math.abs(t - cut) / .22);
  f = Math.max(f, smooth(t, DURATION - .55, DURATION - .05));
  fade.style.opacity = clamp(f);
}

// ---------- accumulation: many slightly different renders averaged into one frame ----------
const sceneRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
const accumRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const addMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: sceneRT.texture }, weight: { value: 1 } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
  fragmentShader: 'uniform sampler2D map;uniform float weight;varying vec2 vUv;void main(){gl_FragColor=vec4(texture2D(map,vUv).rgb*weight,weight);}',
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false,
});
const quadScene = new THREE.Scene(); quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), addMat));

const composer = new EffectComposer(renderer);
composer.addPass(new TexturePass(accumRT.texture));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), .42, .7, .92));
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, seed: { value: 0 } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse;uniform float seed;varying vec2 vUv;
    float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+seed)*43758.5453);}
    void main(){vec3 c=texture2D(tDiffuse,vUv).rgb;vec2 p=vUv-.5;c*=1.-smoothstep(.35,.95,length(p*vec2(1.,.8)))*.55;
    c+=(h(gl_FragCoord.xy)+h(gl_FragCoord.xy+17.)-1.)*.014;gl_FragColor=vec4(c,1.);}`,
});
composer.addPass(grade);

async function renderFrame(frame) {
  const t = frame / FPS;
  await updateScreens(t);
  updateDom(t);
  const rot = hash(frame) * Math.PI * 2;
  renderer.setRenderTarget(accumRT); renderer.setClearColor(0x000000, 0); renderer.clear();
  addMat.uniforms.weight.value = 1 / SAMPLES;
  for (let i = 0; i < SAMPLES; i++) {
    const ts = Math.max(0, t + ((i + .5) / SAMPLES - .5) * SHUTTER);
    const r = Math.sqrt((i + .5) / SAMPLES), a = i * 2.39996323 + rot; // even disc over the aperture
    applyState(ts); placeCamera(ts, r * Math.cos(a), r * Math.sin(a));
    const lr = Math.sqrt(halton(i + 1, 2)) * 2.2, la = halton(i + 1, 3) * Math.PI * 2 + rot; // area light -> soft shadows
    keyLight.position.set(KEY_POS.x + lr * Math.cos(la), KEY_POS.y, KEY_POS.z + lr * Math.sin(la));
    renderer.setRenderTarget(sceneRT); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(accumRT); renderer.render(quadScene, quadCam);
  }
  renderer.setRenderTarget(null);
  grade.uniforms.seed.value = frame * .731;
  composer.render();
  renderer.getContext().finish();
}

await Promise.all([loadAssets(), document.fonts.load('600 20px Instrument'), document.fonts.load('500 20px Instrument'), document.fonts.load('700 20px Saira')]);
window.video = { fps: FPS, frames: Math.round(DURATION * FPS), renderFrame };
window.ready = true;
