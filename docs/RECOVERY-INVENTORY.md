# TierStats recovery inventory — November 9, 2026

Source archives (in `~/Downloads`):

1. `TierStats_recovered_Nov9_merged_Chrome_Edge.zip` — **PRIMARY**, build
   `20261109114500`, recovered from the live site's browser/service-worker
   cache (Chrome + Edge merged). This is the newest version of every file.
2. `tierstats.github.io-main.zip` — **older reference**, build `20261010004734`.
   Used only for files absent from the November recovery (deployment/workflow
   structure). Never replaced a newer recovered file.

A third file, `TierStats_recovered_Nov9_build.zip`, is the same November build
without the Edge flag additions and the `art/flags/{in,nl,ru}.svg` files.

## Version confirmation

| File | November recovery (primary) | Older snapshot | Newest |
|---|---|---|---|
| `index.html` | 93,865 B, `?v=20261109114500`, 1,322 lines, 12 page sections | 35,862 B, `?v=20261010004734`, 527 lines | **November** |
| `app.js` | 220,573 B, 839 lines, routes incl. cards/find/tournaments | 84,417 B, 605 lines | **November** |
| `styles.css` | 385,898 B | 65,846 B | **November** |
| `data.js` | 235,194 B, `generated:"2026-11-09"` | 87,743 B | **November** |
| `i18n.js` | 509,320 B | 167,791 B | **November** |
| `sw.js` | present (cache-key fix) | absent | **November** |
| `cards.js/css`, `rankmove.js/css`, `tanks.js`, `tankrender.js`, `tourneys.js`, `manifest.webmanifest`, `404.html`, `art/`, `tankart/` | present | absent | **November** |
| `.github/workflows/site.yml`, `README.md` | absent (not in cache) | present | **older reference** |
| `.nojekyll`, `log.js` | identical in both | identical | either |

`sw.js` detail (retained byte-identical): `w(url) = origin+pathname`
(query-stripped, used for navigations and `data.js`/`log.js`) vs
`A(url) = origin+pathname+search` (query-retained, used for the versioned
asset cache). Versioned assets such as `styles.css?v=20261109114500` therefore
get a fresh cache key on every release and can never be served from an older
build's cache.

## Recovered (authoritative November files, kept as-is)

`index.html`, `404.html` (identical copy, SPA fallback), `app.js`,
`styles.css`, `cards.js`, `cards.css`, `rankmove.js`, `rankmove.css`,
`i18n.js`, `tanks.js`, `tankrender.js`, `tourneys.js`, `data.js` (authoritative
snapshot: generated 2026-11-09, 48 qualified / 116 total players / 504
matches / 144 tank profiles), `log.js`, `manifest.webmanifest`, `sw.js`
(byte-identical, cache-key fix retained), `.nojekyll`, `art/` (favicon,
brand-tank, paint cans, icons, flags `gb/in/nl/ru`), `tankart/manifest.json`
(830 entries) + 108 cached AVIF files.

## Reconstructed (not in the November cache, rebuilt from SPA structure)

- `.github/workflows/site.yml` — copied unchanged from the older snapshot
  (manual-only Pages fallback; must NOT regenerate `data.js`).
- `README.md` — rewritten for the reconstructed repo (no secrets).
- Route folders, each holding an exact copy of the root `index.html` SPA
  shell (same approach as the recovered `404.html`): `analytics/`, `cards/`,
  `compare/`, `faq/`, `find/`, `matches/`, `method/`, `player/`, `roster/`,
  `rules/`, `tournaments/`, `share/`. Player/card/tournament sub-paths
  (`/player/<name>` etc.) resolve through `404.html`.
- `apps-script/Code.gs` + `apps-script/SETUP.md` — retargeted Sheet→GitHub
  sync template (no hard-coded credentials; see setup doc).
- `docs/` — this inventory, `RECOVERY_REPORT_NOV9.txt` (moved from the
  recovery package), `MISSING_CURRENT_TANK_ASSETS.txt`,
  `MISSING_FULL_TANKART_LIBRARY.txt`, `ASSET-GAPS.md`.

## Still missing (documented, graceful fallbacks — nothing fabricated)

1. **Tank art: 722 of 830 files.** Only 108 AVIFs were in the cache.
   73 files referenced by the 144 current tank profiles are listed in
   `docs/MISSING_CURRENT_TANK_ASSETS.txt`; the full gap list is
   `docs/MISSING_FULL_TANKART_LIBRARY.txt`. Renderer falls back to flat
   `#888888` + skipped accessory (see `docs/ASSET-GAPS.md`). To recover more,
   export the cache from another browser/profile/computer that visited the
   live site — do not invent artwork.
2. **Country flags beyond 4.** Recovered: `gb`, `in`, `nl`, `ru` (Edge added
   the last three). `tourneys.js` requests further ISO flags dynamically;
   missing ones fall back to the country-code text.
3. **Original static SEO route copies** (`analytics/`, `cards/`, … pre-rendered
   files and `share/` images): not in the cache; reconstructed as SPA shells.
   The live OG default (`share/_default.png`) and per-player share images were
   not recovered either.
4. **Backend code & secrets**: the `tierstats-publish` Worker source, the
   original Apps Script project, the GitHub token and the admin password were
   intentionally never in the recovery package. The Worker must be re-pointed
   at `Alternator1/alternator1.github.io`; see `apps-script/SETUP.md`.

## Local test checklist (manual — run before any publish)

Serve the repo root statically and verify each item; record results.

- [ ] `/` homepage renders (hero, top-10, latest battles), no console errors
- [ ] Rankings: full leaderboard, search, filters; provisional badges
- [ ] Player profile `#/player/<name>` (+ `/player/<name>` direct): header,
      rating-history graph, rank movement, head-to-head, tank render
- [ ] Player cards `#/cards` + `#/card/<name>` (+ `/cards/` direct)
- [ ] Compare `#/compare` (+ `/compare/`), shareable compare URLs
- [ ] Matches `#/matches` (+ `/matches/`): archive loads, filters
- [ ] Provisional `#/roster` (+ `/roster/`), Analytics `#/analytics`
- [ ] Find 1v1 `#/find` (+ `/find/`): board, verification flow
- [ ] Method `#/method`, Rules `#/rules`, FAQ `#/faq` content present
- [ ] i18n: switch language (en plus zh/ja/ru strings), no missing-key crashes
- [ ] Tank rendering: complete tanks render fully; missing-part tanks render
      flat grey `#888888` without exceptions (see ASSET-GAPS)
- [ ] Mobile layout: 360–390 px viewport, nav collapses, no overlap
- [ ] Direct routes: visit `/analytics/`, `/player/Slayer`, `/cards/` cold
      (no prior cache) — each serves the SPA shell
- [ ] Service worker: first load registers `/sw.js?sv=20261109114500`;
      versioned `?v=` assets cache under full query URL; `data.js?t=…` always
      revalidates over the network; offline revisit still renders shell
