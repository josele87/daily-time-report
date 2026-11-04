// Deterministic SAMPLE data so the UI can be previewed before connecting Slack/Jira.
// Nothing here is real activity. Same seed => same output.
const { localToUtc, dayRange, isWeekend } = require('./tz');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

const TITLES = [
  'Login: biometric prompt not shown after OS update', 'Checkout: promo code field accepts trailing spaces',
  'Order history: pagination skips page 2', 'Push notifications: duplicate alert after reinstall',
  'Profile: avatar upload fails on iOS 17', 'Search: filters reset on back navigation',
  'Cart: quantity stepper off by one', 'Settings: dark mode toggle not persisted',
  'Payments: wallet sheet crashes on cancel', 'Home: carousel flicker on Android 13',
  'Onboarding: skip button overlaps text (ES locale)', 'Wishlist: items missing after login',
  'Deep links: campaign param dropped', 'Address book: postal code validation too strict',
  'Receipts: PDF download blank on Safari', 'Rewards: points balance stale after purchase',
  'Product page: zoom gesture conflicts with swipe', 'Notifications: badge count not cleared',
];
const PRIORITIES = ['Low', 'Medium', 'Medium', 'High', 'Highest'];

const SPECIAL = {
  '2026-10-09': { longPause: [900, 990] },   // 15:00-16:30 no activity (meeting block / errand)
  '2026-10-14': { jiraOnlyMorning: true },   // Slack silent until late morning -> Jira sets the start
  '2026-10-20': { lateNight: 1420, lunchStatusOnly: true }, // 23:40 outlier + lunch status
  '2026-10-27': { halfDay: true },           // leaves ~13:10, no lunch gap
  '2026-11-02': { off: true },               // day off
  '2026-11-04': { today: true },             // partial day, still online
};
const STATUS_LOG_STARTS = '2026-10-26';      // pretend the status logger was switched on this day

function generate(from, to, cfg) {
  const tz = cfg.tz;
  const out = { events: [], statusEvents: [], comments: [], tested: [], bugs: [], mock: true };
  let keyCounter = 140;

  for (const date of dayRange(from, to)) {
    if (isWeekend(date)) continue;
    const sp = SPECIAL[date] || {};
    if (sp.off) continue;
    const rnd = mulberry32(hash(date));
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const at = (min) => localToUtc(date, Math.floor(min / 60), min % 60, tz);

    const startMin = 525 + ri(0, 65);
    let endMin = 1050 + ri(0, 80);
    if (sp.halfDay) endMin = 790;
    if (sp.today) endMin = 860;
    const lunchS = 770 + ri(-20, 45), lunchE = lunchS + 35 + ri(0, 35);
    const hasLunch = !sp.halfDay;
    const blocked = (m) => (hasLunch && m > lunchS && m < lunchE) || (sp.longPause && m > sp.longPause[0] && m < sp.longPause[1]);
    const rt = (jiraOnlySource) => { // random work minute outside pauses
      for (let i = 0; i < 50; i++) {
        const m = ri(startMin, endMin);
        if (!blocked(m) && !(sp.jiraOnlyMorning && !jiraOnlySource && m < 690)) return m;
      }
      return startMin;
    };

    const ev = (min, source, kind) => out.events.push({ ts: at(min), source, kind });

    // anchors so start/end are well defined
    ev(startMin, sp.jiraOnlyMorning || rnd() < 0.35 ? 'jira' : 'slack', 'anchor');
    ev(endMin, rnd() < 0.4 ? 'jira' : 'slack', 'anchor');
    if (sp.lateNight) ev(sp.lateNight, 'slack', 'message');

    // dense enough that only real breaks show up as gaps (~1 message / 8-12 min)
    for (let i = 0, n = Math.round((endMin - startMin) / ri(8, 12)); i < n; i++) ev(rt(false), 'slack', 'message');

    for (let i = 0, n = ri(4, 13); i < n; i++) {
      const m = rt(true), key = `PROJ-${ri(140, 520)}`;
      out.comments.push({ key, ts: at(m), summary: TITLES[ri(0, TITLES.length - 1)] });
      ev(m, 'jira', 'comment');
    }
    const nt = sp.halfDay ? 3 : sp.today ? 4 : ri(2, 8);
    for (let i = 0; i < nt; i++) {
      const m = rt(true), r = rnd();
      const outcome = r < 0.55 ? 'Ready for UAT' : r < 0.85 ? 'Done' : "Won't Do";
      out.tested.push({ key: `PROJ-${keyCounter++}`, title: TITLES[ri(0, TITLES.length - 1)], ts: at(m), date, outcome });
      ev(m, 'jira', 'transition');
    }
    const br = rnd(), nb = sp.halfDay ? 0 : br < 0.4 ? 0 : br < 0.72 ? 1 : br < 0.92 ? 2 : 3;
    for (let i = 0; i < nb; i++) {
      const m = rt(true);
      out.bugs.push({ key: `PROJ-${keyCounter++}`, ts: at(m), title: TITLES[ri(0, TITLES.length - 1)], priority: PRIORITIES[ri(0, PRIORITIES.length - 1)] });
      ev(m, 'jira', 'bug');
    }

    // status log (only once the logger exists, plus one lunch-status-only demo day)
    if (date >= STATUS_LOG_STARTS) {
      out.statusEvents.push({ ts: at(startMin - ri(1, 6)), type: 'presence', value: 'active' });
      if (hasLunch) {
        out.statusEvents.push({ ts: at(lunchS), type: 'status', emoji: ':knife_fork_plate:', text: 'Lunch' });
        out.statusEvents.push({ ts: at(lunchE), type: 'status', emoji: '', text: '' });
      }
      if (!sp.today) out.statusEvents.push({ ts: at(endMin + ri(2, 9)), type: 'presence', value: 'away' });
    } else if (sp.lunchStatusOnly) {
      out.statusEvents.push({ ts: at(lunchS), type: 'status', emoji: ':taco:', text: 'almuerzo' });
      out.statusEvents.push({ ts: at(lunchE), type: 'status', emoji: '', text: '' });
    }
  }
  return out;
}

module.exports = { generate };
