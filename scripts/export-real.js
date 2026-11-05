#!/usr/bin/env node
// Builds a read-only HTML snapshot from REAL extracts saved in data/ (git-ignored):
//   data/jira-real.json  (transitions, comments, bugs)   data/slack-real.json (message timestamps only)
//   node scripts/export-real.js [--tz America/Bogota] [--from 2026-10-01] [--to 2026-11-04]
// The output contains ticket titles, so it is written to data/ and must not be committed.
const fs = require('fs');
const path = require('path');
const { defaults, withSettings } = require('../lib/config');
const { createStore } = require('../lib/store');
const { buildReport } = require('../lib/report');
const { extractTested } = require('../lib/jira');
const { parts } = require('../lib/tz');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const dir = path.join(__dirname, '..', 'data');
const J = JSON.parse(fs.readFileSync(path.join(dir, 'jira-real.json'), 'utf8'));
const S = JSON.parse(fs.readFileSync(path.join(dir, 'slack-real.json'), 'utf8'));
const ME = J.accountId;
const tz = arg('tz', 'America/Bogota'), from = arg('from', '2026-10-01'), to = arg('to', '2026-11-04');
const cfg = withSettings({ ...defaults, mock: false, tz, jira: { ...defaults.jira, baseUrl: 'https://vailresorts.jira.com' } }, {});
const inRange = (ts) => { const d = parts(ts, tz).date; return d >= from && d <= to; };

const events = [];
for (const m of S.messages) { const ts = Date.parse(m.t); if (inRange(ts)) events.push({ ts, source: 'slack', kind: 'message' }); }
const comments = J.comments.map((c) => ({ key: c.key, ts: Date.parse(c.created), summary: c.summary })).filter((c) => inRange(c.ts));
const bugs = J.bugs.map((b) => ({ key: b.key, ts: Date.parse(b.created), title: b.summary, priority: b.priority })).filter((b) => inRange(b.ts));
for (const c of comments) events.push({ ts: c.ts, source: 'jira', kind: 'comment' });
for (const b of bugs) events.push({ ts: b.ts, source: 'jira', kind: 'bug' });
for (const t of J.transitions) { const ts = Date.parse(t.created); if (inRange(ts)) events.push({ ts, source: 'jira', kind: 'transition' }); }

// tickets tested: strict rule via the same pure function the live app uses
const byKey = {};
for (const t of J.transitions) (byKey[t.key] ||= { summary: t.summary, h: [] }).h.push({ author: { accountId: ME }, created: t.created, items: [{ field: 'status', fromString: t.fromString, toString: t.toString }] });
const tested = Object.entries(byKey).flatMap(([key, v]) => extractTested({ key, summary: v.summary }, v.h, ME, cfg)).filter((t) => t.date >= from && t.date <= to);

(async () => {
  const store = createStore(path.join(require('os').tmpdir(), 'tr-real-' + process.pid));
  const activity = { events, statusEvents: [], comments, tested, bugs };
  let rows = await buildReport(from, to, { cfg, store, showWeekends: true, activity });
  // Manual corrections live in data/overrides.json (git-ignored):
  //   { "days": { "2026-10-06": { "start": "08:45" } },
  //     "rules": [{ "before": "2026-10-26", "weekdaysOnly": true, "startIfLaterThan": "09:00", "setStart": "08:45" }] }
  // They are applied as per-day overrides, so affected rows are badged "edited" / "manual" and never pass as measured.
  const ovFile = path.join(dir, 'overrides.json');
  if (fs.existsSync(ovFile)) {
    const ov = JSON.parse(fs.readFileSync(ovFile, 'utf8'));
    for (const [d, o] of Object.entries(ov.days || {})) store.setOverride(d, o);
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    for (const rule of ov.rules || []) {
      for (const r of rows) {
        if (r.date >= rule.before || (rule.weekdaysOnly && r.weekend) || r.start == null || store.data.overrides[r.date]) continue;
        if (parts(r.start, tz).minutes > toMin(rule.startIfLaterThan)) store.setOverride(r.date, { start: rule.setStart });
      }
    }
    rows = await buildReport(from, to, { cfg, store, showWeekends: true, activity });
    const edited = rows.filter((r) => r.edited);
    console.log(`overrides applied to ${edited.length} day(s): ${edited.map((r) => r.date.slice(5)).join(', ')}`);
  }
  const data = {
    rows, from, to, today: to, generatedAt: Date.now(),
    cfg: { tz, mock: false, real: true, jiraBase: cfg.jira.baseUrl, readOnly: true, qa: cfg.qa, engine: { defaultLunchMin: cfg.engine.defaultLunchMin, minLunchMin: cfg.engine.minLunchMin, pauseMin: cfg.engine.pauseMin } },
  };
  const pub = path.join(__dirname, '..', 'public');
  const safe = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${fs.readFileSync(path.join(pub, 'style.css'), 'utf8')}</style>`)
    .replace('<!--STATIC_DATA-->', () => `<script>window.__STATIC__=${safe}</script>`)
    .replace('<script src="/app.js"></script>', () => `<script>${fs.readFileSync(path.join(pub, 'app.js'), 'utf8')}</script>`);
  const out = path.join(dir, 'real-report.html');
  fs.writeFileSync(out, html);
  const w = rows.filter((r) => r.start != null && !r.weekend);
  console.log(`wrote ${out}`);
  console.log(`days with activity (weekdays): ${w.length}, weekend rows: ${rows.filter((r) => r.weekend).length}`);
  console.log(`slack msgs in range: ${events.filter((e) => e.source === 'slack').length}, jira comments: ${comments.length}, bugs: ${bugs.length}, transitions(all): ${J.transitions.length}, tested: ${tested.length}`);
  const f = (t) => { if (t == null) return '--'; const p = parts(t, tz); return String(p.h).padStart(2, '0') + ':' + String(p.m).padStart(2, '0'); };
  for (const r of rows) {
    const l = r.pauses.find((p) => p.type === 'lunch');
    console.log(r.date, r.weekend ? 'WE' : '  ', f(r.start), f(r.end), l ? (l.start ? `${f(l.start)}-${f(l.end)}` : l.minutes + 'm*') : '-', (r.netMinutes / 60).toFixed(1) + 'h', 'c' + r.commentsCount, 't' + r.testedCount, 'b' + r.bugsCount, r.source, r.flags.join(','));
  }
})();
