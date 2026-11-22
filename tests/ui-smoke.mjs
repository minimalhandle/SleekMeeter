// Exercise the actual browser UI with the bundled simulator. No external services.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('src'), output = resolve('dist/ui-smoke', String(Date.now()));
mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(root + '\\')) { res.writeHead(403).end(); return; }
  try {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const edge = spawn(process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${output}/profile`, '--mute-audio', '--window-size=1440,1000', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
let socket;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(100);
  }
  assert(target, 'Headless Edge started');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(ok => socket.addEventListener('open', ok, { once: true }));
  let id = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data);
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    if (pending.has(value.id)) { const { ok, fail } = pending.get(value.id); pending.delete(value.id); value.error ? fail(value.error) : ok(value.result); }
  });
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const n = ++id; pending.set(n, { ok, fail }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  const run = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const shot = async name => writeFileSync(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html?edition=3` });
  await sleep(1200);
  await run(`localStorage.setItem('sleekmeeter-preview-settings', JSON.stringify({usagePing:false,setupGuide:'done',theme:'console',themeMotion:'off'})); location.reload()`);
  await sleep(1500);
  await run(`document.querySelectorAll('dialog[open]').forEach(d=>d.close()); document.querySelector('#settingsBtn').click();
    document.querySelector('#settingsSearch').value='Clean-up'; document.querySelector('#settingsSearch').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#micFxFold').open=true;`);
  await sleep(250);
  assert.equal(await run(`document.querySelector('#micFxEngine').value`), 'cpu');
  await run(`document.querySelector('#micFxOn').click(); document.querySelector('#micRiderOn').click();`);
  await sleep(900);
  assert.equal(await run(`document.querySelector('#micRiderOptions').hidden`), false);
  assert.equal(await run(`JSON.parse(localStorage.getItem('sleekmeeter-preview-settings')).micFx.chains[0].rider.on`), true);
  await shot('cpu-and-rider');
  await run(`document.querySelector('#micRiderSection').scrollIntoView({block:'center'})`);
  await shot('rider-controls');
  await run(`document.querySelector('#settingsSearch').value='Talk-over'; document.querySelector('#settingsSearch').dispatchEvent(new Event('input',{bubbles:true}));`);
  await run(`document.querySelector('#duckVoiceAware').click()`);
  await sleep(500);
  assert.equal(await run(`JSON.parse(localStorage.getItem('sleekmeeter-preview-settings')).ducking.voiceAware`), true);
  await shot('voice-ducking');
  await run(`document.querySelector('#settingsDlg').close(); document.querySelector('#scenesBtn').click(); document.querySelector('#scenePartial').click(); document.querySelector('#sceneLevels').click(); document.querySelector('#sceneRoutes').click(); document.querySelector('#sceneName').value='Beta mute only'; document.querySelector('#sceneSave').requestSubmit()`);
  await sleep(500);
  assert.equal(await run(`[...document.querySelectorAll('#sceneList .load')].some(b=>b.textContent==='Beta mute only')`), true);
  await run(`[...document.querySelectorAll('#sceneList .load')].find(b=>b.textContent==='Beta mute only').click()`);
  await sleep(250);
  const preview = await run(`document.querySelector('#sceneChanges').textContent`);
  assert(!preview.includes('also restores the Voicemeeter settings'), 'Partial preview must explain scope correctly');
  assert(!preview.includes('Routing preview is unavailable'), 'Mute-only preview must not request routing data');
  await shot('partial-scene');
  assert.deepEqual(errors, [], 'No uncaught browser exceptions');
  console.log('PASS: CPU selection, rider persistence, voice-aware control, partial save/preview, and no browser exceptions.');
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  socket?.close(); edge.kill(); server.close();
}
