// Sleekmeeter usage counter: a Cloudflare Worker with a D1 database, at sleekmeeter.app/api/*.
// Copies that opted in send { id, version, edition } once a day. It keeps one row per ID per
// day and nothing else: no IP addresses, no names, no other details.

import { statsPage } from './stats-page.js';

const EDITIONS = ['standard', 'banana', 'potato', 'unknown'];
// Rows older than this are deleted every day.
const KEEP_DAYS = 400;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

export function valid(p) {
  return !!p && typeof p === 'object'
    && typeof p.id === 'string' && /^[0-9a-f]{32}$/i.test(p.id)
    && typeof p.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p.version)
    && EDITIONS.includes(p.edition);
}

const today = () => new Date().toISOString().slice(0, 10);

async function ping(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (Number(request.headers.get('content-length') || 0) > 512) return json({ error: 'Too large' }, 413);
  let p;
  try { p = await request.json(); } catch { return json({ error: 'Not JSON' }, 400); }
  if (!valid(p)) return json({ error: 'Unexpected fields' }, 400);
  await env.DB.prepare('INSERT OR IGNORE INTO pings (day, id, version, edition) VALUES (?1, ?2, ?3, ?4)')
    .bind(today(), p.id.toLowerCase(), p.version, p.edition).run();
  return new Response(null, { status: 204 });
}

// Totals only, so anyone may read them.
async function readStats(env) {
  const one = async (sql) => (await env.DB.prepare(sql).first()) || {};
  const all = async (sql) => (await env.DB.prepare(sql).all()).results || [];
  return {
    today: (await one("SELECT COUNT(*) AS n FROM pings WHERE day = date('now')")).n || 0,
    last7Days: (await one("SELECT COUNT(DISTINCT id) AS n FROM pings WHERE day > date('now', '-7 days')")).n || 0,
    last30Days: (await one("SELECT COUNT(DISTINCT id) AS n FROM pings WHERE day > date('now', '-30 days')")).n || 0,
    daily: await all("SELECT day, COUNT(*) AS users FROM pings WHERE day > date('now', '-30 days') GROUP BY day ORDER BY day"),
    versions: await all("SELECT version, COUNT(DISTINCT id) AS users FROM pings WHERE day > date('now', '-30 days') GROUP BY version ORDER BY users DESC"),
    editions: await all("SELECT edition, COUNT(DISTINCT id) AS users FROM pings WHERE day > date('now', '-30 days') GROUP BY edition ORDER BY users DESC"),
  };
}

function wantsStatsPage(request, url) {
  if (url.searchParams.get('format') === 'json') return false;
  const qualities = new Map();
  for (const entry of (request.headers.get('accept') || '').split(',')) {
    const [type, ...parameters] = entry.toLowerCase().split(';').map((part) => part.trim());
    const quality = parameters.find((part) => part.startsWith('q='));
    const value = quality === undefined ? 1 : Number(quality.slice(2));
    if (value >= 0 && value <= 1) qualities.set(type, Math.max(qualities.get(type) || 0, value));
  }
  return (qualities.get('text/html') || 0) > (qualities.get('application/json') || 0);
}

async function stats(request, url, env) {
  const asPage = wantsStatsPage(request, url);
  const headers = { vary: 'Accept' };
  if (!asPage) {
    // Shared caches can ignore Vary, so let each client cache the JSON separately.
    return json(await readStats(env), 200, { ...headers, 'cache-control': 'private, max-age=60' });
  }

  let totals;
  try {
    totals = await readStats(env);
  } catch (error) {
    console.error('Could not read Sleekmeeter usage totals', error);
  }
  return new Response(statsPage(totals), {
    status: totals ? 200 : 503,
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ping') return ping(request, env);
    if (url.pathname === '/api/stats' && request.method === 'GET') return stats(request, url, env);
    return json({ error: 'Not found' }, 404);
  },
  async scheduled(_event, env) {
    await env.DB.prepare(`DELETE FROM pings WHERE day < date('now', '-${KEEP_DAYS} days')`).run();
  },
};
