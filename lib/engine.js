// Start / end / pause detection for ONE day. Pure functions, no I/O.
//
// activity = {
//   events:       [{ ts, source: 'slack'|'jira', kind }]            // activity timestamps (UTC ms)
//   statusEvents: [{ ts, type:'presence', value:'active'|'away' }
//                  | { ts, type:'status', text, emoji }]            // logged by the Slack poller / events API
// }
//
// Status vocabulary (configurable regexes): "Working for ..." = working, "at lunch" = lunch, "AFK" = short pause,
// anything else / empty = off. Status beats presence, presence beats message timestamps.
const { parts, localToUtc, hhmmToMin } = require('./tz');

const union = (evs) => [...new Set(evs.map((e) => e.source))].sort().join('+') || null;

function isLunchStatus(s, cfg) {
  if (s.type !== 'status') return false;
  const e = cfg.engine;
  return e.lunchEmojis.includes(s.emoji) || new RegExp(e.lunchRegex, 'i').test(s.text || '');
}
function statusState(s, cfg) {
  const e = cfg.engine;
  if (isLunchStatus(s, cfg)) return 'lunch';
  if (new RegExp(e.afkRegex, 'i').test(s.text || '')) return 'afk';
  if (new RegExp(e.workRegex, 'i').test(s.text || '')) return 'work';
  return 'off';
}

function computeDay(date, activity, cfg) {
  const e = cfg.engine, tz = cfg.tz;
  const ws = hhmmToMin(e.windowStart), we = hhmmToMin(e.windowEnd);
  const flags = [];

  const all = (activity.events || [])
    .map((ev) => ({ ...ev, p: parts(ev.ts, tz) }))
    .filter((ev) => ev.p.date === date)
    .sort((a, b) => a.ts - b.ts);
  const inWin = all.filter((ev) => ev.p.minutes >= ws && ev.p.minutes <= we);
  const outliers = all.filter((ev) => ev.p.minutes < ws || ev.p.minutes > we);
  if (outliers.length) flags.push('outlier-activity'); // flagged, never silently dropped

  const st = (activity.statusEvents || [])
    .map((s) => ({ ...s, p: parts(s.ts, tz) }))
    .filter((s) => s.p.date === date)
    .sort((a, b) => a.ts - b.ts);

  // ---- status state machine: working / lunch / afk / off ----
  const statusPauses = [];
  let cur = null, workStart = null, workEnd = null;
  for (const s of st.filter((x) => x.type === 'status')) {
    const state = statusState(s, cfg);
    if (cur && cur.state !== state && (cur.state === 'lunch' || cur.state === 'afk')) {
      statusPauses.push({ start: cur.ts, end: s.ts, minutes: Math.round((s.ts - cur.ts) / 60000), source: 'status', type: cur.state === 'lunch' ? 'lunch' : 'pause' });
    }
    if (state === 'work') {
      if (workStart == null && s.p.minutes >= ws && s.p.minutes <= we) workStart = s.ts;
      workEnd = null;                                  // working again → not finished yet
    } else if (state === 'off' && workStart != null) workEnd = s.ts; // cleared after working → day over
    if (!cur || cur.state !== state) cur = { state, ts: s.ts };
  }

  // ---- start / end ----
  const pres = st.filter((s) => s.type === 'presence' && s.p.minutes >= ws && s.p.minutes <= we);
  const firstActive = pres.find((s) => s.value === 'active');
  const lastActive = [...pres].reverse().find((s) => s.value === 'active');
  const lastAway = [...pres].reverse().find((s) => s.value === 'away');

  let start = null, end = null, startSource = null, endSource = null;
  if (workStart != null) { start = workStart; startSource = 'status'; }
  else if (firstActive) { start = firstActive.ts; startSource = 'status'; }
  else if (inWin.length) {
    start = inWin[0].ts;
    startSource = union(inWin.filter((x) => x.ts - start <= 10 * 60000));
  }
  if (workEnd != null) { end = workEnd; endSource = 'status'; }
  else if (lastAway && (!lastActive || lastAway.ts >= lastActive.ts)) { end = lastAway.ts; endSource = 'status'; }
  else if (inWin.length) {
    end = inWin[inWin.length - 1].ts;
    endSource = union(inWin.filter((x) => end - x.ts <= 10 * 60000));
  } else if (lastActive) { end = lastActive.ts; endSource = 'status'; }
  // Today is still in progress unless the day was explicitly ended (status cleared after "Working…").
  // A last message at 4:07 PM does not mean you stopped at 4:07 PM.
  let inProgress = false;
  if (cfg.now != null && parts(cfg.now, tz).date === date && start != null && workEnd == null) {
    end = Math.max(end ?? 0, cfg.now); endSource = 'now'; inProgress = true; flags.push('in-progress');
  }
  if (start == null || end == null || end <= start) {
    return { date, start: null, end: null, startSource: null, endSource: null, pauses: [], netMinutes: 0, flags, outliers: outliers.map((o) => o.ts) };
  }

  // ---- pauses ----
  const pauses = statusPauses.filter((p) => p.start >= start && p.end <= end);
  let lunchFound = pauses.some((p) => p.type === 'lunch');

  // gaps in the merged Slack+Jira timeline (only a fallback: quiet ≠ away, so this is deliberately conservative)
  const ts = [start, ...inWin.map((x) => x.ts).filter((t) => t > start && t < end), end];
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push({ start: ts[i - 1], end: ts[i], ms: ts[i] - ts[i - 1] });
  const [lw0, lw1] = e.lunchWindow.map(hhmmToMin);
  const inLunchWin = (g) => { const a = parts(g.start, tz).minutes, b = parts(g.end, tz).minutes; return a < lw1 && b > lw0; };
  let lunchGap = null;
  if (!lunchFound) {
    const all2 = gaps.filter((g) => inLunchWin(g) && g.ms >= e.minLunchMin * 60000).sort((a, b) => b.ms - a.ms);
    const cands = all2.filter((g) => g.ms <= e.maxLunchMin * 60000); // a 4-hour silence is not lunch
    if (all2.length && !cands.length) flags.push('long-gap-ignored');
    const midday = cands.filter((g) => { const m = parts((g.start + g.end) / 2, tz).minutes; return m >= 720 && m <= 900; });
    if (cands.length) {
      lunchGap = (midday.length ? midday : cands)[0];
      pauses.push({ start: lunchGap.start, end: lunchGap.end, minutes: Math.round(lunchGap.ms / 60000), source: 'gap', type: 'lunch' });
      lunchFound = true;
    }
  }
  if (e.pauseMin > 0) { // optional: other long gaps as extra pauses (off by default)
    for (const g of gaps) {
      if (g === lunchGap || g.ms < e.pauseMin * 60000) continue;
      const overlaps = pauses.some((p) => g.start < p.end && g.end > p.start);
      if (!overlaps) pauses.push({ start: g.start, end: g.end, minutes: Math.round(g.ms / 60000), source: 'gap', type: 'pause' });
    }
  }
  const lunchStillToCome = inProgress && parts(cfg.now, tz).minutes < lw1; // don't assume lunch before it can have happened
  if (!lunchFound && !lunchStillToCome && end - start >= e.minDayForAssumedMin * 60000) {
    pauses.push({ start: null, end: null, minutes: e.defaultLunchMin, source: 'assumed', type: 'lunch' });
    flags.push('assumed-lunch');
  }
  pauses.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));

  const pauseMin = pauses.reduce((n, p) => n + p.minutes, 0);
  const netMinutes = Math.max(0, Math.round((end - start) / 60000) - pauseMin);

  return {
    date, start, end, startSource, endSource, pauses, netMinutes, flags, inProgress,
    outliers: outliers.map((o) => o.ts),
    timeline: inWin.map((x) => ({ ts: x.ts, source: x.source, kind: x.kind })),
  };
}

// Manual override ("edited") takes precedence. o = { start:'HH:MM', end:'HH:MM', lunchMinutes, comments, tested, bugs }
function applyOverride(day, o, cfg) {
  if (!o) return day;
  const d = { ...day, edited: Object.keys(o).filter((k) => o[k] !== '' && o[k] != null) };
  const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return localToUtc(day.date, h, m, cfg.tz); };
  if (o.start) { d.start = at(o.start); d.startSource = 'manual'; }
  if (o.end) { d.end = at(o.end); d.endSource = 'manual'; }
  if (o.lunchMinutes != null && o.lunchMinutes !== '') {
    d.pauses = +o.lunchMinutes > 0 ? [{ start: null, end: null, minutes: +o.lunchMinutes, source: 'manual', type: 'lunch' }] : [];
  }
  if (d.start && d.end && d.end > d.start) {
    d.netMinutes = Math.max(0, Math.round((d.end - d.start) / 60000) - d.pauses.reduce((n, p) => n + p.minutes, 0));
  }
  return d;
}

module.exports = { computeDay, applyOverride, isLunchStatus, statusState };
