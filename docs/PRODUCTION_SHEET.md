# Production Sheet (authoritative)

- Owned copy (production source of truth):
  https://docs.google.com/spreadsheets/d/1G7JuZwgdGl27fulGdpdkUz3PTYMC1LQodymjSvtmXL4/edit?gid=1189135813#gid=1189135813
- Spreadsheet ID: `1G7JuZwgdGl27fulGdpdkUz3PTYMC1LQodymjSvtmXL4`
- The old shared Sheet is LEGACY. Do not paste scripts or install triggers there.

## Verification against repo state (2026-11-09, xlsx export of the copy)

- Tabs present: Read Me, Aliases, Matches, Leaderboard, All Players,
  Provisional, Settings, Inactive, More leaderboard and data sugge,
  Data Issues, Seeds, Player IDs, Cards.
- Matches: 504 complete A:E rows (Date | Player 1 | Player 2 | Score 1 |
  Score 2, input from row 4) = data.js 504 matches; split 197 dated /
  307 legacy-identical to data.js (307 empty-date entries). 14 rows carry
  G..L server/halves metadata (ignored by the engine: metadata only).
- Leaderboard: 48 qualified rows; Slayer #1 2089.9 / 2113.5 / RD 47 /
  44 matches, No_Ammo #2 1959.2, Kobi #3 1934.5, Kaag #4 1907.0 —
  byte-identical to data.js.
- Aliases: ~123-125 wrongName -> correctName mappings (A:B from row 4).
- Seeds: ~97 player rows (A:B from row 4; ~55 with old 0-100 ratings).
- Settings: all 16 B-values match the engine defaults in order
  (1500, 80, 30, 80, 1500, 250, 250, 20, 30, 0.5, 5, 3, 365,
  46299 [= 2026-10-04 legacy grace start], 365, 1).
- Inactive: header only (0 players) — regenerated on recalc.
- Data Issues: contains OWNER NOTES (badge spec, flagged match rows),
  not engine output — back these up before the first recalc wipes the tab.

## Known non-blocker

Settings column A holds descriptive text/server notes instead of the key
names the script reads (only R4 'Seed Glicko midpoint' matches), so 15 of
16 settings are currently defaults-driven (values are identical, results
are unaffected — proven by the exact Leaderboard reproduction). Relabel
column A to the engine key names to make settings live-editable.
