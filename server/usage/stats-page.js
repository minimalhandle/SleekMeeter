const formatNumber = new Intl.NumberFormat('en');

const styles = String.raw`
@font-face{font-family:Instrument;src:url('/assets/fonts/InstrumentSans-Regular.woff') format('woff');font-display:swap}
@font-face{font-family:Instrument;src:url('/assets/fonts/InstrumentSans-SemiBold.woff') format('woff');font-weight:600 900;font-display:swap}
@font-face{font-family:JetBrains;src:url('/assets/fonts/JetBrainsMono-Regular.woff2') format('woff2');font-display:swap}
:root{
  color-scheme:light dark;
  --paper:light-dark(#f5f3ed,#181916);
  --ink:light-dark(#20211e,#f5f3ed);
  --muted:light-dark(#56574f,#b9b9ab);
  --line:light-dark(#d8d6ca,#404138);
  --accent:light-dark(#ac3823,#ff937a);
  --signal:light-dark(#2f6a46,#8ac29c);
  --surface:light-dark(#fbfaf5,#22231e);
  --wash:light-dark(#f2e4d8,#352820);
  --hover:light-dark(#eae6da,#303127);
  --mono:JetBrains,Consolas,monospace;
}
:root[data-theme="light"]{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.55 Instrument,Arial,sans-serif}
h1,h2,p,figure,dl,dd{margin:0}
a{color:inherit}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.shell{width:min(100% - 88px,1060px);margin-inline:auto}
.header{border-bottom:1px solid var(--line)}
.header .shell{min-height:74px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:inline-flex;align-items:center;gap:10px;font-size:1.3rem;font-weight:650;letter-spacing:-.045em;text-decoration:none}
.brand img{width:34px;height:34px}
.tools{display:flex;align-items:center;gap:8px}
.control{min-height:38px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:7px;background:transparent;font-size:.82rem;font-weight:650;text-decoration:none}
.control:hover{background:var(--hover)}
.control:disabled{cursor:wait;opacity:.65}
main{padding-top:clamp(40px,7vw,80px);padding-bottom:clamp(42px,6vw,72px)}
.kicker,.metric dt,.live,.dates,.chart-scale{font:400 .67rem/1.45 var(--mono);letter-spacing:.06em;text-transform:uppercase}
.kicker{color:var(--accent);margin-bottom:10px}
.intro{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:26px}
.intro h1{font-size:clamp(2.7rem,7vw,5.4rem);font-weight:650;letter-spacing:-.075em;line-height:.95}
.intro p{max-width:39ch;color:var(--muted)}
.metrics{display:grid;grid-template-columns:1.65fr repeat(2,1fr);gap:12px}
.panel{border:1px solid var(--line);border-radius:17px;background:var(--surface)}
.metric{padding:clamp(15px,3vw,29px);display:grid;align-content:center;min-height:137px}
.metric-today{background:var(--wash)}
.metric dt{color:var(--muted)}
.metric-today dt{color:var(--accent)}
.metric dd{font-size:clamp(2.4rem,6vw,4.6rem);font-weight:650;line-height:1.05;letter-spacing:-.08em;font-variant-numeric:tabular-nums}
.metric-today dd{font-size:clamp(3.2rem,8.4vw,6.6rem)}
.update-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0 28px}
.live{display:flex;align-items:center;gap:9px;color:var(--muted)}
.live-dot{height:7px;width:7px;border-radius:50%;background:var(--signal);flex:none}
.live[data-state="error"] .live-dot{background:var(--accent)}
.chart,.breakdown{padding:clamp(17px,3vw,28px)}
.panel-heading{display:flex;align-items:start;justify-content:space-between;gap:12px}
.panel-heading h2,.breakdown h2{font-size:1.25rem;font-weight:650;letter-spacing:-.03em;line-height:1.25}
.panel-heading p{color:var(--muted);font-size:.87rem;margin-top:3px}
.chart-scale{color:var(--muted);text-align:right;white-space:nowrap}
.bars{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);align-items:end;gap:clamp(2px,.6vw,7px);height:130px;margin-top:18px;border-bottom:1px solid var(--line);background:repeating-linear-gradient(to top,transparent 0 calc(25% - 1px),var(--line) calc(25% - 1px) 25%)}
.bar{height:var(--bar-height);min-height:2px;border-radius:4px 4px 0 0;background:var(--accent);opacity:.68}
.bar:hover,.bar:last-child{opacity:1}
.dates{display:flex;justify-content:space-between;gap:8px;color:var(--muted);margin-top:7px}
.daily-details{margin-top:13px}
.daily-details summary{cursor:pointer;font-size:.87rem;font-weight:650}
table{border-collapse:collapse;width:100%;font-size:.87rem;margin-top:6px}
th,td{padding:6px 0;border-bottom:1px solid var(--line);text-align:left;font-weight:400}
thead th{font-weight:650}
td:last-child,thead th:last-child{text-align:right}
.breakdowns{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.breakdown ul{list-style:none;margin:9px 0 0;padding:0}
.breakdown li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:7px 0;font-size:.93rem}
.breakdown li:last-child{border-bottom:0}
.breakdown strong{font-variant-numeric:tabular-nums}
.note{margin-top:15px;font-size:.86rem;color:var(--muted)}
.footer{border-top:1px solid var(--line);color:var(--muted);font-size:.86rem}
.footer .shell{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:18px 0}
.footer a{font-weight:650;white-space:nowrap;text-underline-offset:3px}
@media(max-width:660px){
  .shell{width:calc(100% - 32px)}
  .intro{display:block}
  .intro p{margin-top:11px}
  .metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .metric{min-height:91px}
  .metric-today{grid-column:1/-1;min-height:112px}
  .breakdowns{grid-template-columns:1fr}
  .bars{height:100px}
}
@media(max-width:375px){
  .brand{font-size:1.12rem;gap:6px}
  .brand img{width:29px;height:29px}
  .tools{gap:4px}
  .control{padding-inline:7px}
}
`;

const clientScript = String.raw`
const themeKey = 'sleekmeeter-site-theme';
const root = document.documentElement;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const themeButton = document.querySelector('#theme-toggle');

function syncTheme() {
  const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && systemDark.matches);
  themeButton.setAttribute('aria-pressed', String(dark));
  return dark;
}

themeButton.hidden = false;
syncTheme();
themeButton.addEventListener('click', () => {
  const next = syncTheme() ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem(themeKey, next); } catch {}
  syncTheme();
});
systemDark.addEventListener('change', syncTheme);
window.addEventListener('storage', (event) => {
  if (event.key !== themeKey && event.key !== null) return;
  if (event.newValue === 'dark' || event.newValue === 'light') root.dataset.theme = event.newValue;
  else delete root.dataset.theme;
  syncTheme();
});

const number = new Intl.NumberFormat('en');
const shortDate = new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric', timeZone: 'UTC'});
const longDate = new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeZone: 'UTC'});
const editionNames = new Map([['standard', 'Standard'], ['banana', 'Banana'], ['potato', 'Potato'], ['unknown', 'Unknown']]);
const dataDetails = document.querySelector('#data-details');
const status = document.querySelector('#live-status');
const refreshButton = document.querySelector('#refresh');
let inFlight = false;

function dailyRows(daily) {
  const values = new Map(daily.map(({day, users}) => [day, users]));
  const now = new Date();
  return Array.from({length: 30}, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29 + index));
    return {date, count: values.get(date.toISOString().slice(0, 10)) || 0};
  });
}

function drawChart(daily) {
  const rows = dailyRows(daily);
  const peak = Math.max(...rows.map(({count}) => count));
  document.querySelector('#chart-scale').textContent = 'Peak ' + number.format(peak);
  document.querySelector('#chart-start').textContent = shortDate.format(rows[0].date);
  document.querySelector('#chart-end').textContent = shortDate.format(rows[rows.length - 1].date);
  const bars = [];
  const tableRows = [];
  for (const {date, count} of rows) {
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.setProperty('--bar-height', (100 * count / Math.max(peak, 1)) + '%');
    bar.title = longDate.format(date) + ' · ' + number.format(count);
    bars.push(bar);

    const row = document.createElement('tr');
    const day = document.createElement('th');
    day.scope = 'row';
    day.textContent = longDate.format(date);
    const total = document.createElement('td');
    total.textContent = number.format(count);
    row.append(day, total);
    tableRows.push(row);
  }
  document.querySelector('#daily-bars').replaceChildren(...bars);
  document.querySelector('#daily-rows').replaceChildren(...tableRows);
}

function drawBreakdown(id, rows, label) {
  const list = document.querySelector(id);
  list.replaceChildren();
  for (const row of rows) {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = label(row);
    const count = document.createElement('strong');
    count.textContent = number.format(row.users);
    item.append(title, count);
    list.append(item);
  }
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No reports in this period.';
    list.append(empty);
  }
}

function paint(data) {
  for (const metric of document.querySelectorAll('[data-metric]')) {
    metric.textContent = number.format(data[metric.dataset.metric]);
  }
  drawChart(data.daily);
  drawBreakdown('#editions', data.editions, ({edition}) => editionNames.get(edition) || edition);
  drawBreakdown('#versions', data.versions, ({version}) => version);
  dataDetails.hidden = false;
}

function checked() {
  const time = new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  status.dataset.state = 'live';
  status.querySelector('span:last-child').textContent = 'Last checked ' + time + ' · Refreshes every minute';
}

async function refresh(cache = 'default') {
  if (inFlight) return;
  inFlight = true;
  refreshButton.disabled = true;
  try {
    const url = new URL(location.href);
    url.searchParams.set('format', 'json');
    const response = await fetch(url, {headers: {Accept: 'application/json'}, cache, signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Usage request failed');
    paint(await response.json());
    checked();
  } catch {
    status.dataset.state = 'error';
    status.querySelector('span:last-child').textContent = 'Could not refresh. Trying again in a minute.';
  } finally {
    refreshButton.disabled = false;
    inFlight = false;
  }
}

const initial = JSON.parse(document.querySelector('#usage-data').textContent);
if (initial) {
  paint(initial);
  checked();
}
refreshButton.hidden = false;
refreshButton.addEventListener('click', () => refresh('reload'));
setInterval(() => {
  if (!document.hidden) refresh();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
`;

export function statsPage(data) {
  const total = (key) => data ? formatNumber.format(data[key]) : '—';
  const embedded = JSON.stringify(data ?? null).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sleekmeeter usage stats</title>
  <meta name="description" content="Live anonymous usage totals for Sleekmeeter.">
  <link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
  <script>
    try {
      const theme = localStorage.getItem('sleekmeeter-site-theme');
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    } catch {}
  </script>
  <style>${styles}</style>
</head>
<body>
  <header class="header">
    <div class="shell">
      <a class="brand" href="/"><img src="/assets/mark.svg" alt="">Sleekmeeter</a>
      <div class="tools">
        <button class="control" id="theme-toggle" type="button" aria-pressed="false" hidden><span aria-hidden="true">◐</span> Dark mode</button>
        <a class="control" href="/">Home <span aria-hidden="true">↗</span></a>
      </div>
    </div>
  </header>
  <main class="shell">
    <p class="kicker">Sleekmeeter / Usage</p>
    <div class="intro">
      <h1>Usage stats.</h1>
      <p>Counts from installations that choose to share anonymous usage data. Each installation reports at most once per UTC day.</p>
    </div>
    <dl class="metrics" aria-label="Opted-in installations">
      <div class="metric metric-today panel"><dt>Reported today (UTC)</dt><dd data-metric="today">${total('today')}</dd></div>
      <div class="metric panel"><dt>Last 7 days</dt><dd data-metric="last7Days">${total('last7Days')}</dd></div>
      <div class="metric panel"><dt>Last 30 days</dt><dd data-metric="last30Days">${total('last30Days')}</dd></div>
    </dl>
    <div class="update-row">
      <p class="live" id="live-status" role="status" data-state="${data ? 'live' : 'error'}"><span class="live-dot" aria-hidden="true"></span><span>${data ? 'Counts are up to a minute old' : 'Usage counts are temporarily unavailable'}</span></p>
      <button class="control" id="refresh" type="button" hidden>Refresh <span aria-hidden="true">↻</span></button>
    </div>
    <div id="data-details" hidden>
      <section class="chart panel" aria-labelledby="daily-title">
        <div class="panel-heading">
          <div><h2 id="daily-title">Daily reports</h2><p>Opted-in installations across the last 30 UTC days</p></div>
          <span class="chart-scale" id="chart-scale"></span>
        </div>
        <div class="bars" id="daily-bars" aria-hidden="true"></div>
        <div class="dates" aria-hidden="true"><span id="chart-start"></span><span id="chart-end"></span></div>
        <details class="daily-details">
          <summary>View daily counts</summary>
          <table>
            <thead><tr><th scope="col">Date (UTC)</th><th scope="col">Installations</th></tr></thead>
            <tbody id="daily-rows"></tbody>
          </table>
        </details>
      </section>
      <div class="breakdowns">
        <section class="breakdown panel" aria-labelledby="edition-title"><h2 id="edition-title">Voicemeeter editions</h2><ul id="editions"></ul></section>
        <section class="breakdown panel" aria-labelledby="version-title"><h2 id="version-title">Sleekmeeter versions</h2><ul id="versions"></ul></section>
      </div>
      <p class="note">The edition and version lists cover the last 30 days. An installation that switched editions or versions may appear in multiple rows.</p>
    </div>
  </main>
  <footer class="footer"><div class="shell"><p>Sleekmeeter · Free and open source</p><a href="?format=json">View JSON data</a></div></footer>
  <script type="application/json" id="usage-data">${embedded}</script>
  <script>${clientScript}</script>
</body>
</html>`;
}
