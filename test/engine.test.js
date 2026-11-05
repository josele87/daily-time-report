const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('../lib/config');
const { computeDay, applyOverride } = require('../lib/engine');
const { localToUtc, parts } = require('../lib/tz');

const cfg = { ...defaults, mock: true, tz: 'America/Mexico_City' };
const D = '2026-11-03';
const at = (h, m = 0, date = D, tz = cfg.tz) => localToUtc(date, h, m, tz);
const ev = (h, m, source = 'slack') => ({ ts: at(h, m), source, kind: 'x' });
// a dense morning + afternoon with a gap for lunch
const day = (lunchFrom = [12, 30], lunchTo = [13, 20]) => {
  const out = [];
  for (let t = 9 * 60; t <= 18 * 60; t += 10) {
    const afterFrom = t > lunchFrom[0] * 60 + lunchFrom[1], beforeTo = t < lunchTo[0] * 60 + lunchTo[1];
    if (afterFrom && beforeTo) continue;
    out.push(ev(Math.floor(t / 60), t % 60, t % 20 ? 'slack' : 'jira'));
  }
  return out;
};

test('first/last activity define start/end; lunch = midday gap; net hours subtract it', () => {
  const r = computeDay(D, { events: day() }, cfg);
  assert.equal(parts(r.start, cfg.tz).minutes, 9 * 60);
  assert.equal(parts(r.end, cfg.tz).minutes, 18 * 60);
  const lunch = r.pauses.find((p) => p.type === 'lunch');
  assert.equal(lunch.source, 'gap');
  assert.equal(lunch.minutes, 50); // last msg 12:30 → next 13:20
  assert.equal(r.netMinutes, 9 * 60 - 50);
});

test('no lunch gap on a long day → assumed default lunch, flagged', () => {
  const evs = []; for (let t = 9 * 60; t <= 18 * 60; t += 10) evs.push(ev(Math.floor(t / 60), t % 60));
  const r = computeDay(D, { events: evs }, cfg);
  assert.deepEqual(r.pauses.map((p) => [p.source, p.minutes]), [['assumed', 30]]);
  assert.ok(r.flags.includes('assumed-lunch'));
  assert.equal(r.netMinutes, 9 * 60 - 30);
});

test('short day (< threshold) gets no assumed lunch', () => {
  const evs = []; for (let t = 9 * 60; t <= 12 * 60; t += 10) evs.push(ev(Math.floor(t / 60), t % 60));
  const r = computeDay(D, { events: evs }, cfg);
  assert.equal(r.pauses.length, 0);
  assert.equal(r.netMinutes, 180);
});

test('lunch status wins over message gaps', () => {
  const statusEvents = [
    { ts: at(13, 0), type: 'status', emoji: ':knife_fork_plate:', text: 'Lunch' },
    { ts: at(13, 45), type: 'status', emoji: '', text: '' },
  ];
  const r = computeDay(D, { events: day([12, 30], [13, 20]), statusEvents }, cfg);
  const lunch = r.pauses.find((p) => p.type === 'lunch');
  assert.equal(lunch.source, 'status');
  assert.equal(lunch.minutes, 45);
});

test('Spanish status text ("almuerzo") is recognised as lunch', () => {
  const statusEvents = [
    { ts: at(14, 0), type: 'status', emoji: '', text: 'almuerzo' },
    { ts: at(14, 40), type: 'status', emoji: '', text: '' },
  ];
  const r = computeDay(D, { events: day([13, 55], [14, 45]), statusEvents }, cfg);
  assert.equal(r.pauses[0].source, 'status');
  assert.equal(r.pauses[0].minutes, 40);
});

test('presence active/away takes priority for start and end', () => {
  const statusEvents = [{ ts: at(8, 52), type: 'presence', value: 'active' }, { ts: at(18, 7), type: 'presence', value: 'away' }];
  const r = computeDay(D, { events: day(), statusEvents }, cfg);
  assert.equal(r.startSource, 'status'); assert.equal(r.endSource, 'status');
  assert.equal(parts(r.start, cfg.tz).minutes, 8 * 60 + 52);
  assert.equal(parts(r.end, cfg.tz).minutes, 18 * 60 + 7);
});

const cfgGaps = { ...cfg, engine: { ...cfg.engine, pauseMin: 60 } }; // opt in to gap-based extra pauses

test('quiet gaps are NOT subtracted as pauses by default (chat is sparse)', () => {
  const evs = day([12, 30], [13, 20]).filter((e) => { const m = parts(e.ts, cfg.tz).minutes; return !(m > 15 * 60 && m < 16 * 60 + 30); });
  const r = computeDay(D, { events: evs }, cfg);
  assert.deepEqual(r.pauses.map((p) => p.type), ['lunch']);
});

test('a quiet gap longer than maxLunchMin is not lunch → assumed lunch, flagged', () => {
  const evs = day([11, 0], [14, 30]); // 3.5 h silence
  const r = computeDay(D, { events: evs }, cfg);
  assert.ok(r.flags.includes('long-gap-ignored'));
  assert.deepEqual(r.pauses.map((p) => [p.source, p.minutes]), [['assumed', 30]]);
});

test('status vocabulary: "Working…" starts the day, "at lunch" and "AFK" are pauses, cleared status ends it', () => {
  const S = (h, m, text, emoji = '') => ({ ts: at(h, m), type: 'status', text, emoji });
  const statusEvents = [
    S(8, 50, 'Working for Vail projects', ':work_in_progress:'),
    S(12, 30, 'at lunch'), S(13, 15, 'Working for Vail projects', ':work_in_progress:'),
    S(15, 0, 'AFK'), S(15, 20, 'Working for Vail projects', ':work_in_progress:'),
    S(18, 10, ''),
  ];
  const r = computeDay(D, { events: day(), statusEvents }, cfg);
  assert.equal(r.startSource, 'status'); assert.equal(r.endSource, 'status');
  assert.equal(parts(r.start, cfg.tz).minutes, 8 * 60 + 50);
  assert.equal(parts(r.end, cfg.tz).minutes, 18 * 60 + 10);
  assert.deepEqual(r.pauses.map((p) => [p.type, p.minutes, p.source]), [['lunch', 45, 'status'], ['pause', 20, 'status']]);
  assert.equal(r.netMinutes, (18 * 60 + 10) - (8 * 60 + 50) - 45 - 20);
});

test('status "Working" set again after being cleared cancels the earlier end', () => {
  const S = (h, m, text) => ({ ts: at(h, m), type: 'status', text, emoji: '' });
  const statusEvents = [S(9, 0, 'Working for X'), S(17, 0, ''), S(19, 0, 'Working for X')];
  const r = computeDay(D, { events: day(), statusEvents }, cfg);
  assert.equal(r.endSource !== 'status', true); // not finished → falls back to activity end
});

test('multiple gap pauses are subtracted when opted in (lunch + long afternoon gap)', () => {
  const evs = day([12, 30], [13, 20]).filter((e) => { const m = parts(e.ts, cfg.tz).minutes; return !(m > 15 * 60 && m < 16 * 60 + 30); });
  const r = computeDay(D, { events: evs }, cfgGaps);
  const kinds = r.pauses.map((p) => p.type).sort();
  assert.deepEqual(kinds, ['lunch', 'pause']);
  assert.equal(r.netMinutes, 540 - r.pauses.reduce((n, p) => n + p.minutes, 0));
});

test('late-night / pre-dawn activity is flagged and ignored for start/end', () => {
  const evs = [...day(), ev(23, 40), ev(3, 15)];
  const r = computeDay(D, { events: evs }, cfg);
  assert.ok(r.flags.includes('outlier-activity'));
  assert.equal(r.outliers.length, 2);
  assert.equal(parts(r.end, cfg.tz).minutes, 18 * 60);
  assert.equal(parts(r.start, cfg.tz).minutes, 9 * 60);
});

test('Jira-only day uses Jira as the source', () => {
  const evs = day().map((e) => ({ ...e, source: 'jira' }));
  const r = computeDay(D, { events: evs }, cfg);
  assert.equal(r.startSource, 'jira'); assert.equal(r.endSource, 'jira');
});

test('start source is the union when Slack and Jira activity coincide', () => {
  const evs = [ev(9, 0, 'slack'), ev(9, 3, 'jira'), ...day().slice(2)];
  const r = computeDay(D, { events: evs }, cfg);
  assert.equal(r.startSource, 'jira+slack');
});

test('a late-afternoon gap is not mistaken for lunch when a midday gap exists', () => {
  const evs = day([12, 30], [13, 20]).filter((e) => { const m = parts(e.ts, cfg.tz).minutes; return !(m > 15 * 60 && m < 16 * 60 + 40); }); // 100-min late gap
  const r = computeDay(D, { events: evs }, cfg);
  const lunch = r.pauses.find((p) => p.type === 'lunch');
  assert.ok(parts(lunch.start, cfg.tz).minutes < 14 * 60);
});

test('no activity → null start/end', () => {
  const r = computeDay(D, { events: [] }, cfg);
  assert.equal(r.start, null); assert.equal(r.netMinutes, 0);
});

test('events are bucketed by LOCAL date (23:30 local on Nov 3 is still Nov 3)', () => {
  const r = computeDay(D, { events: [...day(), { ts: at(23, 30), source: 'slack' }] }, { ...cfg, engine: { ...cfg.engine, windowEnd: '23:59' } });
  assert.equal(parts(r.end, cfg.tz).minutes, 23 * 60 + 30);
});

test('DST: wall-clock conversion is correct on both sides of spring-forward and fall-back (America/New_York)', () => {
  const ny = 'America/New_York';
  assert.equal(new Date(localToUtc('2026-03-07', 9, 0, ny)).toISOString(), '2026-03-07T14:00:00.000Z'); // EST
  assert.equal(new Date(localToUtc('2026-03-08', 9, 0, ny)).toISOString(), '2026-03-08T13:00:00.000Z'); // EDT
  assert.equal(new Date(localToUtc('2026-10-31', 9, 0, ny)).toISOString(), '2026-10-31T13:00:00.000Z'); // EDT
  assert.equal(new Date(localToUtc('2026-11-01', 9, 0, ny)).toISOString(), '2026-11-01T14:00:00.000Z'); // EST
  // a 9→18 workday on the fall-back day is still 9 local hours
  const c = { ...cfg, tz: ny };
  const evs = []; for (let t = 9 * 60; t <= 18 * 60; t += 10) evs.push({ ts: localToUtc('2026-11-01', Math.floor(t / 60), t % 60, ny), source: 'slack' });
  const r = computeDay('2026-11-01', { events: evs }, c);
  assert.equal(parts(r.start, ny).minutes, 540); assert.equal(parts(r.end, ny).minutes, 1080);
});

test('today is "in progress": end = now (not the last message) until the day is explicitly ended', () => {
  const evs = day([12, 30], [13, 20]).filter((e) => parts(e.ts, cfg.tz).minutes <= 16 * 60 + 7); // last message 4:07 PM
  const now = at(17, 25);
  const r = computeDay(D, { events: evs }, { ...cfg, now });
  assert.equal(r.inProgress, true); assert.equal(r.endSource, 'now'); assert.equal(r.end, now);
  assert.ok(r.flags.includes('in-progress'));
  assert.equal(r.netMinutes, (17 * 60 + 25) - 9 * 60 - 50); // counted up to now, minus the 50-min lunch
});

test('today: a cleared status after "Working…" ends the day at that moment', () => {
  const S = (h, m, text) => ({ ts: at(h, m), type: 'status', text, emoji: '' });
  const r = computeDay(D, { events: day(), statusEvents: [S(9, 0, 'Working for X'), S(17, 30, '')] }, { ...cfg, now: at(19, 0) });
  assert.equal(r.inProgress, false); assert.equal(parts(r.end, cfg.tz).minutes, 17 * 60 + 30);
});

test('today before midday: no assumed lunch is subtracted yet', () => {
  const evs = []; for (let t = 7 * 60; t <= 12 * 60 + 30; t += 10) evs.push(ev(Math.floor(t / 60), t % 60));
  const r = computeDay(D, { events: evs }, { ...cfg, now: at(12, 40) });
  assert.equal(r.pauses.length, 0);
});

test('past days are unaffected by "now"', () => {
  const r = computeDay(D, { events: day() }, { ...cfg, now: at(10, 0, '2026-11-09') });
  assert.equal(r.inProgress, false); assert.equal(parts(r.end, cfg.tz).minutes, 18 * 60);
});

test('manual override takes precedence and recomputes net hours', () => {
  const base = computeDay(D, { events: day() }, cfg);
  const r = applyOverride(base, { start: '08:30', end: '17:30', lunchMinutes: 45 }, cfg);
  assert.equal(r.startSource, 'manual');
  assert.equal(r.netMinutes, 9 * 60 - 45);
  assert.ok(r.edited.includes('start'));
});

// ---- files data source ----
test('files source: overrides.json rule moves late starts to 08:45 (in memory only)', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { ruleOverrides } = require('../lib/files');
  const real = path.join(__dirname, '..', 'data', 'overrides.json');
  if (!fs.existsSync(real)) return; // data/ is git-ignored; nothing to check in a clean clone
  const cfg = { tz: 'America/Bogota' };
  const late = Date.parse('2026-10-06T09:30:00-05:00'), early = Date.parse('2026-10-07T08:40:00-05:00');
  const rows = [{ date: '2026-10-06', weekend: false, start: late }, { date: '2026-10-07', weekend: false, start: early }, { date: '2026-10-27', weekend: false, start: late }];
  const out = ruleOverrides(rows, cfg);
  assert.deepEqual(out['2026-10-06'], { start: '08:45' });
  assert.equal(out['2026-10-07'], undefined);
  assert.equal(out['2026-10-27'], undefined);
});
