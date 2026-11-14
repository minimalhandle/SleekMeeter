// Runs the Worker against an in-memory SQLite database that stands in for D1.
// node --test server/usage/worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { statsPage } from './stats-page.js';
import worker, { valid } from './worker.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql) => {
    const make = (args) => ({
      run: async () => db.prepare(sql).run(...args),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    });
    return { bind: (...args) => make(args), ...make([]) };
  };
  return { db, DB: { prepare } };
}

const ping = (env, body, method = 'POST') =>
  worker.fetch(new Request('https://sleekmeeter.app/api/ping', { method, body: method === 'POST' ? JSON.stringify(body) : undefined }), env);
const id = (n) => n.toString(16).padStart(32, '0');

test('counts each install once a day and keeps only id, version and edition', async () => {
  const env = d1();
  assert.equal((await ping(env, { id: id(1), version: '0.15.0', edition: 'banana' })).status, 204);
  assert.equal((await ping(env, { id: id(1), version: '0.15.0', edition: 'banana' })).status, 204);
  assert.equal((await ping(env, { id: id(2), version: '0.14.0', edition: 'potato' })).status, 204);
  const rows = env.db.prepare('SELECT * FROM pings').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['day', 'edition', 'id', 'version']);
  const stats = await (await worker.fetch(new Request('https://sleekmeeter.app/api/stats'), env)).json();
  assert.equal(stats.today, 2);
  assert.equal(stats.last30Days, 2);
  assert.deepEqual(stats.editions.map((e) => e.edition).sort(), ['banana', 'potato']);
});

test('serves the stats dashboard to browsers and retains the JSON endpoint', async () => {
  const env = d1();
  await ping(env, { id: id(1), version: '0.20.0', edition: 'banana' });
  const request = (accept, query = '') =>
    worker.fetch(new Request('https://sleekmeeter.app/api/stats' + query, { headers: { accept } }), env);

  const browser = await request('text/html,application/xhtml+xml,*/*;q=0.8');
  assert.equal(browser.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(browser.headers.get('cache-control'), 'no-store');
  assert.equal(browser.headers.get('vary'), 'Accept');
  const page = await browser.text();
  assert.match(page, /data-metric="today">1<\/dd>/);
  const data = JSON.parse(page.match(/id="usage-data">([^<]+)<\/script>/)[1]);

  for (const accept of ['*/*', 'application/json', 'text/html;q=0,*/*', 'text/html;q=0.2,application/json']) {
    const response = await request(accept);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('vary'), 'Accept');
    assert.deepEqual(await response.json(), data);
  }
  assert.deepEqual(await (await request('text/html', '?format=json')).json(), data);
});

test('embedded dashboard data cannot close the JSON script element', () => {
  const hostile = '</script><script>alert(1)</script>';
  const page = statsPage({ today: 1, last7Days: 1, last30Days: 1, versions: [{ version: hostile, users: 1 }] });
  assert.equal(page.includes(hostile), false);
  const data = JSON.parse(page.match(/id="usage-data">([^<]+)<\/script>/)[1]);
  assert.equal(data.versions[0].version, hostile);
});

test('rejects anything that is not the expected ping', async () => {
  const env = d1();
  for (const bad of [{}, { id: 'x', version: '0.15.0', edition: 'banana' }, { id: id(1), version: '1', edition: 'banana' }, { id: id(1), version: '0.15.0', edition: 'mine' }]) {
    assert.equal((await ping(env, bad)).status, 400);
  }
  assert.equal((await ping(env, null, 'GET')).status, 405);
  assert.equal((await worker.fetch(new Request('https://sleekmeeter.app/api/other'), env)).status, 404);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM pings').get().n, 0);
  assert.equal(valid({ id: id(3), version: '0.15.0', edition: 'standard', extra: 1 }), true, 'extra fields are ignored, not stored');
});

test('the daily clean-up removes rows older than 400 days', async () => {
  const env = d1();
  env.db.prepare("INSERT INTO pings VALUES (date('now', '-401 days'), ?, '0.1.0', 'banana'), (date('now'), ?, '0.15.0', 'banana')").run(id(1), id(2));
  await worker.scheduled({}, env);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM pings').get().n, 1);
});
