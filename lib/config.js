const fs = require('fs');
const path = require('path');

(function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const env = process.env;
const list = (s, d) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : d);

const hasLive = !!(env.SLACK_USER_TOKEN || (env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN));

const defaults = {
  port: +env.PORT || 3000,
  tz: env.TZ_NAME || 'America/Mexico_City',
  mock: env.MOCK === '1' || (env.MOCK !== '0' && !hasLive),
  dataDir: path.join(__dirname, '..', 'data'),
  slack: { token: env.SLACK_USER_TOKEN || '', signingSecret: env.SLACK_SIGNING_SECRET || '', pollMs: +env.SLACK_POLL_MS || 120000 },
  jira: {
    baseUrl: (env.JIRA_BASE_URL || '').replace(/\/$/, ''),
    email: env.JIRA_EMAIL || '',
    token: env.JIRA_API_TOKEN || '',
    projects: list(env.JIRA_PROJECTS, []), // e.g. PROJ
    bugType: env.JIRA_BUG_TYPE || 'Bug',
  },
  // "Tickets tested" = tickets I personally move OUT of one of `from` INTO one of `to`.
  qa: {
    from: list(env.QA_FROM_STATUSES, ['In QA']),
    to: list(env.QA_TO_STATUSES, ['Ready for UAT', 'Done', "Won't Do"]),
  },
  engine: {
    windowStart: '05:00',
    windowEnd: '23:00',
    lunchWindow: ['11:00', '16:00'],
    minLunchMin: 30,        // smallest gap that counts as lunch
    defaultLunchMin: 30,    // applied (and marked "assumed") when no gap is found
    minDayForAssumedMin: 300,
    maxLunchMin: 120,       // a quiet gap longer than this is NOT treated as lunch (falls back to the assumed default)
    pauseMin: 0,            // >0: other quiet gaps this long are subtracted as pauses (off: chat is sparse, quiet != away)
    lunchEmojis: [':knife_fork_plate:', ':hamburger:', ':fork_and_knife:', ':taco:', ':pizza:', ':sandwich:', ':ramen:'],
    lunchRegex: 'lunch|almuerzo|comiendo|comida',
    afkRegex: '\\bafk\\b|stepped out|be right back|brb',
    workRegex: 'working',                  // e.g. ":work_in_progress: Working for Vail projects"
  },
  showWeekends: false,
};

// Settings editable from the UI are persisted in the store and merged over the defaults.
function withSettings(base, s = {}) {
  return {
    ...base,
    tz: s.tz || base.tz,
    qa: { from: s.qaFrom || base.qa.from, to: s.qaTo || base.qa.to },
    engine: {
      ...base.engine,
      defaultLunchMin: s.defaultLunchMin ?? base.engine.defaultLunchMin,
      minLunchMin: s.minLunchMin ?? base.engine.minLunchMin,
      pauseMin: s.pauseMin ?? base.engine.pauseMin,
    },
  };
}

module.exports = { defaults, withSettings };
