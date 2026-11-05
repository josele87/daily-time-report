// Zero-dependency HTTP server. Owner routes (edit/sync/settings) are localhost-oriented; /share/<token> is read-only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { defaults, withSettings } = require('./lib/config');
const { createStore } = require('./lib/store');
const { buildReport, getActivity } = require('./lib/report');
const { todayIn } = require('./lib/tz');
const { startStatusPoller, verifySlackSignature, handleSlackEvent } = require('./lib/slack');

const store = createStore(defaults.dataDir);
const live = () => withSettings(defaults, store.data.settings);
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const cache = new Map(); // key -> {t, activity}; cleared by /api/sync
const TTL = 5 * 60 * 1000;

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

async function report(q, readOnly) {
  const cfg = live();
  const today = todayIn(cfg.tz);
  const from = validDate(q.get('from')) ? q.get('from') : today.slice(0, 8) + '01';
  const to = validDate(q.get('to')) ? q.get('to') : today;
  if (from > to) throw Object.assign(new Error('from must be <= to'), { code: 400 });
  const key = `${from}|${to}|${cfg.tz}`;
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.t > TTL) {
    hit = { t: Date.now(), activity: await getActivity(from, to, cfg, store) };
    cache.set(key, hit);
  }
  // files mode: an ongoing day only runs up to the moment the data was extracted, not up to "now"
  const bcfg = cfg.files && hit.activity.dataAsOf ? { ...cfg, now: hit.activity.dataAsOf } : cfg;
  const rows = await buildReport(from, to, { cfg: bcfg, store, showWeekends: q.get('weekends') === '1', activity: hit.activity });
  return {
    from, to, rows,
    dataAsOf: hit.activity.dataAsOf || null,
    cfg: { tz: cfg.tz, mock: cfg.mock, real: !!cfg.files, files: !!cfg.files, jiraBase: cfg.jira.baseUrl, readOnly, qa: cfg.qa, engine: { defaultLunchMin: cfg.engine.defaultLunchMin, minLunchMin: cfg.engine.minLunchMin, pauseMin: cfg.engine.pauseMin } },
    // viewers of a share link get no override metadata beyond the "edited" badge
    ...(readOnly ? {} : { shareToken: store.data.shareToken }),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ---- Slack Events API (optional alternative to polling) ----
    if (p === '/slack/events' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!defaults.slack.signingSecret || !verifySlackSignature(defaults.slack.signingSecret, req, raw)) return json(res, 401, { error: 'bad signature' });
      return json(res, 200, handleSlackEvent(JSON.parse(raw), store));
    }
    // ---- read-only share ----
    const share = p.match(/^\/api\/share\/([a-f0-9]+)\/report$/);
    if (share) {
      if (share[1] !== store.data.shareToken) return json(res, 404, { error: 'not found' });
      return json(res, 200, await report(url.searchParams, true));
    }
    if (/^\/share\/[a-f0-9]+$/.test(p)) {
      if (p.split('/')[2] !== store.data.shareToken) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
    }
    // ---- owner API ----
    if (p === '/api/report') return json(res, 200, await report(url.searchParams, false));
    if (p === '/api/sync' && req.method === 'POST') { cache.clear(); return json(res, 200, { ok: true }); }
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = JSON.parse(await readBody(req));
      const s = {};
      if (b.tz) { new Intl.DateTimeFormat('en', { timeZone: b.tz }); s.tz = b.tz; }
      if (Array.isArray(b.qaFrom) && b.qaFrom.length) s.qaFrom = b.qaFrom;
      if (Array.isArray(b.qaTo) && b.qaTo.length) s.qaTo = b.qaTo;
      for (const k of ['defaultLunchMin', 'minLunchMin', 'pauseMin']) if (Number.isFinite(+b[k])) s[k] = +b[k];
      store.setSettings(s); cache.clear();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/share/rotate' && req.method === 'POST') return json(res, 200, { token: store.rotateShareToken() });
    const ov = p.match(/^\/api\/override\/(\d{4}-\d{2}-\d{2})$/);
    if (ov) {
      if (req.method === 'PUT') {
        const b = JSON.parse(await readBody(req));
        const o = {};
        if (/^\d{2}:\d{2}$/.test(b.start || '')) o.start = b.start;
        if (/^\d{2}:\d{2}$/.test(b.end || '')) o.end = b.end;
        for (const k of ['lunchMinutes', 'comments', 'tested', 'bugs']) if (b[k] !== '' && b[k] != null && Number.isFinite(+b[k])) o[k] = +b[k];
        Object.keys(o).length ? store.setOverride(ov[1], o) : store.deleteOverride(ov[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { store.deleteOverride(ov[1]); return json(res, 200, { ok: true }); }
    }
    // ---- static ----
    const file = p === '/' ? '/index.html' : p;
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(fs.readFileSync(full));
  } catch (e) {
    json(res, e.code === 400 ? 400 : 500, { error: e.message });
  }
});

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  server.listen(defaults.port, host, () => {
    console.log(`Daily Time Report  http://${host}:${defaults.port}   (${defaults.files ? 'FILES: real data from data/*.json' : defaults.mock ? 'MOCK data' : 'live Slack/Jira'})`);
    console.log(`Share link         http://${host}:${defaults.port}/share/${store.data.shareToken}`);
  });
  if (!defaults.mock && !defaults.files && defaults.slack.token && !process.env.SLACK_EVENTS_ONLY) startStatusPoller(store, defaults);
}
module.exports = { server, store };
