# TierStats Sheet → GitHub sync — setup (new repo)

Retargets the live sync to **`Alternator1/alternator1.github.io`** without
hard-coding any credential. The Google Sheet stays the authoritative data
source with automatic recalculation; this script only triggers the website
update.

## Architecture (unchanged workflow)

1. Sheet formulas recalculate automatically on every edit (ratings,
   leaderboard, provisional — no script needed for that).
2. This script pokes the `tierstats-publish` Worker (`POST /sync`) instantly
   via the **TierStats → Update website now** menu and an on-change trigger.
3. The Worker's 5-minute Cloudflare cron re-syncs as a backstop.
4. The **Worker alone** regenerates `data.js` (+ generated site data) and
   commits to GitHub → Pages redeploys. Keep this single-writer rule: the
   repo workflow must NOT regenerate `data.js` either.

## 1. Create a GitHub token (you own it)

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token.
2. Resource owner: `Alternator1`; repository access: **Only select
   repositories** → `alternator1.github.io`; permissions → **Contents:
   Read and write**. No other scopes.
3. Copy the token once. You will paste it into Script Properties below —
   never into chat, email, or this repo.

## 2. Install the script in the Sheet

1. Open the master Google Sheet → Extensions → Apps Script.
2. Replace the project code with `apps-script/Code.gs` from this repo.
3. Rename the project `TierStats sync` if you like. Save.

## 3. Set Script Properties (secrets live here only)

Project Settings (gear) → Script Properties → add:

| Key | Value |
|---|---|
| `GITHUB_REPO` | `Alternator1/alternator1.github.io` |
| `GITHUB_BRANCH` | `main` |
| `GITHUB_TOKEN` | the PAT from step 1 |
| `WORKER_SYNC_URL` | `https://tierstats-publish.tierstats.workers.dev/sync` |
| `WORKER_SECRET` | same secret as the `#/admin` password |
| `SYNC_STATUS_URL` | `https://tierstats-publish.tierstats.workers.dev/sync-status` |

Run **TierStats → Setup check** in the Sheet to verify.

## 4. Install the automatic trigger

Apps Script → Triggers (clock) → Add trigger: function `onSheetChange`,
event source **From spreadsheet**, event type **On change**. This preserves
the instant website-update behaviour after every sheet edit (debounced to one
poke per 2 minutes; the Worker's 5-min cron covers the rest).

## 5. Re-point the Worker at the new repo

In the Cloudflare Worker (`tierstats-publish`) configuration, set the repo to
`Alternator1/alternator1.github.io` (env var / wrangler config + the GitHub
credentials it uses — a repo-scoped token or GitHub App installation on the
new repo). Verify with the site's admin console: **Sync from sheet now**,
then check `#/admin` sync-health (`/sync-status`: last publish age, match and
player counts).

## 6. Test end to end

1. Sheet: run **TierStats → Update website now** → expect success toast.
2. Sheet: run **TierStats → Check sync status** → last publish "just now".
3. Make a trivial sheet edit → within ~2 min the trigger pokes `/sync`;
   within ~5 min the cron would anyway.
4. Confirm the commit landed in `Alternator1/alternator1.github.io` (`data.js`
   `generated` date bumped) and the live site shows it after Pages redeploys
   (note: `data.js` loads with `?t=` per request, so no stale cache).

## Fallback: direct push (Worker down only)

`pushDataJsDirect()` commits `data.js` straight through the GitHub Contents
API using `GITHUB_TOKEN`. It is **disabled by default** (nothing calls it).
Use it only during a Worker outage, then switch back — two writers produce
endless phantom-diff commits (Python `1550.0` vs JS `1550`).

## Secret hygiene

- Secrets exist in exactly two places: Apps Script Script Properties and the
  Worker's env. Never in this repo, chat logs, screenshots or sheet cells.
- The PAT is repo-scoped (contents write, this repo only). Rotate it in both
  places at once if it ever leaks.
