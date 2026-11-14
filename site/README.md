# sleekmeeter.app

The website. It includes a guided mixer, routing and Stream Deck playground, a theme gallery, and a filterable feature catalog. The desktop simulator uses the app's browser engine directly from `src/`. The site follows your system's appearance until you choose light or dark with the header toggle.

Run from the repository root with Node.js 20 or newer.

- `node site/build.mjs` assembles the static site in `site/dist/` from the pages here, `fonts/`, `img/`, `media/`, the app in `src/` and `LICENSE`.
- `node site/build.mjs --serve` also serves it at http://127.0.0.1:8100/.

## Pictures and video

- **Theme and output mix pictures** (`img/themes/<id>.webp`, `img/mix.webp`): made from Sleekmeeter's browser preview with `node scripts/site-capture.mjs http://localhost:8000` while `src/` is served on port 8000 (`npm run preview`). It uses headless Microsoft Edge. Run it again after a theme changes or a new one is added, and add the theme to `themes` in `content.js` and `THEMES` in the capture script.
- **Showcase video** (`media/showcase*.mp4`, `media/showcase.webp`): rendered by `node site/video/render.mjs`. See the notes at the top of that file.

## Deploying

Done by hand: build, then upload the **contents** of `dist/` to `public_html` on the web host (FTP with explicit TLS), and purge Cloudflare's cache if the old page still shows. `/api/*` on the same domain is the user-count [usage Worker](../server/usage/README.md), deployed separately; it also serves the Live stats page.

Keep the site in step with the README when features change, and keep the note that Sleekmeeter is independent of VB-Audio.
