# Missing-asset fallback — tank art & flags

Nothing here is fabricated. Missing tank parts are **never** invented or
copied from other tanks; the renderer degrades gracefully and every gap is
listed in `docs/MISSING_CURRENT_TANK_ASSETS.txt` (73 files referenced by the
144 current profiles) and `docs/MISSING_FULL_TANKART_LIBRARY.txt` (all 721
missing of 830 manifest entries — 108 AVIFs recovered).

## Tank rendering fallback (`tankrender.js`, kept as recovered)

- `tankart/manifest.json` maps logical parts (e.g.
  `tankIcon/accessories/turret75.png@400`) to hashed files
  (`tankart/turret75-400-3b9d9ffc.avif`). Only the 108 recovered files exist
  on disk; the rest 404.
- Colour lookup `q()` resolves image colours via the manifest and falls back
  to flat **`#888888`** (`UNAVAILABLE_HEX`) when the asset is absent —
  `U(url)` resolves to `null` after retries and the layer is painted grey.
- Accessory lookup `V()` returns `Promise.resolve(null)` for missing/empty
  accessories, so the layer is skipped instead of throwing.
- Result: a tank with missing parts still renders — grey where art is absent —
  and `render()` never rejects because of a gap.

## Flag fallback (`tourneys.js`, `art/flags/`)

Recovered flags: `gb.svg`, `in.svg`, `nl.svg`, `ru.svg`. Tournament UI builds
`/art/flags/<cc>.svg` dynamically for other countries; a missing file shows
the country-code text (`alt`/label) instead of a broken image.

## How to close the gaps

Another browser, profile, computer or phone that visited TierStats may still
hold cached tank-art/flag files. Export them with the same cache-recovery
script used for this package and drop new `tankart/*.avif` /
`art/flags/*.svg` files next to the existing ones — no code changes needed.
Keep filenames exactly as the manifest references them.
