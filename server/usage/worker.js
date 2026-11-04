// Sleekmeeter usage counter: a Cloudflare Worker with a D1 database, at sleekmeeter.app/api/*.
// Copies that opted in send { id, version, edition } once a day. It keeps one row per ID per
// day and nothing else: no IP addresses, no names, no other details.

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
async function stats(env) {
  const one = async (sql) => (await env.DB.prepare(sql).first()) || {};
  const all = async (sql) => (await env.DB.prepare(sql).all()).results || [];
  const body = {
    today: (await one("SELECT COUNT(*) AS n FROM pings WHERE day = date('now')")).n || 0,
    last7Days: (await one("SELECT COUNT(DISTINCT id) AS n FROM pings WHERE day > date('now', '-7 days')")).n || 0,
    last30Days: (await one("SELECT COUNT(DISTINCT id) AS n FROM pings WHERE day > date('now', '-30 days')")).n || 0,
    daily: await all("SELECT day, COUNT(*) AS users FROM pings WHERE day > date('now', '-30 days') GROUP BY day ORDER BY day"),
    versions: await all("SELECT version, COUNT(DISTINCT id) AS users FROM pings WHERE day > date('now', '-30 days') GROUP BY version ORDER BY users DESC"),
    editions: await all("SELECT edition, COUNT(DISTINCT id) AS users FROM pings WHERE day > date('now', '-30 days') GROUP BY edition ORDER BY users DESC"),
  };
  return json(body, 200, { 'cache-control': 'public, max-age=300' });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/ping') return ping(request, env);
    if (pathname === '/api/stats' && request.method === 'GET') return stats(env);
    return json({ error: 'Not found' }, 404);
  },
  async scheduled(_event, env) {
    await env.DB.prepare(`DELETE FROM pings WHERE day < date('now', '-${KEEP_DAYS} days')`).run();
  },
};
