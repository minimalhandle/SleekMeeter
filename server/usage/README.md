# Usage counter

A Cloudflare Worker with a D1 database that counts how many copies of Sleekmeeter are in use. It runs at `sleekmeeter.app/api/*`; the rest of the website is untouched.

Copies whose users said yes send this once a day (see `src-tauri/src/usage.rs`):

```json
{ "id": "32 random hex characters", "version": "0.15.0", "edition": "banana" }
```

The Worker keeps one row per ID per UTC day, with just those three values and the date. It doesn't store IP addresses or anything else, and deletes rows older than 400 days.

## Deploy (once)

Run these from this folder, signed in to the Cloudflare account that has sleekmeeter.app. `npx wrangler login` opens your browser to sign in; nothing is saved in the repo.

```bash
npx wrangler login
```

```bash
npx wrangler d1 create sleekmeeter-usage
```

Copy only the `database_id` it prints into `wrangler.toml`. Keep `binding = "DB"` as it is: the Worker looks for that name, and Cloudflare shows error 1101 without it. Then:

```bash
npx wrangler d1 execute sleekmeeter-usage --remote --file schema.sql
```

```bash
npx wrangler deploy
```

Check it with `https://sleekmeeter.app/api/stats`. The free plans cover this easily.

## Reading the numbers

`https://sleekmeeter.app/api/stats` shows totals only: people today, in the last 7 and 30 days, each day for the last 30 days, and the last 30 days by version and by Voicemeeter edition.

## Test

```bash
node --test server/usage/worker.test.mjs
```

It runs the Worker against an in-memory SQLite database (Node 22.5 or newer), so it needs no Cloudflare account.
