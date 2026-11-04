// Slack connector: message timestamps (search.messages) + a status/presence logger.
// Slack only exposes the CURRENT status/presence, so history exists only from the day the logger starts.
const crypto = require('crypto');

async function slackApi(token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

// Message timestamps only (text is never read into storage). from/to are YYYY-MM-DD (inclusive).
async function fetchSlackMessages(from, to, cfg, addDays) {
  const events = [];
  const query = `from:me after:${addDays(from, -1)} before:${addDays(to, 1)}`;
  for (let page = 1; page <= 50; page++) {
    const r = await slackApi(cfg.slack.token, 'search.messages', { query, count: 100, page, sort: 'timestamp', sort_dir: 'asc' });
    for (const m of r.messages.matches) events.push({ ts: Math.round(parseFloat(m.ts) * 1000), source: 'slack', kind: 'message' });
    if (page >= r.messages.paging.pages) break;
  }
  return events; // caller filters to local days
}

// Poll presence + status and append CHANGES to the store log.
function startStatusPoller(store, cfg) {
  let me, last = {};
  async function tick() {
    try {
      me = me || (await slackApi(cfg.slack.token, 'auth.test')).user_id;
      const [pr, pf] = await Promise.all([
        slackApi(cfg.slack.token, 'users.getPresence', { user: me }),
        slackApi(cfg.slack.token, 'users.profile.get', { user: me }),
      ]);
      const ts = Date.now();
      if (pr.presence !== last.presence) { store.logStatus({ ts, type: 'presence', value: pr.presence }); last.presence = pr.presence; }
      const sig = `${pf.profile.status_emoji}|${pf.profile.status_text}`;
      if (sig !== last.sig) { store.logStatus({ ts, type: 'status', emoji: pf.profile.status_emoji, text: pf.profile.status_text }); last.sig = sig; }
    } catch (e) { console.error('[slack poller]', e.message); }
  }
  tick();
  return setInterval(tick, cfg.slack.pollMs);
}

// Events API receiver (alternative to polling): subscribe to `user_change` + presence_change.
function verifySlackSignature(secret, req, raw) {
  const ts = req.headers['x-slack-request-timestamp'], sig = req.headers['x-slack-signature'];
  if (!ts || !sig || Math.abs(Date.now() / 1000 - +ts) > 300) return false;
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  return mine.length === sig.length && crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
}
function handleSlackEvent(body, store) {
  if (body.type === 'url_verification') return { challenge: body.challenge };
  const ev = body.event || {};
  const ts = Date.now();
  if (ev.type === 'user_change' && ev.user?.profile) {
    store.logStatus({ ts, type: 'status', emoji: ev.user.profile.status_emoji, text: ev.user.profile.status_text });
  } else if (ev.type === 'presence_change') {
    store.logStatus({ ts, type: 'presence', value: ev.presence });
  }
  return {};
}

module.exports = { fetchSlackMessages, startStatusPoller, verifySlackSignature, handleSlackEvent };
