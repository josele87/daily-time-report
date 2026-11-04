// Jira Cloud connector. extractTested / myTransitions are pure and unit-tested.
const { parts, addDays } = require('./tz');

const lc = (s) => String(s || '').trim().toLowerCase();

// "Tickets tested" = status changes made by ME, FROM a QA status TO a done-ish status.
// Deduped per ticket per day (latest transition that day wins).
function extractTested(issue, histories, meAccountId, cfg) {
  const from = new Set(cfg.qa.from.map(lc));
  const to = new Map(cfg.qa.to.map((s) => [lc(s), s]));
  const best = new Map();
  for (const h of histories) {
    if (h.author?.accountId !== meAccountId) continue;
    for (const it of h.items || []) {
      if (it.field !== 'status') continue;
      if (!from.has(lc(it.fromString)) || !to.has(lc(it.toString))) continue;
      const ts = Date.parse(h.created);
      const date = parts(ts, cfg.tz).date;
      const k = `${issue.key}|${date}`;
      if (!best.has(k) || best.get(k).ts < ts) {
        best.set(k, { key: issue.key, title: issue.summary || '', ts, date, outcome: to.get(lc(it.toString)) });
      }
    }
  }
  return [...best.values()];
}

// Every status transition I made (used only as an activity timestamp for start/end/lunch).
function myTransitions(issue, histories, meAccountId) {
  const out = [];
  for (const h of histories) {
    if (h.author?.accountId !== meAccountId) continue;
    if ((h.items || []).some((it) => it.field === 'status')) out.push({ ts: Date.parse(h.created), source: 'jira', kind: 'transition', key: issue.key });
  }
  return out;
}

function makeClient(jcfg) {
  const auth = 'Basic ' + Buffer.from(`${jcfg.email}:${jcfg.token}`).toString('base64');
  async function api(path, opts = {}) {
    const res = await fetch(jcfg.baseUrl + path, {
      ...opts,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`Jira ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  async function search(jql, fields = ['summary', 'priority', 'created', 'issuetype']) {
    const issues = []; let nextPageToken;
    do {
      const r = await api('/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify({ jql, fields, maxResults: 100, nextPageToken }) });
      issues.push(...(r.issues || [])); nextPageToken = r.nextPageToken;
    } while (nextPageToken);
    return issues;
  }
  async function paged(path, listKey) {
    const out = []; let startAt = 0;
    for (;;) {
      const r = await api(`${path}${path.includes('?') ? '&' : '?'}startAt=${startAt}&maxResults=100`);
      const arr = r[listKey] || []; out.push(...arr); startAt += arr.length;
      if (!arr.length || startAt >= (r.total ?? 0)) break;
    }
    return out;
  }
  return { api, search, paged };
}

// Fetch everything for [from, to] (YYYY-MM-DD, inclusive, in cfg.tz).
async function fetchJira(from, to, cfg) {
  const j = makeClient(cfg.jira);
  const me = (await j.api('/rest/api/3/myself')).accountId;
  const proj = cfg.jira.projects.length ? ` AND project in (${cfg.jira.projects.map((p) => `"${p}"`).join(',')})` : '';
  const q = (s) => `"${s}"`;
  const toNext = addDays(to, 1);
  const inRange = (ts) => { const d = parts(ts, cfg.tz).date; return d >= from && d <= to; };

  const events = [], comments = [], tested = [], bugs = [];
  const issuesSeen = new Map();

  // 1) tickets tested — discovery (JQL), then strict verification from the changelog
  const testedJql = `status CHANGED FROM (${cfg.qa.from.map(q)}) TO (${cfg.qa.to.map(q)}) BY currentUser() DURING (${q(from)}, ${q(toNext)})${proj}`;
  const qaIssues = await j.search(testedJql, ['summary']);
  // 2) comments — discovery
  // `commenter = currentUser()` can return nothing on some sites/permission setups (seen on a real site during validation),
  // so also scan recently-updated issues in the configured projects and filter comments by author ourselves.
  const byKey = new Map();
  for (const jql of [
    `commenter = currentUser() AND updated >= ${q(from)}${proj}`,
    ...(cfg.jira.projects.length ? [`project in (${cfg.jira.projects.map(q)}) AND updated >= ${q(from)} ORDER BY updated DESC`] : []),
  ]) for (const i of await j.search(jql, ['summary'])) byKey.set(i.key, i);
  const cIssues = [...byKey.values()].slice(0, cfg.jira.maxCommentScan || 400);
  for (const i of [...qaIssues, ...cIssues]) issuesSeen.set(i.key, { key: i.key, summary: i.fields?.summary });

  for (const issue of qaIssues) {
    const hist = await j.paged(`/rest/api/3/issue/${issue.key}/changelog`, 'values');
    const info = issuesSeen.get(issue.key);
    for (const t of extractTested(info, hist, me, cfg)) if (t.date >= from && t.date <= to) tested.push(t);
    for (const ev of myTransitions(info, hist, me)) if (inRange(ev.ts)) events.push(ev);
  }
  for (const issue of cIssues) {
    const info = issuesSeen.get(issue.key);
    const list = await j.paged(`/rest/api/3/issue/${issue.key}/comment`, 'comments');
    for (const c of list) {
      const ts = Date.parse(c.created);
      if (c.author?.accountId !== me || !inRange(ts)) continue;
      comments.push({ key: issue.key, ts, summary: info.summary }); // body is never stored
      events.push({ ts, source: 'jira', kind: 'comment', key: issue.key });
    }
  }
  // 3) bugs reported
  const bugIssues = await j.search(`reporter = currentUser() AND issuetype = ${q(cfg.jira.bugType)} AND created >= ${q(from)} AND created < ${q(toNext)}${proj}`);
  for (const b of bugIssues) {
    const ts = Date.parse(b.fields.created);
    if (!inRange(ts)) continue;
    bugs.push({ key: b.key, ts, title: b.fields.summary, priority: b.fields.priority?.name || '—' });
    events.push({ ts, source: 'jira', kind: 'bug', key: b.key });
  }
  return { events, comments, tested, bugs, me };
}

module.exports = { extractTested, myTransitions, fetchJira, makeClient };
