#!/usr/bin/env node
// Export a self-contained, read-only HTML snapshot of the report (works offline, no server).
//   node scripts/export-static.js --from 2026-10-01 --to 2026-11-04 --out examples/oct-nov-2026.html [--live]
// Without --live it uses the built-in SAMPLE data generator.
const fs = require('fs');
const path = require('path');
const { defaults, withSettings } = require('../lib/config');
const { createStore } = require('../lib/store');
const { buildReport } = require('../lib/report');
const { todayIn } = require('../lib/tz');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
(async () => {
  const live = process.argv.includes('--live');
  const cfg = withSettings({ ...defaults, mock: !live }, {});
  const today = todayIn(cfg.tz);
  const from = arg('from', today.slice(0, 8) + '01'), to = arg('to', today);
  const out = path.resolve(arg('out', 'examples/report.html'));
  const store = createStore(path.join(require('os').tmpdir(), 'tr-export-' + process.pid));
  const rows = await buildReport(from, to, { cfg, store, showWeekends: false });
  const data = {
    rows, from, to, today: to, generatedAt: Date.now(),
    cfg: { tz: cfg.tz, mock: !live, jiraBase: cfg.jira.baseUrl, readOnly: true, qa: cfg.qa, engine: { defaultLunchMin: cfg.engine.defaultLunchMin, minLunchMin: cfg.engine.minLunchMin, pauseMin: cfg.engine.pauseMin } },
  };
  const pub = path.join(__dirname, '..', 'public');
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  const safe = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css}</style>`)
    .replace('<!--STATIC_DATA-->', () => `<script>window.__STATIC__=${safe}</script>`)
    .replace('<script src="/app.js"></script>', () => `<script>${js}</script>`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`wrote ${out} (${rows.length} days, ${from} → ${to})`);
})();
