# Replacement Worker: tierstats-publish (rebuild, 2026-11-09)

The old `tierstats-publish` Worker is gone (every route 404s, source was
never in any repo, and it is not in our Cloudflare account). This is a
clean-room replacement that implements exactly the contract the Sheet
script (`Kode.gs`) and the site (`app.js` footer/admin) expect.

## What it does (and does NOT do)

- `POST /sync {password}` and the 5-minute cron read the owned Sheet's
  public gviz export, rebuild `data.js`, and commit it to
  `Stats4Tanks/stats4tanks.github.io` (main) when it changed.
- `GET /sync-status` reports `{matches, players, ageMinutes, stale,
  lastError, generated}` from the repo state (no KV/storage needed).
- The Sheet stays the calculation authority: the Worker transfers the
  computed tabs (Leaderboard, All Players, …) and raw tabs
  (Matches, Aliases, Seeds, Settings, Inactive) into `data.js`. It does
  NOT re-run the Glicko engine, so ratings are byte-identical to the Sheet.
- Scope is the publish pipeline only. The old Worker's interactive
  backends (tournaments/challenges, player profiles/pings, tt-admission,
  availability, publish/verify admin) are NOT rebuilt here — those site
  features stay offline until a later backend phase.

## data.js mapping (verified against the 2026-11-09 snapshot)

- `matches[]`: `{a,b,sa,sb,date[,sv][,svc]}` from Matches A:E; names
  canonicalized through Aliases (e.g. Infuriater -> interstellar).
- `sv`: valid server names from G (Server 1) + J (Server 2), allow-listed
  against London/Newark/Dallas/Atlanta/Fremont/Singapore/Sydney
  (label junk like "Server 1" in the columns is rejected).
- `svc`: `[[S1P1,S1P2],[S2P1,S2P2]]` only when two distinct servers play.
- `settings[]`: `{name,value,desc}` from Settings A:B:C; Excel date
  serials become ISO for `*date*` keys (46299 -> "2026-10-04").
- `qualified[]` (no lastMatch) from Leaderboard; `players[]` (no rank)
  from All Players; `provisional:true` from Provisional-tab membership
  (+ thresholds fallback); `inactive` for Inactive-tab members / past
  threshold only.
- `histories{}` rebuilt per player from matches (res W/L/D, sv carried).
- `prevRatings/prevRanks` = previous publish's curRatings/qualified
  order; `curRatings` = new ratings; `newSince` carried over.
- Everything else (`cards`, …) carried over byte-identical.

## Setup (dashboard path, no Node needed)

1. GitHub: fine-grained PAT (resource owner with access to the repo,
   Only select repositories -> `stats4tanks.github.io`,
   Contents: Read and write (data.js sync) AND Pages: Read and write
   (lets the Worker request a Pages rebuild when the latest deployment
   errored; without Pages write, recovery reports "forbidden" and stays
   dormant). Keep it private.
2. Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker ->
   name `tierstats-publish` -> Deploy -> Edit code -> paste
   `worker/src/index.js` -> Save and deploy.
3. Worker Settings -> Variables: text `SHEET_ID` (the owned copy's id),
   `GITHUB_REPO`, `GITHUB_BRANCH`; secrets `GITHUB_TOKEN`, `WORKER_SECRET`
   (invent a strong password; it must later match the Sheet property).
4. Triggers -> Custom Cron Triggers -> Add: `*/5 * * * *`.
5. Sheet: share as "Anyone with the link: Viewer" (data is already
   public via the site); set Script Properties `WORKER_SYNC_URL` +
   `SYNC_STATUS_URL` to the NEW worker URL
   (`https://tierstats-publish.<your-subdomain>.workers.dev/...`) and
   `WORKER_SECRET` to the password from step 3.
6. Test: `GET /` (expect "tierstats sync worker ok"), then Sheet menu
   TierStats -> Check sync status, then Update website now.
