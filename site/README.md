# sleekmeeter.app

The website: one page (`index.html`, with its CSS and script inside), plus `fonts/`, `media/` (the feature clips and their poster frames) and `img/` (theme pictures, the output mix and the Stream Deck pictures). No build step.

- **Preview:** serve this folder, for example `npx http-server site -p 8100`, and open http://localhost:8100.
- **Theme and output mix pictures:** made from Sleekmeeter's browser preview with `node scripts/site-capture.mjs http://localhost:8000` while `src/` is served on port 8000 (`npm run preview`). It uses headless Microsoft Edge. Run it again after a theme changes or a new one is added, and add the theme to the `THEMES` list in `index.html`.
- **Stream Deck pictures:** copies of `docs/screenshots/streamdeck-*.png`.
- **Deploying:** done by hand: upload everything here except this README to `public_html` on the web host (FTP with explicit TLS), then purge Cloudflare's cache if the old page still shows. `/api/*` on the same domain is the user-count Worker in `server/usage`, which is separate.

Keep the page in step with the README when features change, and keep the note that Sleekmeeter is independent of VB-Audio.
