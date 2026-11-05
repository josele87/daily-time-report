// "Files" data source: reads real extracts saved in data/ (git-ignored) instead of calling Slack/Jira APIs.
//   data/slack-real.json  {fetchedAt, messages:[{t:ISO, kind}]}          (timestamps only)
//   data/jira-real.json   {fetchedAt, accountId, transitions, comments, bugs}
//   data/overrides.json   optional manual corrections (days + rules)
// Refreshing the files (e.g. asking Claude to re-extract via its Slack/Jira connectors) is what updates the numbers.
const fs = require('fs');
const path = require('path');
const { parts } = require('./tz');
const { extractTested } = require('./jira');

const DIR = path.join(__dirname, '..', 'data');
const readJson = (f) => (fs.existsSync(path.join(DIR, f)) ? JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) : null);
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function available() { return fs.existsSync(path.join(DIR, 'slack-real.json')) && fs.existsSync(path.join(DIR, 'jira-real.json')); }

function loadActivity(from, to, cfg) {
  const J = readJson('jira-real.json'), S = readJson('slack-real.json');
  if (!J || !S) throw new Error('data/slack-real.json and data/jira-real.json are required for DATA_SOURCE=files');
  const tz = cfg.tz;
  const inRange = (ts) => { const d = parts(ts, tz).date; return d >= from && d <= to; };
  const events = [];
  for (const m of S.messages) { const ts = Date.parse(m.t); if (inRange(ts)) events.push({ ts, source: 'slack', kind: 'message' }); }
  const comments = J.comments.map((c) => ({ key: c.key, ts: Date.parse(c.created), summary: c.summary })).filter((c) => inRange(c.ts));
  const bugs = J.bugs.map((b) => ({ key: b.key, ts: Date.parse(b.created), title: b.summary, priority: b.priority })).filter((b) => inRange(b.ts));
  for (const c of comments) events.push({ ts: c.ts, source: 'jira', kind: 'comment' });
  for (const b of bugs) events.push({ ts: b.ts, source: 'jira', kind: 'bug' });
  for (const t of J.transitions) { const ts = Date.parse(t.created); if (inRange(ts)) events.push({ ts, source: 'jira', kind: 'transition' }); }
  const byKey = {};
  for (const t of J.transitions) (byKey[t.key] ||= { summary: t.summary, h: [] }).h.push({ author: { accountId: J.accountId }, created: t.created, items: [{ field: 'status', fromString: t.fromString, toString: t.toString }] });
  const tested = Object.entries(byKey).flatMap(([key, v]) => extractTested({ key, summary: v.summary }, v.h, J.accountId, cfg)).filter((t) => t.date >= from && t.date <= to);
  const times = [S.fetchedAt, J.fetchedAt].filter(Boolean).map((x) => Date.parse(x)).filter(Number.isFinite);
  return { events, statusEvents: [], comments, tested, bugs, dataAsOf: times.length ? Math.min(...times) : null };
}

// Manual corrections from data/overrides.json → { date: {start,...} } (in memory only, never persisted).
// rows = report rows computed without rules; explicit "days" win over "rules".
function ruleOverrides(rows, cfg, existing = {}) {
  const ov = readJson('overrides.json'); if (!ov) return {};
  const out = { ...(ov.days || {}) };
  for (const rule of ov.rules || []) {
    for (const r of rows) {
      if (r.date >= rule.before || (rule.weekdaysOnly && r.weekend) || r.start == null || out[r.date] || existing[r.date]) continue;
      if (parts(r.start, cfg.tz).minutes > toMin(rule.startIfLaterThan)) out[r.date] = { start: rule.setStart };
    }
  }
  return out;
}

module.exports = { available, loadActivity, ruleOverrides };
