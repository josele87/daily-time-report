// Time-zone helpers built on Intl (no dependencies). All "dates" are YYYY-MM-DD strings in the configured TZ.
const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

// Wall-clock parts of a UTC timestamp in a time zone.
function parts(ts, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  const h = +o.hour, m = +o.minute;
  return { date: `${o.year}-${o.month}-${o.day}`, y: +o.year, mo: +o.month, d: +o.day, h, m, minutes: h * 60 + m };
}

// UTC timestamp for a wall-clock time in a time zone (DST-safe via iteration).
function localToUtc(date, h, m, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, m);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, tz);
    guess += target - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.m);
  }
  return guess;
}

function addDays(date, n) {
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function weekday(date) { // 0 = Sunday
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
function isWeekend(date) { const w = weekday(date); return w === 0 || w === 6; }
function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function todayIn(tz) { return parts(Date.now(), tz).date; }
function hhmmToMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }

module.exports = { parts, localToUtc, addDays, weekday, isWeekend, dayRange, todayIn, hhmmToMin };
