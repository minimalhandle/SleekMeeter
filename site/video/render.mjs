// Renders the showcase video frame by frame in headless Edge/Chrome and encodes it with ffmpeg.
//   node site/video/render.mjs                      full render -> site/media/showcase.mp4, and showcase-web.mp4 for the site
//   node site/video/render.mjs --still 2,7.5,12     PNG stills of those seconds -> site/video/.cache/stills
//   options: --scale 0.5 (half size preview)  --samples 8 (faster, noisier)  --from 5 --to 10 (seconds)
// Needs ffmpeg (on PATH or FFMPEG=path) and Edge or Chrome (or BROWSER=path).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const scale = Number(arg('scale', 1)), W = Math.round(1920 * scale / 2) * 2, H = Math.round(1080 * scale / 2) * 2;
const firstExisting = list => list.find(p => p && fs.existsSync(p));
const ffmpeg = process.env.FFMPEG || (spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : firstExisting(['C:/Program Files/Streamlink/ffmpeg/ffmpeg.exe']));
const browserPath = process.env.BROWSER || firstExisting(['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']);
if (!ffmpeg) throw new Error('ffmpeg not found: put it on PATH or set FFMPEG');
if (!browserPath) throw new Error('Edge or Chrome not found: set BROWSER');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/site/video/index.html?samples=${arg('samples', 24)}`;

const browser = await puppeteer.launch({
  executablePath: browserPath, headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--force-color-profile=srgb', '--force-device-scale-factor=1', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', e => console.log('[page error]', e.message));
  await page.goto(url);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  const { fps, frames } = await page.evaluate(() => ({ fps: window.video.fps, frames: window.video.frames }));
  const shot = async frame => { await page.evaluate(f => window.video.renderFrame(f), frame); return page.screenshot({ type: 'png', optimizeForSpeed: true }); };

  const stills = arg('still');
  if (stills) {
    const dir = path.join(here, '.cache/stills'); fs.mkdirSync(dir, { recursive: true });
    for (const s of stills.split(',')) { const file = path.join(dir, `t${Number(s).toFixed(2).padStart(5, '0')}.png`); fs.writeFileSync(file, await shot(Math.round(Number(s) * fps))); console.log(file); }
  } else {
    const from = Math.round(Number(arg('from', 0)) * fps), to = Math.min(frames, Math.round(Number(arg('to', frames / fps)) * fps));
    const out = arg('out', path.join(root, 'site/media/showcase.mp4'));
    const enc = spawn(ffmpeg, ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', arg('crf', '19'), '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const closed = new Promise((done, fail) => enc.on('close', code => code ? fail(new Error('ffmpeg exited with ' + code)) : done()));
    const started = Date.now();
    for (let f = from; f < to; f++) {
      const png = await shot(f);
      if (!enc.stdin.write(png)) await new Promise(done => enc.stdin.once('drain', done));
      if ((f - from) % 30 === 29) console.log(`${f + 1 - from}/${to - from} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    enc.stdin.end(); await closed;
    console.log(out);
    // A full render also gets a lighter copy for the web page (about a quarter of the size), next to the master.
    if (from === 0 && to === frames && scale === 1 && path.extname(out) === '.mp4') {
      const web = out.replace(/\.mp4$/, '-web.mp4');
      const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', out, '-c:v', 'libx264', '-preset', 'slow', '-crf', arg('web-crf', '28'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', web], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('could not make the web copy');
      console.log(web);
    }
  }
} finally {
  await browser.close(); server.close();
}
