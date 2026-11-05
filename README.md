# Daily Time Report

Computes your daily start/end, lunch and net hours from **Slack + Jira** activity, plus QA output (comments, tickets tested, bugs reported), and serves a clean, shareable page. Zero dependencies — Node 20+ only.

## Quick start (sample data)

```bash
node server.js            # or: MOCK=1 node server.js
# → http://127.0.0.1:3000   (owner view)
# → the console also prints a read-only /share/<token> link
npm test                  # 26 unit tests
npm run export:example    # self-contained snapshot → examples/oct-nov-2026.html
```

With no Slack/Jira credentials it runs on deterministic **sample data**. Nothing in the sample is real activity.

## Go live

1. `cp .env.example .env`, set `MOCK=0` and fill the values.
2. **Slack** — create an app, add *user* token scopes `search:read users:read users.profile:read channels:history groups:history im:history mpim:history`, install it, and put the `xoxp-` token in `SLACK_USER_TOKEN`.
   - **Status / presence history:** Slack only exposes the *current* value, so the app logs changes from the day it starts. Either let the built-in poller run (default, every 2 min) or subscribe the Events API (`user_change`, `presence_change`) to `POST /slack/events` and set `SLACK_SIGNING_SECRET` + `SLACK_EVENTS_ONLY=1`. Days before logging started fall back to message timestamps.
3. **Jira Cloud** — create an API token, set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, optionally `JIRA_PROJECTS=PROJ`.
4. `node server.js`. Deploy anywhere that runs Node (Fly, Render, a small VM). Set `HOST=0.0.0.0` only behind auth: **owner routes (edit, sync, settings) are unauthenticated**; only `/share/<token>` is meant for other people.

## How numbers are computed

| Value | Rule |
|---|---|
| Start / End | Slack presence `active`/`away` when logged; otherwise first/last Slack message **or** Jira comment/transition/bug in the day (05:00–23:00 window; anything outside is flagged `outlier`, not dropped silently). |
| Lunch | Lunch status (emoji or text like *lunch / almuerzo / comiendo*) → else the longest message gap of 30–120 min centred 12:00–15:00 inside 11:00–16:00 → else 30 min **assumed** (only if the day is ≥ 5 h). |
| Status vocabulary | Slack status text drives the day: **"Working…"** (regex `workRegex`) starts it, **"at lunch"** (`lunchRegex`/emoji) is lunch, **"AFK"** (`afkRegex`) is a short pause (any number), and a cleared/other status after working ends it. Status beats presence, presence beats messages. |
| Other pauses | Pauses come from statuses. Quiet message gaps are ignored by default (`pauseMin: 0`) because chat is sparse; a gap > 120 min is never treated as lunch. |
| Net hours | (End − Start) − all pauses. |
| Tickets tested | Tickets **you** moved from `In QA` → `Ready for UAT` / `Done` / `Won't Do` (verified from the issue changelog by your account ID, deduped per ticket per day, day decided in your time zone). Status names are configurable in Settings or `.env`. |
| Bugs reported | `reporter = currentUser() AND issuetype = Bug`, by created date. |
| Jira comments | Comments authored by you, by created date. |

Every value shows its source badge (`status`, `slack`, `jira`, `jira+slack`, `assumed`, `manual`). Manual overrides per day (expand a row) win over everything and show an `edited` badge.

## Privacy

Only timestamps, ticket keys, titles, counts and statuses are kept. Slack message text and Jira comment bodies are never read into storage. The share link shows the report only.

## Layout

```
server.js            HTTP server + API
lib/engine.js        start/end/lunch detection (pure)
lib/jira.js          Jira connector + tested-ticket extraction (pure parts unit-tested)
lib/slack.js         Slack messages, status logger, Events API receiver
lib/mock.js          sample data generator
lib/report.js        merges sources → rows
public/              UI (vanilla JS, SVG charts, light/dark)
scripts/export-static.js   offline HTML snapshot
test/                node:test suites
```

## Known limits

- Storage is a JSON file (`data/store.json`) rather than SQLite, to stay dependency-free.
- **Jira:** the "tickets tested" logic was checked against a real Jira Cloud changelog (status items use `fromString`/`toString`, authors are matched by `accountId`, timestamps carry the user's offset). The app's own authenticated REST calls have not been run yet.
- **Slack:** not yet validated against a real workspace. Run a short range first and compare with a day you know.
- `commenter = currentUser()` returned no results on one real site, so comment discovery also scans recently updated issues in `JIRA_PROJECTS` and filters comments by author.
- Set `TZ_NAME` to the time zone your Jira/Slack activity should be bucketed in (an IANA name such as `America/Denver`). Wrong zone = activity near midnight lands on the wrong day, and hours shift by the offset.
- Statuses like `Failed QA/UAT` or `Ready for Release` are **not** counted as "tested" unless you add them to `QA_TO_STATUSES`.
- Slack `search.messages` indexes messages, not reactions or edits; thread replies are included.

## Files mode (real data without Slack/Jira tokens)

Set `DATA_SOURCE=files` in `.env`. The server then reads `data/slack-real.json` and `data/jira-real.json` (git-ignored, timestamps/ticket data only) and `data/overrides.json` (optional manual corrections) instead of calling the Slack/Jira APIs. The **Update** button re-reads those files; to get *new* numbers, refresh the extracts (e.g. ask Claude, which pulls them through its Slack/Jira connectors). An ongoing day runs only up to the moment the data was extracted. Slack status history (Working / lunch / AFK) is not available in this mode.
