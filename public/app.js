(function () {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

const STATIC = window.__STATIC__ || null;                       // exported snapshot (no server)
const SHARE = (location.pathname.match(/^\/share\/([a-f0-9]+)/) || [])[1] || null;
const READONLY = !!(STATIC || SHARE);
if (READONLY) document.body.classList.add('readonly');

let CFG = STATIC ? STATIC.cfg : { tz: 'America/Mexico_City', qa: { to: ['Ready for UAT', 'Done', "Won't Do"] } };
let ROWS = [], range = { from: null, to: null }, preset = null, weekends = false, token = null;
const open = new Set();
let h24 = ls.get('h24') === '1';

// ---------- date / time helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => d.split('-').map(Number);
const addDays = (d, n) => { const [y, m, dd] = ymd(d); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const dow = (d) => { const [y, m, dd] = ymd(d); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
const monday = (d) => addDays(d, -((dow(d) + 6) % 7));
const dlabel = (d) => { const [, m, dd] = ymd(d); return `${DOW[dow(d)]} ${MON[m - 1]} ${dd}`; };
const today = () => STATIC ? STATIC.today : new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz }).format(new Date());
const tfmt = () => h24
  ? new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  : new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, hour: 'numeric', minute: '2-digit', hour12: true });
const T = (ts) => (ts == null ? '—' : tfmt().format(new Date(ts)));
const hhmm = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
const minOfDay = (ts) => { const [h, m] = hhmm(ts).split(':').map(Number); return h * 60 + m; };
const dur = (m) => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${pad(r)}m` : `${r}m`; };
const sum = (a, f) => a.reduce((n, x) => n + f(x), 0);

const outcomeColor = (o) => { const s = String(o).toLowerCase(); return s.includes('uat') ? 'var(--uat)' : s.includes('done') ? 'var(--done)' : 'var(--wont)'; };
const outcomes = () => (CFG.qa && CFG.qa.to) || ['Ready for UAT', 'Done', "Won't Do"];

// ---------- data ----------
function showErr(m) { const e = $('#error'); e.textContent = m; e.hidden = false; }
async function load() {
  $('#error').hidden = true;
  try {
    if (STATIC) {
      ROWS = STATIC.rows.filter((r) => r.date >= range.from && r.date <= range.to && (weekends || !r.weekend));
    } else {
      const base = SHARE ? `/api/share/${SHARE}/report` : '/api/report';
      const res = await fetch(`${base}?from=${range.from}&to=${range.to}&weekends=${weekends ? 1 : 0}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      ROWS = j.rows; CFG = j.cfg; token = j.shareToken || null;
    }
    render();
  } catch (e) { showErr('Could not load the report: ' + e.message); }
}

function totals(rows) {
  const w = rows.filter((r) => r.start != null);
  const net = sum(w, (r) => r.netMinutes);
  const by = {};
  for (const r of rows) for (const t of r.tested) by[t.outcome] = (by[t.outcome] || 0) + 1;
  return {
    days: w.length, net, avg: w.length ? net / w.length : 0,
    tested: sum(rows, (r) => r.testedCount), bugs: sum(rows, (r) => r.bugsCount), comments: sum(rows, (r) => r.commentsCount), by,
  };
}

// ---------- rendering ----------
function render() {
  const t = totals(ROWS);
  $('#sub').innerHTML = `${esc(CFG.tz)} · ${dlabel(range.from)} – ${dlabel(range.to)}` +
    (CFG.mock ? ' <span class="badge mock">Sample data</span>' : '') + (CFG.real ? ' <span class="badge s-status">Real data · Slack + Jira</span>' : '') + (READONLY ? ' <span class="badge">Read-only</span>' : '');
  $('#b-fmt').textContent = h24 ? '24h' : '12h';
  $('#presets').innerHTML = presets().map((p) => `<button class="btn ${p.id === preset ? 'on' : ''}" data-p="${p.id}">${esc(p.label)}</button>`).join('');
  $('#from').value = range.from; $('#to').value = range.to; $('#weekends').checked = weekends;

  const oc = outcomes();
  $('#cards').innerHTML = [
    ['Total hours', dur(t.net), `${t.days} workday${t.days === 1 ? '' : 's'}`],
    ['Daily average', dur(t.avg), 'net of lunch & pauses'],
    ['Tickets tested', t.tested, oc.map((o) => `${t.by[o] || 0} ${o.replace('Ready for ', '')}`).join(' · ')],
    ['Bugs reported', t.bugs, t.days ? `${(t.bugs / t.days).toFixed(1)} / day` : ''],
    ['Jira comments', t.comments, t.days ? `${(t.comments / t.days).toFixed(1)} / day` : ''],
  ].map(([k, v, d]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${esc(d)}</div></div>`).join('');

  chartHours(); chartTested(); table();
  $('#foot').innerHTML = `Start/end = first/last Slack or Jira activity (Slack status/presence when logged). Lunch = lunch status, else the longest midday gap ≥ ${CFG.engine ? CFG.engine.minLunchMin : 30} min, else ${CFG.engine ? CFG.engine.defaultLunchMin : 30} min assumed. ` +
    `Tickets tested = tickets I moved from <b>${esc((CFG.qa.from || ['In QA']).join(' / '))}</b> to <b>${esc(oc.join(' / '))}</b>.`;
}

function presets() {
  const td = today(), wk = monday(td), [y, m] = ymd(td);
  const lm = m === 1 ? [y - 1, 12] : [y, m - 1];
  const eom = (yy, mm) => addDays(`${mm === 12 ? yy + 1 : yy}-${pad(mm === 12 ? 1 : mm + 1)}-01`, -1);
  const list = [
    { id: 'tw', label: 'This week', from: wk, to: td },
    { id: 'lw', label: 'Last week', from: addDays(wk, -7), to: addDays(wk, -3) },
    { id: 'tm', label: 'This month', from: `${y}-${pad(m)}-01`, to: td },
    { id: 'lm', label: 'Last month', from: `${lm[0]}-${pad(lm[1])}-01`, to: eom(lm[0], lm[1]) },
  ];
  if (STATIC) list.push({ id: 'all', label: 'All (Oct–Nov)', from: STATIC.from, to: STATIC.to });
  return list;
}

function svgBars(w, h, n, cb) { // helper for both charts
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${cb}</svg>`;
}

function chartHours() {
  const rows = ROWS.filter((r) => r.start != null);
  if (!rows.length) { $('#chart-hours').innerHTML = '<div class="empty">No activity in this range</div>'; return; }
  const W = 560, H = 190, L = 26, R = 6, Tp = 12, B = 22, pw = W - L - R, ph = H - Tp - B;
  const max = Math.max(10, Math.ceil(Math.max(...rows.map((r) => r.netMinutes / 60))));
  const step = pw / rows.length, bw = Math.min(26, step * 0.68);
  const y = (v) => Tp + ph - (v / max) * ph;
  const avg = sum(rows, (r) => r.netMinutes) / rows.length / 60;
  let s = '';
  for (let g = 0; g <= max; g += 2) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 4}" y="${y(g) + 3}" text-anchor="end">${g}</text>`;
  rows.forEach((r, i) => {
    const x = L + i * step + (step - bw) / 2, hh = r.netMinutes / 60;
    s += `<rect x="${x}" y="${y(hh)}" width="${bw}" height="${Tp + ph - y(hh)}" rx="3" fill="var(--accent)" opacity=".9"><title>${dlabel(r.date)}: ${dur(r.netMinutes)}</title></rect>`;
    const lab = rows.length <= 16 || dow(r.date) === 1;
    if (lab) s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${rows.length <= 16 ? ymd(r.date)[2] : `${ymd(r.date)[1]}/${ymd(r.date)[2]}`}</text>`;
  });
  s += `<line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--bug)" stroke-dasharray="4 3" stroke-width="1.2"/><text x="${W - R}" y="${y(avg) - 4}" text-anchor="end" style="fill:var(--bug)">avg ${avg.toFixed(1)}h</text>`;
  $('#chart-hours').innerHTML = svgBars(W, H, 0, s);
}

function chartTested() {
  const rows = ROWS.filter((r) => r.start != null || r.testedCount || r.bugsCount);
  $('#legend').innerHTML = [...outcomes(), 'Bugs'].map((o) => `<span><i style="background:${o === 'Bugs' ? 'var(--bug)' : outcomeColor(o)}"></i>${esc(o)}</span>`).join('');
  if (!rows.length) { $('#chart-tested').innerHTML = '<div class="empty">No data in this range</div>'; return; }
  const W = 560, H = 190, L = 26, R = 6, Tp = 12, B = 22, pw = W - L - R, ph = H - Tp - B;
  const max = Math.max(6, ...rows.map((r) => Math.max(r.testedCount, r.bugsCount)));
  const step = pw / rows.length, bw = Math.min(20, step * 0.5), gap = 1.5;
  const y = (v) => Tp + ph - (v / max) * ph;
  let s = '';
  for (let g = 0; g <= max; g += max > 10 ? 4 : 2) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 4}" y="${y(g) + 3}" text-anchor="end">${g}</text>`;
  rows.forEach((r, i) => {
    const x0 = L + i * step + (step - (bw + gap + bw * 0.55)) / 2;
    let acc = 0;
    for (const o of outcomes()) {
      const c = r.tested.filter((t) => t.outcome === o).length; if (!c) continue;
      s += `<rect x="${x0}" y="${y(acc + c)}" width="${bw}" height="${y(acc) - y(acc + c)}" fill="${outcomeColor(o)}"><title>${dlabel(r.date)} · ${esc(o)}: ${c}</title></rect>`; acc += c;
    }
    if (r.bugsCount) s += `<rect x="${x0 + bw + gap}" y="${y(r.bugsCount)}" width="${bw * 0.55}" height="${y(0) - y(r.bugsCount)}" fill="var(--bug)"><title>${dlabel(r.date)} · bugs: ${r.bugsCount}</title></rect>`;
    const lab = rows.length <= 16 || dow(r.date) === 1;
    if (lab) s += `<text x="${x0 + bw / 2}" y="${H - 8}" text-anchor="middle">${rows.length <= 16 ? ymd(r.date)[2] : `${ymd(r.date)[1]}/${ymd(r.date)[2]}`}</text>`;
  });
  $('#chart-tested').innerHTML = svgBars(W, H, 0, s);
}

const srcBadge = (s) => s ? s.split('+').map((p) => `<span class="badge s-${p}">${p}</span>`).join('') : '<span class="badge">no activity</span>';

function lunchCell(r) {
  if (r.start == null) return '—';
  const lunch = r.pauses.find((p) => p.type === 'lunch'), extra = r.pauses.filter((p) => p.type !== 'lunch');
  let s = '';
  if (!lunch) s = '<span class="badge">none</span>';
  else if (lunch.start == null) s = `${lunch.minutes}m <span class="badge s-${lunch.source}">${lunch.source}</span>`;
  else s = `${T(lunch.start)}–${T(lunch.end)} <span style="color:var(--muted)">(${lunch.minutes}m)</span>${lunch.source === 'status' ? ' <span class="badge s-status">status</span>' : ''}`;
  if (extra.length) s += ` <span class="badge warn" title="${esc(extra.map((p) => `${T(p.start)}–${T(p.end)}`).join(', '))}">+${dur(sum(extra, (p) => p.minutes))} pause</span>`;
  return s;
}

function table() {
  const head = '<thead><tr><th></th><th>Date</th><th>Start</th><th>Lunch</th><th>End</th><th class="n">Net hours</th><th class="n">Comments</th><th class="n">Tested</th><th class="n">Bugs</th><th>Source</th></tr></thead>';
  if (!ROWS.length) { $('#tbl').innerHTML = head + '<tbody><tr><td colspan="10" class="empty">No days in this range</td></tr></tbody>'; return; }
  let body = '', group = [], wk = null;
  const flush = () => {
    if (!group.length) return;
    const t = totals(group);
    body += `<tr class="week"><td></td><td colspan="4">Week of ${dlabel(wk)}</td><td class="n">${dur(t.net)}</td><td class="n">${t.comments}</td><td class="n">${t.tested}</td><td class="n">${t.bugs}</td><td>${t.days} day${t.days === 1 ? '' : 's'} · avg ${dur(t.avg)}</td></tr>`;
    group = [];
  };
  for (const r of ROWS) {
    const w = monday(r.date);
    if (wk !== null && w !== wk) flush();
    wk = w; group.push(r);
    const isOpen = open.has(r.date), off = r.start == null;
    body += `<tr class="day ${isOpen ? 'open' : ''} ${off ? 'off' : ''}" data-date="${r.date}"><td><span class="chev">›</span></td>` +
      `<td>${dlabel(r.date)}${r.edited ? ' <span class="badge s-manual">edited</span>' : ''}${r.flags.includes('outlier-activity') ? ' <span class="badge warn" title="Activity outside the workday window was ignored">outlier</span>' : ''}</td>` +
      `<td>${T(r.start)}</td><td>${lunchCell(r)}</td><td>${T(r.end)}</td><td class="n net">${off ? '—' : dur(r.netMinutes)}</td>` +
      `<td class="n">${r.commentsCount}</td><td class="n">${r.testedCount}</td><td class="n">${r.bugsCount}</td><td>${srcBadge(r.source)}</td></tr>`;
    if (isOpen) body += `<tr class="detail"><td></td><td colspan="9">${detail(r)}</td></tr>`;
  }
  flush();
  $('#tbl').innerHTML = head + '<tbody>' + body + '</tbody>';
}

function timeline(r) {
  const A = 360, Z = 1320, W = 520, x = (m) => 8 + ((Math.min(Z, Math.max(A, m)) - A) / (Z - A)) * (W - 16);
  let s = '';
  for (let h = 6; h <= 22; h += 2) s += `<line class="grid" x1="${x(h * 60)}" x2="${x(h * 60)}" y1="8" y2="44"/><text x="${x(h * 60)}" y="56" text-anchor="middle">${h}</text>`;
  for (const p of r.pauses) if (p.start != null) s += `<rect x="${x(minOfDay(p.start))}" y="8" width="${Math.max(2, x(minOfDay(p.end)) - x(minOfDay(p.start)))}" height="36" fill="var(--muted)" opacity=".18" rx="3"><title>${p.type} ${p.minutes}m</title></rect>`;
  for (const [ts, k] of r.timeline) s += `<circle cx="${x(minOfDay(ts))}" cy="${k === 's' ? 19 : 33}" r="2.6" fill="${k === 's' ? 'var(--slack)' : 'var(--jira)'}"><title>${k === 's' ? 'Slack' : 'Jira'} ${T(ts)}</title></circle>`;
  return `<svg viewBox="0 0 ${W} 62" width="100%">${s}</svg><div class="legend"><span><i style="background:var(--slack)"></i>Slack</span><span><i style="background:var(--jira)"></i>Jira</span><span><i style="background:var(--muted);opacity:.4"></i>pause</span></div>`;
}

function detail(r) {
  const link = (k) => CFG.jiraBase ? `<a class="chip" target="_blank" rel="noopener" href="${esc(CFG.jiraBase)}/browse/${esc(k)}">${esc(k)}</a>` : `<span class="chip">${esc(k)}</span>`;
  const groups = outcomes().map((o) => {
    const l = r.tested.filter((t) => t.outcome === o);
    return l.length ? `<div class="grp"><b><span class="dot" style="background:${outcomeColor(o)}"></span>${esc(o)} (${l.length})</b><div class="chips">${l.map((t) => `<span title="${esc(t.title)} · ${T(t.ts)}">${link(t.key)}</span>`).join('')}</div></div>` : '';
  }).join('') || '<div class="empty" style="padding:6px;text-align:left">No tickets moved out of QA</div>';
  const bugs = r.bugs.map((b) => `<div class="bug">${link(b.key)} ${esc(b.title)} <span class="badge">${esc(b.priority)}</span></div>`).join('') || '<div class="empty" style="padding:6px;text-align:left">No bugs reported</div>';
  const o = r.override || {};
  const edit = READONLY ? '' : `<h4 style="margin-top:14px">Manual override</h4><div class="edit" data-date="${r.date}">
    <label>Start<input type="time" name="start" value="${esc(o.start || (r.start && !r.edited ? hhmm(r.start) : ''))}"></label>
    <label>End<input type="time" name="end" value="${esc(o.end || (r.end && !r.edited ? hhmm(r.end) : ''))}"></label>
    <label>Lunch (min)<input type="number" name="lunchMinutes" min="0" value="${esc(o.lunchMinutes ?? '')}"></label>
    <label>Comments<input type="number" name="comments" min="0" value="${esc(o.comments ?? '')}"></label>
    <label>Tested<input type="number" name="tested" min="0" value="${esc(o.tested ?? '')}"></label>
    <label>Bugs<input type="number" name="bugs" min="0" value="${esc(o.bugs ?? '')}"></label></div>
    <div class="actions" style="margin-top:8px"><button class="btn primary" data-act="save">Save override</button><button class="btn" data-act="reset">Reset to auto</button></div>`;
  return `<div class="det"><div><h4>Tickets tested</h4>${groups}<h4 style="margin-top:10px">Bugs reported</h4>${bugs}</div>
    <div><h4>Activity timeline</h4>${timeline(r)}<div style="margin-top:6px;color:var(--muted);font-size:12px">Start: ${srcBadge(r.startSource)} End: ${srcBadge(r.endSource)}</div>
    <div class="actions" style="margin-top:8px"><button class="btn" data-act="copy-day" data-date="${r.date}">Copy this day</button></div>${edit}</div></div>`;
}

// ---------- text / csv ----------
function lineFor(r) {
  if (r.start == null && !r.testedCount && !r.bugsCount) return `${dlabel(r.date)} — no activity`;
  const lunch = r.pauses.find((p) => p.type === 'lunch'), extra = r.pauses.filter((p) => p.type !== 'lunch');
  const lt = lunch ? (lunch.start != null ? `lunch ${T(lunch.start)}-${T(lunch.end)}` : `lunch ${lunch.minutes}m${lunch.source === 'assumed' ? ' assumed' : ''}`) : 'no lunch';
  let s = `${dlabel(r.date)} — ${T(r.start)} to ${T(r.end)} (${lt}${extra.length ? `, +${dur(sum(extra, (p) => p.minutes))} pause` : ''}) = ${dur(r.netMinutes)}`;
  const by = outcomes().map((o) => [o, r.tested.filter((t) => t.outcome === o)]).filter(([, l]) => l.length);
  const keys = r.tested.slice(0, 4).map((t) => t.key).join(', ') + (r.tested.length > 4 ? '…' : '');
  s += ` | ${r.testedCount} ticket${r.testedCount === 1 ? '' : 's'} tested` + (by.length ? `: ${by.map(([o, l]) => `${l.length} ${o}`).join(', ')} (${keys})` : '');
  s += ` | ${r.bugsCount} bug${r.bugsCount === 1 ? '' : 's'} reported` + (r.bugs.length ? ` (${r.bugs.map((b) => b.key).join(', ')})` : '');
  return s + ` | ${r.commentsCount} Jira comment${r.commentsCount === 1 ? '' : 's'}`;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); }
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { const a = document.createElement('textarea'); a.value = text; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); toast(msg); } catch { toast('Copy blocked by the browser'); } a.remove(); }
}
function csv() {
  const oc = outcomes();
  const rows = [['Date', 'Start', 'End', 'Lunch min', 'Other pause min', 'Net hours', 'Comments', 'Tested', ...oc, 'Bugs', 'Source']];
  for (const r of ROWS) {
    const lunch = sum(r.pauses.filter((p) => p.type === 'lunch'), (p) => p.minutes), other = sum(r.pauses.filter((p) => p.type !== 'lunch'), (p) => p.minutes);
    rows.push([r.date, r.start ? hhmm(r.start) : '', r.end ? hhmm(r.end) : '', lunch, other, (r.netMinutes / 60).toFixed(2), r.commentsCount, r.testedCount, ...oc.map((o) => r.tested.filter((t) => t.outcome === o).length), r.bugsCount, r.source || '']);
  }
  const text = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = `time-report_${range.from}_${range.to}.csv`; a.click();
}

// ---------- events ----------
function setRange(from, to, id) { range = { from, to }; preset = id || null; load(); }
$('#presets').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (!b) return; const p = presets().find((x) => x.id === b.dataset.p); setRange(p.from, p.to, p.id); });
$('#from').addEventListener('change', (e) => e.target.value && setRange(e.target.value, range.to));
$('#to').addEventListener('change', (e) => e.target.value && setRange(range.from, e.target.value));
$('#weekends').addEventListener('change', (e) => { weekends = e.target.checked; load(); });
$('#b-fmt').addEventListener('click', () => { h24 = !h24; ls.set('h24', h24 ? '1' : '0'); render(); });
$('#b-theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; ls.set('theme', next);
});
$('#b-refresh').addEventListener('click', async () => { await fetch('/api/sync', { method: 'POST' }); await load(); toast('Refreshed'); });
$('#b-share').addEventListener('click', () => token ? copy(`${location.origin}/share/${token}`, 'Share link copied') : toast('No share token'));
$('#b-copy').addEventListener('click', () => copy(ROWS.map(lineFor).join('\n'), 'Summary copied'));
$('#b-csv').addEventListener('click', csv);

$('#tbl').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    if (act === 'copy-day') return copy(lineFor(ROWS.find((r) => r.date === btn.dataset.date)), 'Day copied');
    const box = btn.closest('td').querySelector('.edit'), date = box.dataset.date;
    if (act === 'save') {
      const b = {}; box.querySelectorAll('input').forEach((i) => (b[i.name] = i.value));
      await fetch(`/api/override/${date}`, { method: 'PUT', body: JSON.stringify(b) });
    } else await fetch(`/api/override/${date}`, { method: 'DELETE' });
    return load();
  }
  if (e.target.closest('.detail')) return;
  const tr = e.target.closest('tr.day'); if (!tr) return;
  const d = tr.dataset.date; open.has(d) ? open.delete(d) : open.add(d); table();
});

const dlg = $('#dlg');
$('#b-settings').addEventListener('click', () => {
  const f = $('#settings-form');
  f.tz.value = CFG.tz; f.qaFrom.value = (CFG.qa.from || []).join(', '); f.qaTo.value = (CFG.qa.to || []).join(', ');
  f.defaultLunchMin.value = CFG.engine.defaultLunchMin; f.minLunchMin.value = CFG.engine.minLunchMin; f.pauseMin.value = CFG.engine.pauseMin;
  dlg.showModal();
});
$('#settings-form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'save') return;
  const f = e.target, split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const res = await fetch('/api/settings', { method: 'PUT', body: JSON.stringify({ tz: f.tz.value, qaFrom: split(f.qaFrom.value), qaTo: split(f.qaTo.value), defaultLunchMin: f.defaultLunchMin.value, minLunchMin: f.minLunchMin.value, pauseMin: f.pauseMin.value }) });
  if (!res.ok) showErr('Settings were not saved: ' + (await res.json()).error);
  await load();
});

// ---------- boot ----------
const savedTheme = ls.get('theme'); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
if (STATIC) { const all = presets().find((p) => p.id === 'all'); setRange(all.from, all.to, 'all'); }
else { const p = presets()[0]; setRange(p.from, p.to, p.id); }
})();
