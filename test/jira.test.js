const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('../lib/config');
const { extractTested, myTransitions } = require('../lib/jira');

const cfg = { ...defaults, tz: 'America/Mexico_City' };
const ME = 'me-123', OTHER = 'someone-else';
const issue = { key: 'PROJ-101', summary: 'Login bug' };
const h = (author, from, to, created, field = 'status') => ({ author: { accountId: author }, created, items: [{ field, fromString: from, toString: to }] });

test('In QA → Ready for UAT / Done / Won\'t Do by me are counted, with the outcome', () => {
  for (const to of ['Ready for UAT', 'Done', "Won't Do"]) {
    const r = extractTested(issue, [h(ME, 'In QA', to, '2026-11-03T16:00:00.000-0600')], ME, cfg);
    assert.equal(r.length, 1); assert.equal(r[0].outcome, to); assert.equal(r[0].date, '2026-11-03');
  }
});

test('transitions made by someone else are ignored', () => {
  assert.equal(extractTested(issue, [h(OTHER, 'In QA', 'Done', '2026-11-03T16:00:00.000-0600')], ME, cfg).length, 0);
});

test('In QA → other statuses (Reopened, In Progress, Failed QA) are ignored', () => {
  for (const to of ['Reopened', 'In Progress', 'Failed QA', 'Blocked']) {
    assert.equal(extractTested(issue, [h(ME, 'In QA', to, '2026-11-03T16:00:00.000-0600')], ME, cfg).length, 0, to);
  }
});

test('moving INTO In QA, or from another status to Done, is not "tested"', () => {
  assert.equal(extractTested(issue, [h(ME, 'In Progress', 'In QA', '2026-11-03T10:00:00.000-0600')], ME, cfg).length, 0);
  assert.equal(extractTested(issue, [h(ME, 'In Review', 'Done', '2026-11-03T10:00:00.000-0600')], ME, cfg).length, 0);
});

test('non-status field changes and comments are ignored', () => {
  assert.equal(extractTested(issue, [h(ME, 'In QA', 'Done', '2026-11-03T10:00:00.000-0600', 'resolution')], ME, cfg).length, 0);
});

test('same ticket moved out of QA on two different days counts once per day', () => {
  const hist = [
    h(ME, 'In QA', 'Ready for UAT', '2026-11-02T11:00:00.000-0600'),
    h(ME, 'Ready for UAT', 'In QA', '2026-11-02T15:00:00.000-0600'),   // bounced back (not counted)
    h(ME, 'In QA', 'Done', '2026-11-03T12:00:00.000-0600'),
  ];
  const r = extractTested(issue, hist, ME, cfg);
  assert.deepEqual(r.map((x) => [x.date, x.outcome]).sort(), [['2026-11-02', 'Ready for UAT'], ['2026-11-03', 'Done']]);
});

test('multiple out-of-QA transitions on the same day are deduped (latest wins)', () => {
  const hist = [
    h(ME, 'In QA', 'Ready for UAT', '2026-11-03T09:00:00.000-0600'),
    h(ME, 'In QA', 'Done', '2026-11-03T17:00:00.000-0600'),
  ];
  const r = extractTested(issue, hist, ME, cfg);
  assert.equal(r.length, 1); assert.equal(r[0].outcome, 'Done');
});

test('status matching is case-insensitive and keeps the canonical outcome label', () => {
  const r = extractTested(issue, [h(ME, 'in qa', 'READY FOR UAT', '2026-11-03T09:00:00.000-0600')], ME, cfg);
  assert.equal(r.length, 1); assert.equal(r[0].outcome, 'Ready for UAT');
});

test('day is decided in the configured time zone, not UTC', () => {
  // 05:30Z = 23:30 on Nov 2 in Mexico City (UTC-6)
  const r = extractTested(issue, [h(ME, 'In QA', 'Done', '2026-11-03T05:30:00.000Z')], ME, cfg);
  assert.equal(r[0].date, '2026-11-02');
});

test('custom status names via config', () => {
  const c = { ...cfg, qa: { from: ['QA'], to: ['Verified'] } };
  assert.equal(extractTested(issue, [h(ME, 'QA', 'Verified', '2026-11-03T09:00:00.000-0600')], ME, c).length, 1);
  assert.equal(extractTested(issue, [h(ME, 'In QA', 'Done', '2026-11-03T09:00:00.000-0600')], ME, c).length, 0);
});

test('myTransitions only returns my status changes (used as activity timestamps)', () => {
  const r = myTransitions(issue, [h(ME, 'To Do', 'In Progress', '2026-11-03T09:00:00.000-0600'), h(OTHER, 'In QA', 'Done', '2026-11-03T10:00:00.000-0600')], ME);
  assert.equal(r.length, 1);
});
