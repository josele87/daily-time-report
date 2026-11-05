const { parts, dayRange, isWeekend, addDays, weekday } = require('./tz');
const { computeDay, applyOverride } = require('./engine');
const mock = require('./mock');

async function getActivity(from, to, cfg, store) {
  if (cfg.mock) return mock.generate(from, to, cfg);
  const { fetchJira } = require('./jira');
  const { fetchSlackMessages } = require('./slack');
  const inRange = (ts) => { const d = parts(ts, cfg.tz).date; return d >= from && d <= to; };
  const [slack, jira] = await Promise.all([
    cfg.slack.token ? fetchSlackMessages(from, to, cfg, addDays) : [],
    cfg.jira.token ? fetchJira(from, to, cfg) : { events: [], comments: [], tested: [], bugs: [] },
  ]);
  return {
    events: [...slack.filter((e) => inRange(e.ts)), ...jira.events],
    statusEvents: store.data.statusLog,
    comments: jira.comments, tested: jira.tested, bugs: jira.bugs,
  };
}

const by = (arr, f) => arr.reduce((m, x) => { (m[f(x)] ||= []).push(x); return m; }, {});

async function buildReport(from, to, { cfg, store, showWeekends = false, activity }) {
  const act = activity || (await getActivity(from, to, cfg, store));
  const ev = by(act.events, (e) => parts(e.ts, cfg.tz).date);
  const se = by(act.statusEvents || [], (e) => parts(e.ts, cfg.tz).date);
  const cm = by(act.comments, (e) => parts(e.ts, cfg.tz).date);
  const ts = by(act.tested, (e) => e.date);
  const bg = by(act.bugs, (e) => parts(e.ts, cfg.tz).date);

  const rows = [];
  for (const date of dayRange(from, to)) {
    const weekend = isWeekend(date);
    const o = store.data.overrides[date];
    let day = computeDay(date, { events: ev[date] || [], statusEvents: se[date] || [] }, { ...cfg, now: cfg.now ?? Date.now() });
    day = applyOverride(day, o, cfg);
    if (o && o.end) day.inProgress = false; // an explicit manual end closes the day
    const hasData = day.start != null || (cm[date] || []).length || (ts[date] || []).length || (bg[date] || []).length;
    if (weekend && !(showWeekends && hasData)) continue;

    const sources = new Set([...(day.startSource || '').split('+'), ...(day.endSource || '').split('+')].filter((s) => s && s !== 'now'));
    const num = (k, auto) => (o && o[k] !== '' && o[k] != null ? +o[k] : auto);
    const tested = (ts[date] || []).sort((a, b) => a.ts - b.ts);
    const bugs = (bg[date] || []).sort((a, b) => a.ts - b.ts);
    const comments = (cm[date] || []).sort((a, b) => a.ts - b.ts);
    rows.push({
      date, weekday: weekday(date), weekend,
      start: day.start, end: day.end, startSource: day.startSource, endSource: day.endSource,
      source: [...sources].sort().join('+') || null,
      inProgress: !!day.inProgress,
      pauses: day.pauses, netMinutes: day.netMinutes, flags: day.flags, outliers: day.outliers,
      timeline: (day.timeline || []).map((t) => [t.ts, t.source === 'slack' ? 's' : 'j']),
      commentsCount: num('comments', comments.length), comments: comments.map((c) => ({ key: c.key, ts: c.ts })),
      testedCount: num('tested', tested.length), tested,
      bugsCount: num('bugs', bugs.length), bugs,
      edited: day.edited || null, override: o || null,
    });
  }
  return rows;
}

module.exports = { buildReport, getActivity };
