/**
 * tierstats-publish Worker (replacement, built 2026-11-09).
 *
 * Chain: owned Google Sheet (authoritative, auto-recalc) -> this Worker
 * -> data.js committed to GitHub -> Pages redeploy.
 *
 * The Worker never writes to the Sheet. It only READS the Sheet's public
 * gviz export (the Sheet must be shared as "Anyone with the link: Viewer";
 * everything read here is already published on the website, so nothing
 * private is exposed) and commits the regenerated data.js.
 *
 * Endpoints (must stay compatible with Kode.gs + the site footer/admin):
 *   GET  /                diagnostics text
 *   GET  /sync-status     { matches, players, ageMinutes, stale, lastError, generated }
 *   POST /sync            { password } -> { ok, changed, matches, players } | { error }
 *   cron every 5 minutes      same as POST /sync (trusted, no password)
 *
 * Env (set in Cloudflare dashboard, never in code):
 *   SHEET_ID      spreadsheet id (var)
 *   GITHUB_REPO   e.g. Alternator1/alternator1.github.io (var)
 *   GITHUB_BRANCH e.g. main (var)
 *   GITHUB_TOKEN  fine-grained PAT, Contents read+write on the repo (secret)
 *   WORKER_SECRET admin/sync password shared with the Sheet (secret)
 */

const SERVERS = ["London", "Newark", "Dallas", "Atlanta", "Fremont", "Singapore", "Sydney"];
const DATA_PATH = "data.js";
const STALE_MINUTES = 30;

const DEFAULTS = {
  GITHUB_REPO: "Alternator1/alternator1.github.io",
  GITHUB_BRANCH: "main",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function secretsEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length === 0 || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function round1(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function asInt(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Excel serial (e.g. 46302) -> "YYYY-MM-DD". Returns "" for junk. */
function serialToISO(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return "";
  const ms = Math.round((n - 25569) * 86400) * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** gviz "Date(2026,9,18)" (month is 0-based) -> "2026-10-18". */
function gvizDateToISO(s) {
  const m = /^Date\((\d+),(\d+),(\d+)/.exec(String(s || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2], +m[3]));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Google Sheet reading (gviz JSON, no auth needed beyond link sharing)
 * ------------------------------------------------------------------ */

async function fetchSheetGrid(sheetId, sheetName) {
  const url =
    "https://docs.google.com/spreadsheets/d/" +
    encodeURIComponent(sheetId) +
    "/gviz/tq?tqx=out:json&headers=0&sheet=" +
    encodeURIComponent(sheetName); // headers=0: keep every row raw; header detection is done by findHeaderRow()
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await resp.text();
  if (!resp.ok) throw new Error("Sheet tab '" + sheetName + "' unreachable (HTTP " + resp.status + ").");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) {
    throw new Error(
      "Sheet tab '" + sheetName + "' did not return data. " +
      "Check link sharing: Anyone with the link can view."
    );
  }
  let payload;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error("Sheet tab '" + sheetName + "' returned unreadable data.");
  }
  const table = (payload && payload.table) || {};
  const rows = table.rows || [];
  return rows.map((r) => (r.c || []).map((c) => ({ v: c ? c.v : null, f: c && c.f != null ? String(c.f) : "" })));
}

function cellNum(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return NaN;
  if (typeof cell.v === "number") return cell.v;
  const s = String(cell.v).trim();
  if (s === "") return NaN;
  if (/^Date\(/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Percent-aware number: formatted "84.1%" -> 84.1, fraction 0.841 -> 84.1. */
function cellPct(cell) {
  if (!cell) return NaN;
  if (cell.f && /%\s*$/.test(cell.f)) {
    const n = Number(cell.f.replace(/%/g, "").trim());
    return Number.isFinite(n) ? n : NaN;
  }
  const n = cellNum(cell);
  if (!Number.isFinite(n)) return NaN;
  return n > 0 && n <= 1 ? n * 100 : n;
}

/** ISO date from a gviz cell: serial number, Date(...), or "YYYY-MM-DD". */
function cellISODate(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  if (typeof cell.v === "number") return serialToISO(cell.v);
  const s = String(cell.v).trim();
  if (s === "") return "";
  if (/^Date\(/.test(s)) return gvizDateToISO(s);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

function findHeaderRow(grid, pred) {
  for (let i = 0; i < grid.length; i++) {
    if (pred(grid[i], i)) return i;
  }
  return -1;
}

function headerIndex(headerRow, names) {
  const want = names.map((n) => n.toLowerCase());
  for (let i = 0; i < headerRow.length; i++) {
    if (want.includes(cellStrRaw(headerRow[i]).toLowerCase())) return i;
  }
  return -1;
}

function cellStrRaw(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  if (typeof cell.v === "number") return "";
  const s = String(cell.v);
  if (/^Date\(/.test(s)) return "";
  return s.trim();
}

function normServer(s) {
  const t = String(s || "").trim();
  const hit = SERVERS.find((x) => x.toLowerCase() === t.toLowerCase());
  return hit || "";
}

/* ------------------------------------------------------------------ *
 * Sheet -> data.js sections
 * ------------------------------------------------------------------ */

function buildAliases(grid) {
  const exact = {};
  const lower = {};
  for (const row of grid) {
    const a = cellStrRaw(row[0]);
    const c = cellStrRaw(row[1]);
    if (!a || !c) continue;
    const al = a.toLowerCase();
    const cl = c.toLowerCase();
    if (al === "wrongname" || al === "alias" || cl === "correctname" || cl === "canonical name") continue; // header row
    exact[a] = c;
    lower[al] = c;
  }
  return { exact, lower };
}

function canonical(name, aliases) {
  let n = String(name || "").trim();
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const hit = aliases.lower[n.toLowerCase()];
    if (!hit || hit === n || seen.has(n)) return n;
    seen.add(n);
    n = hit;
  }
  return n;
}

function buildMatches(grid, aliases) {
  const hi = findHeaderRow(grid, (row) =>
    row.some((c) => cellStrRaw(c).toLowerCase() === "player 1")
  );
  if (hi < 0) throw new Error("Matches tab: header row (Player 1) not found.");
  const head = grid[hi];
  const ai = headerIndex(head, ["player 1"]);
  const bi = headerIndex(head, ["player 2"]);
  const sai = headerIndex(head, ["score 1"]);
  const sbi = headerIndex(head, ["score 2"]);
  const di = headerIndex(head, ["date"]);
  if (ai < 0 || bi < 0 || sai < 0 || sbi < 0) {
    throw new Error("Matches tab: expected columns Date/Player 1/Player 2/Score 1/Score 2.");
  }
  // Server block sits right after the score columns (G..L when A..E are 0..4).
  const base = sbi + 2;
  const out = [];
  for (let r = hi + 1; r < grid.length; r++) {
    const row = grid[r];
    const a = canonical(cellStrRaw(row[ai]), aliases);
    const b = canonical(cellStrRaw(row[bi]), aliases);
    const sa = cellNum(row[sai]);
    const sb = cellNum(row[sbi]);
    if (!a || !b || !Number.isFinite(sa) || !Number.isFinite(sb)) continue;
    const m = { a, b, sa, sb, date: di >= 0 ? cellISODate(row[di]) : "" };
    const s1 = normServer(cellStrRaw(row[base]));
    const s2 = normServer(cellStrRaw(row[base + 3]));
    const servers = [];
    if (s1) servers.push(s1);
    if (s2 && s2 !== s1) servers.push(s2);
    if (servers.length) m.sv = servers;
    if (servers.length === 2) {
      const h = cellNum(row[base + 1]);
      const ic = cellNum(row[base + 2]);
      const k = cellNum(row[base + 4]);
      const l = cellNum(row[base + 5]);
      if ([h, ic, k, l].every(Number.isFinite)) m.svc = [[h, ic], [k, l]];
    }
    out.push(m);
  }
  return out;
}

function buildSeeds(grid, aliases) {
  const seeds = {};
  for (const row of grid) {
    const name = cellStrRaw(row[0]);
    const old = cellNum(row[1]);
    if (!name || !Number.isFinite(old)) continue;
    if (name.toLowerCase() === "player") continue; // header row
    seeds[canonical(name, aliases)] = old;
  }
  return seeds;
}

function buildSettings(grid) {
  const out = [];
  for (const row of grid) {
    const name = cellStrRaw(row[0]);
    if (!name || name.toLowerCase() === "setting") continue; // title/header
    const cell = row[1];
    if (!cell || cell.v === null || cell.v === undefined || String(cell.v).trim() === "") continue;
    let value = typeof cell.v === "number" ? cell.v : String(cell.v).trim();
    if (typeof value === "number" && /date/i.test(name)) {
      const iso = serialToISO(value);
      if (iso) value = iso;
    }
    out.push({ name, value, desc: cellStrRaw(row[2]) });
  }
  return out;
}

function buildInactive(grid, aliases) {
  const list = [];
  for (const row of grid) {
    const name = cellStrRaw(row[0]);
    if (!name || name.toLowerCase() === "player") continue;
    list.push(canonical(name, aliases));
  }
  return list;
}

function mapPlayerRow(row, head) {
  const get = (names) => {
    const i = headerIndex(head, names);
    return i >= 0 ? row[i] : undefined;
  };
  const name = cellStrRaw(get(["player"]));
  const rating = round1(cellNum(get(["rating"])));
  if (!name || !Number.isFinite(rating)) return null;
  const winPct = cellPct(get(["win %", "win%"]));
  return {
    rank: asInt(cellNum(get(["rank"])), 0),
    name,
    rating,
    glicko: round1(cellNum(get(["glicko"]))),
    rd: round1(cellNum(get(["rd"]))),
    matches: asInt(cellNum(get(["matches"]))),
    w: asInt(cellNum(get(["w"]))),
    l: asInt(cellNum(get(["l"]))),
    d: asInt(cellNum(get(["d"]))),
    winPct: round1(Number.isFinite(winPct) ? winPct : 0),
    opponents: asInt(cellNum(get(["opponents"]))),
    avgOpp: round1(cellNum(get(["avg opp rating"]))),
    lastMatch: cellISODate(get(["last match"])),
  };
}

function buildBoardTabs(lbGrid, apGrid, provGrid) {
  const lbHi = findHeaderRow(lbGrid, (row) =>
    row.some((c) => cellStrRaw(c).toLowerCase() === "rank")
  );
  if (lbHi < 0) throw new Error("Leaderboard tab: header row (Rank) not found.");
  const lbHead = lbGrid[lbHi];
  const qualified = [];
  for (let r = lbHi + 1; r < lbGrid.length; r++) {
    const p = mapPlayerRow(lbGrid[r], lbHead);
    if (!p) continue;
    const { lastMatch, ...rest } = p; // qualified entries carry no lastMatch
    void lastMatch;
    qualified.push(rest);
  }

  const apHi = findHeaderRow(apGrid, (row) => {
    const cells = row.map((c) => cellStrRaw(c).toLowerCase());
    return cells.includes("player") && cells.includes("rating");
  });
  if (apHi < 0) throw new Error("All Players tab: header row not found.");
  const apHead = apGrid[apHi];
  const players = [];
  for (let r = apHi + 1; r < apGrid.length; r++) {
    const p = mapPlayerRow(apGrid[r], apHead);
    if (!p) continue;
    const { rank, ...rest } = p; // players entries carry no rank
    void rank;
    players.push(rest);
  }

  const provNames = new Set();
  for (const row of provGrid) {
    const name = cellStrRaw(row[0]);
    if (!name || name.toLowerCase() === "player") continue;
    provNames.add(name);
  }
  return { qualified, players, provNames };
}

function buildHistories(matches) {
  const hist = {};
  const push = (who, opp, f, a, date, sv) => {
    if (!hist[who]) hist[who] = [];
    const e = { opp, for_: f, against: a, res: f > a ? "W" : f < a ? "L" : "D", date };
    if (sv) e.sv = sv.slice();
    hist[who].push(e);
  };
  for (const m of matches) {
    push(m.a, m.b, m.sa, m.sb, m.date, m.sv);
    push(m.b, m.a, m.sb, m.sa, m.date, m.sv);
  }
  return hist;
}

/* ------------------------------------------------------------------ *
 * GitHub Contents API
 * ------------------------------------------------------------------ */

function ghHeaders(env) {
  return {
    Authorization: "Bearer " + env.GITHUB_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "tierstats-publish-worker",
    "Content-Type": "application/json",
  };
}

function repoVars(env) {
  return {
    repo: env.GITHUB_REPO || DEFAULTS.GITHUB_REPO,
    branch: env.GITHUB_BRANCH || DEFAULTS.GITHUB_BRANCH,
  };
}

async function ghGetFile(env) {
  const { repo, branch } = repoVars(env);
  const url =
    "https://api.github.com/repos/" + repo + "/contents/" + DATA_PATH + "?ref=" + encodeURIComponent(branch);
  const resp = await fetch(url, { headers: ghHeaders(env) });
  if (resp.status === 404) return null; // first publish
  if (!resp.ok) throw new Error("GitHub read failed (HTTP " + resp.status + ").");
  const data = await resp.json();
  return { sha: data.sha, body: b64decode(data.content || "") };
}

async function ghPutFile(env, sha, body, message) {
  const { repo, branch } = repoVars(env);
  const url = "https://api.github.com/repos/" + repo + "/contents/" + DATA_PATH;
  const payload = { message, content: b64encode(body), branch };
  if (sha) payload.sha = sha;
  const resp = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("GitHub write failed (HTTP " + resp.status + "): " + t.slice(0, 160));
  }
  return resp.json();
}

async function ghLastCommitDate(env) {
  const { repo, branch } = repoVars(env);
  const url =
    "https://api.github.com/repos/" + repo + "/commits?path=" + encodeURIComponent(DATA_PATH) +
    "&sha=" + encodeURIComponent(branch) + "&per_page=1";
  const resp = await fetch(url, { headers: ghHeaders(env) });
  if (!resp.ok) throw new Error("GitHub commits read failed (HTTP " + resp.status + ").");
  const list = await resp.json();
  const iso = list && list[0] && list[0].commit && (list[0].commit.committer || {}).date;
  return iso || null;
}

function parseLbData(body) {
  const m = /window\.LB_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(body);
  if (!m) throw new Error("Existing data.js is not a window.LB_DATA file.");
  return JSON.parse(m[1]);
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

function settingsMap(settings) {
  const out = {};
  for (const s of settings) out[s.name] = s.value;
  return out;
}

function numOr(obj, key, fallback) {
  const n = Number(obj[key]);
  return Number.isFinite(n) ? n : fallback;
}

function daysBetween(aISO, bISO) {
  const a = Date.parse(aISO + "T00:00:00Z");
  const b = Date.parse(bISO + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((a - b) / 86400000);
}

async function runSync(env) {
  const sheetId = env.SHEET_ID;
  if (!sheetId) throw new Error("SHEET_ID is not configured on the Worker.");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured on the Worker.");
  const [matchesGrid, aliasesGrid, seedsGrid, settingsGrid, lbGrid, apGrid, provGrid, inGrid] =
    await Promise.all([
      fetchSheetGrid(sheetId, "Matches"),
      fetchSheetGrid(sheetId, "Aliases"),
      fetchSheetGrid(sheetId, "Seeds"),
      fetchSheetGrid(sheetId, "Settings"),
      fetchSheetGrid(sheetId, "Leaderboard"),
      fetchSheetGrid(sheetId, "All Players"),
      fetchSheetGrid(sheetId, "Provisional"),
      fetchSheetGrid(sheetId, "Inactive"),
    ]);

  const aliases = buildAliases(aliasesGrid);
  const matches = buildMatches(matchesGrid, aliases);
  const seeds = buildSeeds(seedsGrid, aliases);
  const settings = buildSettings(settingsGrid);
  const inactiveList = buildInactive(inGrid, aliases);
  const { qualified, players, provNames } = buildBoardTabs(lbGrid, apGrid, provGrid);

  const cfg = settingsMap(settings);
  const minM = numOr(cfg, "Minimum matches for leaderboard", 5);
  const minO = numOr(cfg, "Minimum different opponents", 3);
  const inactiveDays = numOr(cfg, "Inactive after days", 365);
  const graceDays = numOr(cfg, "Legacy grace days", 365);
  const graceStart = typeof cfg["Legacy grace start date"] === "string" && /^\d{4}-\d{2}-\d{2}/.test(cfg["Legacy grace start date"])
    ? cfg["Legacy grace start date"].slice(0, 10)
    : "2026-10-04";
  const today = todayISO();

  // Provisional: the sheet's own Provisional tab is the verdict, with the
  // thresholds as fallback for names missing from the tab.
  const oppCount = {};
  const matchCount = {};
  for (const m of matches) {
    matchCount[m.a] = (matchCount[m.a] || 0) + 1;
    matchCount[m.b] = (matchCount[m.b] || 0) + 1;
    oppCount[m.a] = oppCount[m.a] || {};
    oppCount[m.a][m.b] = 1;
    oppCount[m.b] = oppCount[m.b] || {};
    oppCount[m.b][m.a] = 1;
  }
  const oppN = (n) => Object.keys(oppCount[n] || {}).length;

  const inactiveSet = new Set(inactiveList.map((n) => n.toLowerCase()));
  const pastThreshold = (p) => {
    if (p.lastMatch) {
      const d = daysBetween(today, p.lastMatch);
      return Number.isFinite(d) && d > inactiveDays;
    }
    const g = daysBetween(today, graceStart);
    return Number.isFinite(g) && g > graceDays;
  };

  for (const p of players) {
    const inProvTab = provNames.has(p.name);
    const failsMin = (matchCount[p.name] || 0) < minM || oppN(p.name) < minO;
    if (inProvTab || failsMin) Object.assign(p, { provisional: true });
    const inTab = inactiveSet.has(p.name.toLowerCase());
    if (inTab) Object.assign(p, { inactive: pastThreshold(p) });
    else if (pastThreshold(p)) Object.assign(p, { inactive: true });
  }

  const histories = buildHistories(matches);

  // Previous-publish snapshots: prev = old current, cur = new ratings.
  const oldFile = await ghGetFile(env);
  const old = oldFile ? parseLbData(oldFile.body) : null;
  const oldCur = (old && old.curRatings) || {};
  if (!Object.keys(oldCur).length && old && Array.isArray(old.players)) {
    for (const p of old.players) {
      if (p && p.name && Number.isFinite(Number(p.rating))) oldCur[p.name] = Number(p.rating);
    }
  }
  const prevRanks = {};
  if (old && Array.isArray(old.qualified)) {
    old.qualified.forEach((q, i) => {
      if (q && q.name) prevRanks[q.name] = Number.isFinite(Number(q.rank)) ? Number(q.rank) : i + 1;
    });
  }
  const curRatings = {};
  for (const p of players) curRatings[p.name] = p.rating;

  // Rebuild data.js preserving key order + every non-sheet section (cards…).
  const next = {};
  const put = (k, v) => { next[k] = v; };
  const oldKeys = old ? Object.keys(old) : [];
  const have = new Set();
  const sheetSections = {
    generated: today,
    qualified,
    players,
    matches,
    aliases: aliases.exact,
    seeds,
    settings,
    inactiveList,
    histories,
    prevRatings: oldCur,
    prevRanks,
    curRatings,
    newSince: (old && old.newSince) || {},
  };
  if (!old) {
    for (const [k, v] of Object.entries(sheetSections)) put(k, v);
  } else {
    for (const k of oldKeys) {
      if (Object.prototype.hasOwnProperty.call(sheetSections, k)) put(k, sheetSections[k]);
      else put(k, old[k]);
      have.add(k);
    }
    for (const [k, v] of Object.entries(sheetSections)) {
      if (!have.has(k)) put(k, v);
    }
  }

  const body =
    "// 1v1 Leaderboard data - generated from Google Sheet (" + today + ")\n" +
    "window.LB_DATA = " + JSON.stringify(next) + ";\n";

  if (oldFile && oldFile.body === body) {
    return { changed: false, matches: matches.length, players: players.length };
  }
  const d = new Date();
  const stamp =
    String(d.getUTCFullYear()) + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0") + " " +
    String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  await ghPutFile(env, oldFile ? oldFile.sha : null, body,
    "Sheet sync " + stamp + " (" + matches.length + " matches)");
  return { changed: true, matches: matches.length, players: players.length };
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

async function handleSyncStatus(env) {
  try {
    const file = await ghGetFile(env);
    if (!file) return json({ error: "data.js has not been published yet." }, 404);
    const lb = parseLbData(file.body);
    const iso = await ghLastCommitDate(env);
    const ageMinutes = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) : null;
    return json({
      matches: Array.isArray(lb.matches) ? lb.matches.length : 0,
      players: Array.isArray(lb.players) ? lb.players.length : 0,
      ageMinutes,
      stale: ageMinutes === null ? true : ageMinutes > STALE_MINUTES,
      lastError: null,
      generated: lb.generated || null,
    });
  } catch (err) {
    return json({ error: String((err && err.message) || err).slice(0, 200) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && (path === "/" || path === "")) {
      return new Response("tierstats sync worker ok\n", {
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    }
    if (path === "/sync-status" && request.method === "GET") {
      return handleSyncStatus(env);
    }
    if (path === "/sync" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { /* empty/invalid body */ }
      if (!secretsEqual(body && body.password, env.WORKER_SECRET)) {
        return json({ error: "Unauthorized." }, 401);
      }
      try {
        const r = await runSync(env);
        return json({
          ok: true,
          changed: r.changed,
          matches: r.matches,
          players: r.players,
          note: r.changed
            ? r.matches + " matches / " + r.players + " players published."
            : "Site already matched the sheet.",
        });
      } catch (err) {
        return json({ error: String((err && err.message) || err).slice(0, 200) }, 500);
      }
    }
    return json({ error: "Not found." }, 404);
  },

  async scheduled(event, env, ctx) {
    try {
      const r = await runSync(env);
      console.log("cron sync: changed=" + r.changed + " matches=" + r.matches + " players=" + r.players);
    } catch (err) {
      console.log("cron sync failed: " + String((err && err.message) || err).slice(0, 200));
    }
  },
};
