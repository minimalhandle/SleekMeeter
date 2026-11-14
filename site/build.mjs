import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themes } from './content.js';

const source = path.dirname(fileURLToPath(import.meta.url));
const currentSite = source;
const repository = path.dirname(source);
const output = path.join(source, 'dist');

async function copy(from, to) {
  const destination = path.join(output, to);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(from, destination);
}

await Promise.all([
  ...['index.html', 'styles.css', 'theme.js', 'site.js', 'content.js', 'preview.js', 'preview.css', 'assets/mark.svg']
    .map(file => copy(path.join(source, file), file)),
  ...['InstrumentSans-Regular.woff', 'InstrumentSans-Medium.woff', 'InstrumentSans-SemiBold.woff', 'JetBrainsMono-Regular.woff2']
    .map(file => copy(path.join(currentSite, 'fonts', file), `assets/fonts/${file}`)),
  ...themes.map(([id]) => copy(path.join(currentSite, 'img', 'themes', `${id}.webp`), `assets/themes/${id}.webp`)),
  copy(path.join(currentSite, 'img', 'mix.webp'), 'assets/mix.webp'),
  copy(path.join(currentSite, 'media', 'apps.webp'), 'assets/apps.webp'),
  copy(path.join(currentSite, 'media', 'showcase-web.mp4'), 'assets/showcase.mp4'),
  copy(path.join(currentSite, 'media', 'showcase.webp'), 'assets/showcase.webp'),
  copy(path.join(repository, 'LICENSE'), 'LICENSE'),
  cp(path.join(repository, 'src'), path.join(output, 'demo'), { recursive: true }),
]);

console.log(`Built ${output}`);
if (process.argv.includes('--serve')) {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };

  createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://127.0.0.1');
      const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
      const file = path.resolve(output, relative, pathname.endsWith('/') ? 'index.html' : '');
      const inside = path.relative(output, file);
      if (inside.startsWith('..') || path.isAbsolute(inside) || !(await stat(file)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  }).listen(8100, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:8100/'));
}
