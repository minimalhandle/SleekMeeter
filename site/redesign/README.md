# Sleekmeeter website redesign

The standalone marketing site lives in this directory. It includes a guided mixer, routing and Stream Deck playground, a theme gallery, and a filterable feature catalog. The desktop simulator uses the app’s browser engine directly from `src/`. The website follows your system’s appearance until you choose light or dark with the header toggle.

Run from the repository root with Node.js 20 or newer.

- `node site/redesign/build.mjs` assembles the static site in `site/redesign/dist/` using the app and the existing product screenshots and fonts.
- `node site/redesign/build.mjs --serve` also serves it at `http://127.0.0.1:8100/`.

To release the redesign on the custom domain, upload the **contents** of `dist/` to the site's web root. Deploy the [usage Worker](../../server/usage/README.md) separately to update the Live stats page. See [the current site’s deployment notes](../README.md) for host details.
