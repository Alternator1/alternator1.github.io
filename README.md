# 1v1 Leaderboard — TierStats

The definitive Tank Trouble 1v1 rankings — Dynamic Glicko-2 ratings, full match
archive, head-to-head dossiers, provisional roster and analytics.

**Live site:** https://tierstats.github.io/ (served from `Alternator1/tierstats.github.io`)

- Owned & run by **Alternator** & **interstellar**
- Every rating is computed from the recorded match history — no manual rankings
- Visible rating = Glicko − 0.35 × RD (uncertain ratings are held back)

This repository is the **November 9, 2026 reconstruction** (`?v=20261109114500`)
recovered from the live site's browser/service-worker cache after the original
Git history was reset. App logic, layout, styling and Glicko/ranking logic are
preserved exactly as recovered; only deployment/workflow structure was
re-added from the older snapshot. See [docs/RECOVERY-INVENTORY.md](docs/RECOVERY-INVENTORY.md).

## Pages (hash routes, deep-linkable)

- **Rankings** — `#/` front line top 10, full leaderboard, latest battles
- **Cards** — `#/cards`, single card `#/card/<name>`
- **Compare** — `#/compare` (shareable `#/compare/<a>-vs-<b>`)
- **Matches** — `#/matches` the complete duel archive
- **Roster** — `#/roster` provisional players climbing toward qualification
- **Analytics** — `#/analytics` win rates, activity, biggest upsets, rivalries
- **Find 1v1** — `#/find` availability board + verification
- **Tournaments** — `#/tournaments`
- **Method** — `#/method` how the rating system works
- **Rules** — `#/rules`, **FAQ** — `#/faq`
- **Player** — `#/player/<name>` profiles, rating-history graphs, rank movement
- **Admin** — `#/admin` owners-only match log (password protected)

Direct path URLs (`/analytics/`, `/cards/`, `/player/…`, …) work via the
reconstructed route folders plus the `404.html` SPA fallback. See
[docs/RECOVERY-INVENTORY.md](docs/RECOVERY-INVENTORY.md).

## How published matches work

`log.js` is the shared match log. The admin console commits to it via the
`tierstats-publish` Worker ("Publish to everyone"); every visitor's browser
loads it fresh and recalculates all Glicko-2 ratings at page load.

`data.js` is the sheet-generated snapshot (authoritative data: generated
2026-11-09, 48 qualified / 116 total players / 504 matches / 144 tank
profiles). It is rewritten by the sheet sync **outside** of site deploys and
is loaded with a per-request cache-buster (`data.js?t=…`), so release stamps
never touch it.

Live sync chain (single writer — the Worker owns all `data.js` commits):

1. Owners edit the master Google Sheet (recalculation is automatic in-sheet).
2. The sheet's Apps Script calls the Worker `POST /sync` instantly
   ("Update website" menu, plus an on-change trigger), **and** a 5-minute
   Cloudflare cron on the Worker catches anything else.
3. The Worker regenerates `data.js` (and any generated site data) and commits
   to `Alternator1/tierstats.github.io`.
4. GitHub Pages redeploys the static site.

Setup: [apps-script/SETUP.md](apps-script/SETUP.md) · template: [apps-script/Code.gs](apps-script/Code.gs).
Tokens live only in Apps Script **Script Properties** and Worker env — never
in this repo.

## Deployment

- GitHub Pages, classic branch builds (`build_type: legacy`) from `main` `/`
  (root). `.nojekyll` is required (underscore paths).
- `.github/workflows/site.yml` is a **manual-only fallback** (`workflow_dispatch`)
  that uploads the directory as-is. It must NOT regenerate `data.js` — the
  sync is owned by the Worker, or two writers fight over the file forever
  (Python writes `1550.0`, JS writes `1550` → endless "changed" commits).
- `404.html` is an exact copy of `index.html` (SPA fallback for deep links).
- `sw.js` is kept byte-identical to the November recovery: versioned assets
  (`?v=…`) are cached under their **full URL including query** while
  navigations and `data.js`/`log.js` are cached query-stripped, so a new
  `?v=` stamp can never be served a stale older build.

## Local testing

Any static server from the repo root, e.g.:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/
```

Deep links (`/player/Slayer`, `/analytics/`, …) are covered by the route
folders and `404.html`. See [docs/RECOVERY-INVENTORY.md](docs/RECOVERY-INVENTORY.md)
for the manual test checklist.

## Known gaps (graceful fallbacks, documented)

- 722 of 830 tank-art files were never in the recovered cache (73 assets
  referenced by current profiles). Missing parts render as flat `#888888`
  with the accessory skipped — never a broken tank. See
  [docs/ASSET-GAPS.md](docs/ASSET-GAPS.md).
- Only 4 country flags (`gb`, `in`, `nl`, `ru`) were recovered; other
  tournament flags fall back to the country code text.
- Original static SEO route copies were not in the cache; route folders are
  reconstructed SPA shells (see inventory doc).

## Secrets

No tokens, PATs, Worker secrets or service credentials are stored in this
repository. GitHub/Worker/Sheet credentials are configured separately per
[apps-script/SETUP.md](apps-script/SETUP.md).
