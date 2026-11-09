/**
 * TierStats — Google Sheet → GitHub live sync (retargeted 2026-11-09).
 *
 * Target repo: Alternator1/alternator1.github.io (branch: main).
 * Chain: Sheet (auto-recalc, authoritative) → this script → tierstats-publish
 * Worker /sync → Worker regenerates data.js + commits to GitHub → Pages deploy.
 * A 5-minute Cloudflare cron on the Worker covers anything the trigger misses.
 *
 * Single-writer rule: the WORKER owns all data.js commits. This script's
 * primary job is to poke the Worker instantly (menu + on-change trigger).
 * pushDataJsDirect() is a DISABLED-BY-DEFAULT fallback for Worker outages.
 *
 * INTEGRATION WARNING: this file is a publishing-layer TEMPLATE only. Merge
 * its functions into the live Sheet's existing Apps Script project — NEVER
 * replace the live script, or the authoritative Glicko engine is lost.
 *
 * NO SECRETS IN THIS FILE. Everything sensitive lives in
 * Project Settings → Script Properties (see SETUP.md):
 *   GITHUB_REPO     Alternator1/alternator1.github.io
 *   GITHUB_BRANCH   main
 *   GITHUB_TOKEN    fine-grained PAT (contents: read+write on that repo only)
 *   WORKER_SYNC_URL https://tierstats-publish.tierstats.workers.dev/sync
 *   WORKER_SECRET   admin/worker shared secret (same password as #/admin)
 *   SYNC_STATUS_URL https://tierstats-publish.tierstats.workers.dev/sync-status
 *
 * Sheet tabs (from TankTrouble_Dynamic_Glicko.xlsx): Read Me, Settings,
 * Aliases, Seeds, Matches, Leaderboard, All Players, Provisional, Inactive,
 * Data Issues. Tab names are matched case-insensitively; missing optional
 * tabs are skipped. Column indexes below are 1-based — adjust to your sheet.
 */

var CONFIG_DEFAULTS = {
  GITHUB_REPO: 'Alternator1/alternator1.github.io',
  GITHUB_BRANCH: 'main',
  WORKER_SYNC_URL: 'https://tierstats-publish.tierstats.workers.dev/sync',
  SYNC_STATUS_URL: 'https://tierstats-publish.tierstats.workers.dev/sync-status',
  SHEET_MATCHES: 'Matches',       // a, b, sa, sb, date (+ optional sv)
  SHEET_ALIASES: 'Aliases',       // wrongName, correctName, [note]
  SHEET_SEEDS: 'Seeds',           // player, old(0-100), [glicko], [rd]
  SHEET_SETTINGS: 'Settings',     // name, value
  SHEET_INACTIVE: 'Inactive',     // player per row
  COL_MATCH_A: 1, COL_MATCH_B: 2, COL_MATCH_SA: 3, COL_MATCH_SB: 4, COL_MATCH_DATE: 5
};

function props() {
  return PropertiesService.getScriptProperties();
}

function cfg(key) {
  return props().getProperty(key) || CONFIG_DEFAULTS[key] || '';
}

/** Add-on menu: TierStats → Update website now / Check sync status / Setup check. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('TierStats')
    .addItem('Update website now', 'updateWebsiteNow')
    .addItem('Check sync status', 'checkSyncStatus')
    .addItem('Setup check', 'setupCheck')
    .addToUi();
}

/**
 * Installable on-change trigger entry point. Install once via
 * Edit → Current project's triggers → onSheetChange / From spreadsheet /
 * On change. Debounced: at most one Worker poke per 2 minutes.
 */
function onSheetChange(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var last = Number(props().getProperty('LAST_SYNC_PUSH_MS') || 0);
    if (Date.now() - last < 2 * 60 * 1000) return; // debounce
    var res = pokeWorkerSync_();
    if (res.ok) props().setProperty('LAST_SYNC_PUSH_MS', String(Date.now()));
  } finally {
    lock.releaseLock();
  }
}

/** Menu action: tell the Worker to regenerate data.js + commit NOW. */
function updateWebsiteNow() {
  var res = pokeWorkerSync_();
  var ui = SpreadsheetApp.getUi();
  if (res.ok) {
    props().setProperty('LAST_SYNC_PUSH_MS', String(Date.now()));
    ui.alert('TierStats: website update triggered ✓\n' + (res.note || 'The Worker is regenerating data.js.'));
  } else {
    ui.alert('TierStats sync failed: ' + res.error + '\nSee Apps Script Executions log.');
  }
  return res;
}

/** Menu action: show Worker sync-status (last publish age, matches, players). */
function checkSyncStatus() {
  var url = cfg('SYNC_STATUS_URL');
  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var data = JSON.parse(resp.getContentText() || '{}');
    var msg = 'Matches: ' + (data.matches != null ? data.matches : '?') +
      '\nPlayers: ' + (data.players != null ? data.players : '?') +
      '\nLast publish: ' + (data.ageMinutes != null ? data.ageMinutes + ' min ago' : 'unknown') +
      (data.stale ? '\nSTALE' : '') +
      (data.lastError ? '\nLast error: ' + data.lastError : '');
    SpreadsheetApp.getUi().alert('TierStats sync status\n\n' + msg);
    return data;
  } catch (err) {
    SpreadsheetApp.getUi().alert('Could not reach sync-status: ' + err);
    throw err;
  }
}

/** Menu action: verify Script Properties + connectivity without pushing. */
function setupCheck() {
  var missing = [];
  ['GITHUB_REPO', 'GITHUB_BRANCH', 'GITHUB_TOKEN', 'WORKER_SYNC_URL', 'WORKER_SECRET']
    .forEach(function (k) { if (!props().getProperty(k) && !CONFIG_DEFAULTS[k]) missing.push(k); });
  // GITHUB_TOKEN has no default — it MUST be set by the owner.
  if (!props().getProperty('GITHUB_TOKEN')) missing.push('GITHUB_TOKEN');
  var msg = missing.length
    ? 'Missing Script Properties:\n- ' + missing.join('\n- ') + '\n\nSee apps-script/SETUP.md.'
    : 'Script Properties look complete for repo ' + cfg('GITHUB_REPO') +
      ' (branch ' + cfg('GITHUB_BRANCH') + ').\nSheet recalculation is automatic; ' +
      'this script only triggers the website update.';
  SpreadsheetApp.getUi().alert('TierStats setup check\n\n' + msg);
  return { ok: missing.length === 0, missing: missing };
}

/** POST {password} to Worker /sync. Returns {ok, note|error}. */
function pokeWorkerSync_() {
  var url = cfg('WORKER_SYNC_URL');
  var secret = props().getProperty('WORKER_SECRET') || '';
  if (!url) return { ok: false, error: 'WORKER_SYNC_URL not set in Script Properties.' };
  if (!secret) return { ok: false, error: 'WORKER_SECRET not set in Script Properties.' };
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ password: secret }),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    var data = {};
    try { data = JSON.parse(resp.getContentText() || '{}'); } catch (e) { /* non-JSON */ }
    if (code >= 200 && code < 300 && (data.ok !== false)) {
      return {
        ok: true,
        note: data.changed
          ? (data.matches + ' matches / ' + data.players + ' players published.')
          : 'Site already matched the sheet.'
      };
    }
    Logger.log('Worker /sync failed: HTTP ' + code + ' ' + resp.getContentText());
    return { ok: false, error: 'Worker HTTP ' + code + (data.error ? ': ' + data.error : '') };
  } catch (err) {
    Logger.log('Worker /sync error: ' + err);
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ *
 * FALLBACK (disabled by default): commit data.js straight to GitHub.  *
 * Use ONLY if the Worker is down. Re-enable the Worker path as soon   *
 * as possible — two writers cause endless "changed" commits.           *
 * ------------------------------------------------------------------ */

/** Fallback: build data.js from sheet tabs + commit via GitHub Contents API. */
function pushDataJsDirect() {
  var token = props().getProperty('GITHUB_TOKEN') || '';
  if (!token) throw new Error('GITHUB_TOKEN not set in Script Properties.');
  var repo = cfg('GITHUB_REPO');
  var branch = cfg('GITHUB_BRANCH');
  var lbData = buildLbDataFromSheet_();
  var body = '// 1v1 Leaderboard data - generated from Google Sheet (' +
    Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd') + ')\n' +
    'window.LB_DATA = ' + JSON.stringify(lbData) + ';\n';

  var apiBase = 'https://api.github.com/repos/' + repo + '/contents/data.js';
  var headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TierStats-AppsScript'
  };
  // Read current sha so the update is anchored (required by the API).
  var sha = null;
  try {
    var cur = UrlFetchApp.fetch(apiBase + '?ref=' + encodeURIComponent(branch), {
      headers: headers, muteHttpExceptions: true
    });
    if (cur.getResponseCode() === 200) sha = JSON.parse(cur.getContentText()).sha;
  } catch (e) { /* file may not exist yet */ }

  var payload = {
    message: 'Sheet sync ' + Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm') +
      ' (' + (lbData.matches || []).length + ' matches)',
    content: Utilities.base64Encode(body, Utilities.Charset.UTF_8),
    branch: branch
  };
  if (sha) payload.sha = sha;
  var resp = UrlFetchApp.fetch(apiBase, {
    method: 'put', headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('GitHub HTTP ' + code + ': ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

/**
 * Assemble a window.LB_DATA-shaped object from sheet tabs. The sheet's own
 * formulas remain the rating authority; this reads the computed/export tabs
 * (Matches, Aliases, Seeds, Settings, Inactive) into data.js field shape.
 * Adjust column constants at the top to match your exact layout.
 */
function buildLbDataFromSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  function tab(name) {
    var list = ss.getSheets().filter(function (s) {
      return s.getName().toLowerCase() === String(name).toLowerCase();
    });
    return list[0] || null;
  }
  function rows(sh) {
    if (!sh) return [];
    var v = sh.getDataRange().getValues();
    return v.length > 1 ? v.slice(1) : []; // skip header row
  }
  var out = { generated: Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd') };

  var msh = tab(CONFIG_DEFAULTS.SHEET_MATCHES);
  out.matches = rows(msh).map(function (r) {
    return {
      a: String(r[CONFIG_DEFAULTS.COL_MATCH_A - 1] || ''),
      b: String(r[CONFIG_DEFAULTS.COL_MATCH_B - 1] || ''),
      sa: Number(r[CONFIG_DEFAULTS.COL_MATCH_SA - 1]),
      sb: Number(r[CONFIG_DEFAULTS.COL_MATCH_SB - 1]),
      date: formatDateCell_(r[CONFIG_DEFAULTS.COL_MATCH_DATE - 1])
    };
  }).filter(function (m) { return m.a && m.b; });

  var ash = tab(CONFIG_DEFAULTS.SHEET_ALIASES);
  out.aliases = {};
  rows(ash).forEach(function (r) {
    if (r[0] && r[1]) out.aliases[String(r[0])] = String(r[1]);
  });

  var ssh = tab(CONFIG_DEFAULTS.SHEET_SEEDS);
  out.seeds = {};
  rows(ssh).forEach(function (r) {
    if (r[0] && r[1] !== '' && r[1] != null) out.seeds[String(r[0])] = Number(r[1]);
  });

  var stsh = tab(CONFIG_DEFAULTS.SHEET_SETTINGS);
  out.settings = [];
  rows(stsh).forEach(function (r) {
    if (r[0] !== '' && r[0] != null) out.settings.push({ name: String(r[0]), value: r[1] });
  });

  var ish = tab(CONFIG_DEFAULTS.SHEET_INACTIVE);
  out.inactiveList = rows(ish).map(function (r) { return String(r[0] || ''); })
    .filter(function (x) { return !!x; });

  return out;
}

function formatDateCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  var s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
