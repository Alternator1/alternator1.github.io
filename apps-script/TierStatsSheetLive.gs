/**
 * Tank Trouble dynamic Glicko leaderboard for Google Sheets.
 *
 * Expected sheets:
 *   Settings, Aliases, Seeds, Matches, Leaderboard, All Players,
 *   Provisional, Inactive, Data Issues
 *
 * Matches sheet input columns (starting row 4):
 *   A Date | B Player 1 | C Player 2 | D Score 1 | E Score 2
 *
 * Add aliases in Aliases!A:B, e.g. Purity | Rapid, then recalculate.
 *
 * WEBSITE PUBLISHING LAYER (merged, Worker-first):
 *   - The 'TierStats website' menu + ttWebsiteOnChange trigger below only
 *     poke the tierstats-publish Worker so it regenerates data.js and commits
 *     to Stats4Tanks/stats4tanks.github.io. They NEVER change ratings.
 *   - Secrets live in Project Settings -> Script Properties (never in code).
 *   - This file must be MERGED into the live project, never replace it.
 *
 * RATING RULEBOOK (current):
 *   One row = ONE match = ONE Glicko W/L/D update from the final D/E totals,
 *   even when sets were played across servers. Extra columns (e.g. server
 *   info in G..L) are metadata only. To rate halves separately, enter them
 *   as separate rows.
 */

const TT = {
  SETTINGS: 'Settings',
  ALIASES: 'Aliases',
  SEEDS: 'Seeds',
  MATCHES: 'Matches',
  LEADERBOARD: 'Leaderboard',
  ALL_PLAYERS: 'All Players',
  PROVISIONAL: 'Provisional',
  INACTIVE: 'Inactive',
  ISSUES: 'Data Issues',
  INPUT_START_ROW: 4,
  OUTPUT_HEADER_ROW: 5
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Rankings')
    .addItem('Recalculate leaderboard', 'recalculateLeaderboard')
    .addItem('Setup / refresh now', 'setupTankTrouble')
    .addSeparator()
    .addItem('Install automatic refresh', 'ttInstallRankingTrigger')
    .addToUi();

  // Website publishing menu (merged layer — ratings untouched).
  SpreadsheetApp.getUi()
    .createMenu('TierStats website')
    .addItem('Update website now', 'updateWebsiteNow')
    .addItem('Check sync status', 'checkSyncStatus')
    .addItem('Setup check', 'setupCheck')
    .addToUi();
}

function setupTankTrouble() {
  recalculateLeaderboard();
  SpreadsheetApp.getActive().toast('Glicko leaderboard refreshed.', 'Tank Trouble', 4);
}

/**
 * Automatic refresh after a complete match is added/edited.
 * It also refreshes if Settings, Seeds or Aliases are changed.
 */
function ttRankingOnEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const name = sheet.getName();

  // Recalculate whenever Settings, Aliases or Seeds data is edited.
  if (name === TT.SETTINGS || name === TT.ALIASES || name === TT.SEEDS) {
    if (e.range.getRow() < 4) return;
    if (!autoRecalcEnabled_()) return;
    recalculateLeaderboard();
    return;
  }

  // For Matches, only A:E affect the ranking engine.
  // Extra metadata columns (for example server information) are ignored.
  if (name !== TT.MATCHES ||
      e.range.getRow() < TT.INPUT_START_ROW ||
      e.range.getColumn() > 5) {
    return;
  }

  if (!autoRecalcEnabled_()) return;

  // Recalculate when an affected match row is complete, or after a deletion/correction.
  const startRow = e.range.getRow();
  const rowCount = e.range.getNumRows();
  const values = sheet.getRange(startRow, 1, rowCount, 5).getValues();

  const complete = values.some(r =>
    clean_(r[1]) && clean_(r[2]) && isScore_(r[3]) && isScore_(r[4])
  );
  const deletion = typeof e.value === 'undefined';
  if (complete || deletion) {
    recalculateLeaderboard();
  }
}

/**
 * Run this ONCE after pasting the script.
 * It installs a reliable edit trigger for automatic leaderboard recalculation.
 * Safe to run again: it removes only its own old ranking trigger first.
 */
function ttInstallRankingTrigger() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'ttRankingOnEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('ttRankingOnEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();
  SpreadsheetApp.getUi().alert(
    'Automatic leaderboard recalculation installed.'
  );
}

function recalculateLeaderboard() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const cfg = readSettings_(ss);
    const aliases = readAliases_(ss);
    const issues = [];
    const seeds = readSeeds_(ss, aliases, cfg, issues);
    const matches = readMatches_(ss, aliases, issues);
    const result = calculateGlicko_(matches, seeds, cfg);
    writeOutputs_(ss, result, issues, cfg);
  } finally {
    lock.releaseLock();
  }
}

function autoRecalcEnabled_() {
  try {
    const cfg = readSettings_(SpreadsheetApp.getActive());
    const v = cfg['Auto recalculate'];
    return !(v === false || String(v).toLowerCase() === 'false' || String(v) === '0');
  } catch (err) {
    return true;
  }
}

function readSettings_(ss) {
  const sh = ss.getSheetByName(TT.SETTINGS);
  if (!sh) throw new Error('Missing Settings sheet.');
  const last = Math.max(sh.getLastRow(), 4);
  const rows = sh.getRange(4, 1, last - 3, 2).getValues();
  const out = {};
  rows.forEach(r => {
    const key = clean_(r[0]);
    if (key) out[key] = r[1];
  });
  // Safe defaults if a setting is blank.
  out['Seed Glicko midpoint'] = numberOr_(out['Seed Glicko midpoint'], 1500);
  out['Old rating midpoint'] = numberOr_(out['Old rating midpoint'], 80);
  out['Glicko points per old rating point'] = numberOr_(out['Glicko points per old rating point'], 30);
  out['Known-player starting RD'] = numberOr_(out['Known-player starting RD'], 80);
  out['Unrated-player starting rating'] = numberOr_(out['Unrated-player starting rating'], 1500);
  out['Unrated-player starting RD'] = numberOr_(out['Unrated-player starting RD'], 250);
  out['Maximum RD'] = numberOr_(out['Maximum RD'], 250);
  out['RD growth per rating period'] = numberOr_(out['RD growth per rating period'], 20);
  out['Rating period length (days)'] = numberOr_(out['Rating period length (days)'], 30);
  out['Conservative RD multiplier'] = numberOr_(out['Conservative RD multiplier'], 0.50);
  out['Minimum matches for leaderboard'] = numberOr_(out['Minimum matches for leaderboard'], 5);
  out['Minimum different opponents'] = numberOr_(out['Minimum different opponents'], 3);
  out['Inactive after days'] = numberOr_(out['Inactive after days'], 365);
  out['Legacy grace days'] = numberOr_(out['Legacy grace days'], 365);
  out['Legacy grace start date'] = asDate_(out['Legacy grace start date']) || new Date(2026, 9, 4);
  return out;
}

function readAliases_(ss) {
  const sh = ss.getSheetByName(TT.ALIASES);
  const exact = {};
  const lower = {};
  if (!sh || sh.getLastRow() < 4) return {exact, lower};
  sh.getRange(4, 1, sh.getLastRow() - 3, 2).getValues().forEach(r => {
    const a = clean_(r[0]);
    const c = clean_(r[1]);
    if (!a || !c) return;
    exact[a] = c;
    lower[a.toLowerCase()] = c;
  });
  return {exact, lower};
}

function canonical_(name, aliases) {
  let cur = clean_(name);
  if (!cur) return '';
  const seen = {};
  for (let i = 0; i < 12; i++) {
    const key = cur.toLowerCase();
    if (seen[key]) break;
    seen[key] = true;
    const next = aliases.exact[cur] || aliases.lower[key];
    if (!next) break;
    const cleanedNext = clean_(next);
    // We have reached the canonical/self-mapping name.
    if (cleanedNext === cur) break;
    cur = cleanedNext;
  }
  return cur;
}

function readSeeds_(ss, aliases, cfg, issues) {
  const sh = ss.getSheetByName(TT.SEEDS);
  const seeds = {};
  if (!sh || sh.getLastRow() < 4) return seeds;
  const rows = sh.getRange(4, 1, sh.getLastRow() - 3, 2).getValues();
  rows.forEach((r, i) => {
    const raw = clean_(r[0]);
    if (!raw) return;
    const p = canonical_(raw, aliases);
    const old = r[1] === '' || r[1] === null ? null : Number(r[1]);
    if (old !== null && !Number.isFinite(old)) {
      issues.push([TT.SEEDS, i + 4, 'Invalid old rating', raw]);
      return;
    }
    if (!seeds[p]) seeds[p] = {old: old};
    else if (old !== null) seeds[p].old = seeds[p].old === null || seeds[p].old === undefined ? old : Math.max(seeds[p].old, old);
  });
  return seeds;
}

function readMatches_(ss, aliases, issues) {
  const sh = ss.getSheetByName(TT.MATCHES);
  if (!sh || sh.getLastRow() < TT.INPUT_START_ROW) return [];
  // Only A:E are ranking input. Extra columns (e.g. server info in G..L)
  // are metadata and never affect ratings — one row is always ONE match.
  const rows = sh.getRange(TT.INPUT_START_ROW, 1, sh.getLastRow() - TT.INPUT_START_ROW + 1, 5).getValues();
  const matches = [];
  const datedSignatures = {};
  rows.forEach((r, i) => {
    const sheetRow = i + TT.INPUT_START_ROW;
    const rawP1 = clean_(r[1]);
    const rawP2 = clean_(r[2]);
    const any = r.some(v => v !== '' && v !== null);
    if (!any) return;
    if (!rawP1 || !rawP2 || !isScore_(r[3]) || !isScore_(r[4])) {
      issues.push([TT.MATCHES, sheetRow, 'Incomplete match row — not counted', JSON.stringify(r)]);
      return;
    }
    const p1 = canonical_(rawP1, aliases);
    const p2 = canonical_(rawP2, aliases);
    if (p1 === p2) {
      issues.push([TT.MATCHES, sheetRow, 'Both names resolve to the same player — not counted', p1]);
      return;
    }
    const s1 = Number(r[3]);
    const s2 = Number(r[4]);
    if (s1 < 0 || s2 < 0) {
      issues.push([TT.MATCHES, sheetRow, 'Negative score — not counted', s1 + ' / ' + s2]);
      return;
    }
    let date = null;
    if (r[0] !== '' && r[0] !== null) {
      date = asDate_(r[0]);
      if (!date) issues.push([TT.MATCHES, sheetRow, 'Invalid date; match counted as legacy/undated', String(r[0])]);
    }
    const m = {row: sheetRow, date, p1, p2, s1, s2};
    matches.push(m);
    // Warning only. We do NOT auto-delete it because same-score rematches can be real.
    if (date) {
      const d = Utilities.formatDate(date, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
      const ordered = p1 < p2 ? [p1,p2,s1,s2] : [p2,p1,s2,s1];
      const sig = [d].concat(ordered).join('|');
      if (datedSignatures[sig]) issues.push([TT.MATCHES, sheetRow, 'Possible duplicate dated match; review manually', 'Same as row ' + datedSignatures[sig]]);
      else datedSignatures[sig] = sheetRow;
    }
  });
  return matches;
}

function calculateGlicko_(matches, seeds, cfg) {
  const q = Math.log(10) / 400;
  const maxRD = cfg['Maximum RD'];
  const c = cfg['RD growth per rating period'];
  const periodDays = cfg['Rating period length (days)'];
  const minMatches = cfg['Minimum matches for leaderboard'];
  const minOpp = cfg['Minimum different opponents'];
  const inactiveDays = cfg['Inactive after days'];
  const graceStart = cfg['Legacy grace start date'];
  const graceDays = cfg['Legacy grace days'];
  const cons = cfg['Conservative RD multiplier'];
  // Calibration protection for completely unseeded players.
  // Seeded historical players are calibrated immediately.
  // Unseeded players become calibrated after 3 verified matches
  // AND 2 different opponents.
  //
  // While an opponent is still uncalibrated, that opponent has
  // only 25% influence on an already-calibrated player's update.
  // The uncalibrated player's own update remains full-strength.
  const CALIBRATION_MATCHES = 3;
  const CALIBRATION_OPPONENTS = 2;
  const UNCALIBRATED_WEIGHT = 0.25;

  const playerSet = {};
  Object.keys(seeds).forEach(p => playerSet[p] = true);
  matches.forEach(m => {
    playerSet[m.p1] = true;
    playerSet[m.p2] = true;
  });
  const players = Object.keys(playerSet).sort();
  const state = {};
  players.forEach(p => {
    const old = seeds[p] ? seeds[p].old : null;
    const seeded =
      old !== null &&
      old !== undefined &&
      Number.isFinite(Number(old));
    let rating, rd;
    if (seeded) {
      const rawSeed =
        cfg['Seed Glicko midpoint'] +
        (Number(old) - cfg['Old rating midpoint']) *
        cfg['Glicko points per old rating point'];
      rating = Math.max(700, rawSeed);
      rd = cfg['Known-player starting RD'];
    } else {
      rating = cfg['Unrated-player starting rating'];
      rd = cfg['Unrated-player starting RD'];
    }
    state[p] = {
      rating,
      rd,
      old,
      seeded,
      // Running calibration history, used only for the newcomer
      // protection rule below.
      calibGames: 0,
      calibOpponents: {},
      wins: 0,
      losses: 0,
      draws: 0,
      opponents: {},
      games: [],
      lastDate: null,
      lastPeriod: null,
      playedLegacy: false,
      playedDated: false
    };
  });

  // Count overall W/L/D and opponent statistics once.
  matches.forEach(m => {
    const a = state[m.p1];
    const b = state[m.p2];
    const sA = m.s1 > m.s2 ? 1 : m.s1 < m.s2 ? 0 : 0.5;
    const sB = 1 - sA;
    if (sA === 1) {
      a.wins++;
      b.losses++;
    } else if (sA === 0) {
      b.wins++;
      a.losses++;
    } else {
      a.draws++;
      b.draws++;
    }
    a.opponents[m.p2] = true;
    b.opponents[m.p1] = true;
    a.games.push({opp:m.p2, score:sA});
    b.games.push({opp:m.p1, score:sB});
    if (m.date) {
      if (!a.lastDate || m.date > a.lastDate) a.lastDate = m.date;
      if (!b.lastDate || m.date > b.lastDate) b.lastDate = m.date;
    }
  });

  const legacy = matches.filter(m => !m.date);
  // Dated matches are chronological. If two matches share a date,
  // spreadsheet row order is the official order.
  const dated = matches
    .filter(m => !!m.date)
    .sort((a,b) => a.date - b.date || a.row - b.row);

  function isCalibrated_(st) {
    if (st.seeded) return true;
    return (
      st.calibGames >= CALIBRATION_MATCHES &&
      Object.keys(st.calibOpponents).length >= CALIBRATION_OPPONENTS
    );
  }

  // Legacy imported history remains one batch because its true
  // chronological order is unknown.
  if (legacy.length) {
    batchUpdate_(state, legacy, q, null, c, maxRD, false);
    legacy.forEach(m => {
      const a = state[m.p1];
      const b = state[m.p2];
      a.playedLegacy = true;
      b.playedLegacy = true;
      // Legacy verified matches still provide calibration evidence.
      a.calibGames++;
      b.calibGames++;
      a.calibOpponents[m.p2] = true;
      b.calibOpponents[m.p1] = true;
    });
  }

  // Modern dated matches are processed one match at a time.
  // This avoids a whole 30-day batch being recalculated whenever
  // one new result is added.
  //
  // The 30-day setting is now used only for RD growth from inactivity.
  if (dated.length) {
    const lastRatedDate = {};
    dated.forEach(m => {
      const a = state[m.p1];
      const b = state[m.p2];
      // Increase RD only after full inactivity periods between
      // this player's dated matches.
      [m.p1, m.p2].forEach(p => {
        const previousDate = lastRatedDate[p];
        if (!previousDate) return;
        const gapDays = Math.max(
          0,
          daysBetween_(previousDate, m.date)
        );
        const idlePeriods = Math.floor(
          gapDays / periodDays
        );
        if (idlePeriods <= 0) return;
        const st = state[p];
        st.rd = Math.min(
          maxRD,
          Math.sqrt(
            st.rd * st.rd +
            c * c * idlePeriods
          )
        );
      });

      // Current rulebook: one row is ONE rating update from the final
      // D/E totals, even when sets were played across servers. Halves are
      // rated separately only if entered as separate rows.
      {
        // Calibration is re-checked before every match.
        const aCalibrated = isCalibrated_(a);
        const bCalibrated = isCalibrated_(b);
        // If a calibrated player faces an uncalibrated opponent,
        // the established/calibrated player's update is only 25%.
        // The newcomer's own update remains 100%.
        const weightA =
          aCalibrated && !bCalibrated
            ? UNCALIBRATED_WEIGHT
            : 1.0;
        const weightB =
          bCalibrated && !aCalibrated
            ? UNCALIBRATED_WEIGHT
            : 1.0;
        weightedSingleMatchUpdate_(
          state,
          { p1: m.p1, p2: m.p2, s1: m.s1, s2: m.s2 },
          q,
          weightA,
          weightB
        );
        // Every match counts toward calibration for the ones after it.
        a.calibGames++;
        b.calibGames++;
        a.calibOpponents[m.p2] = true;
        b.calibOpponents[m.p1] = true;
      }

      a.playedDated = true;
      b.playedDated = true;
      lastRatedDate[m.p1] = m.date;
      lastRatedDate[m.p2] = m.date;
    });
  }

  const today = stripTime_(new Date());
  const rows = [];
  players.forEach(p => {
    const st = state[p];
    const total = st.wins + st.losses + st.draws;
    const unique = Object.keys(st.opponents).length;
    const qualified = total >= minMatches && unique >= minOpp;
    const daysSince = st.lastDate
      ? Math.max(0, daysBetween_(st.lastDate, today))
      : null;
    // Slow current RD growth: only full rating periods count.
    let idlePeriods = 0;
    if (st.lastDate) {
      idlePeriods = Math.max(
        0,
        Math.floor(daysSince / periodDays)
      );
    } else if (st.playedLegacy) {
      idlePeriods = Math.max(
        0,
        Math.floor(
          daysBetween_(graceStart, today) /
          periodDays
        )
      );
    }
    const currentRD = Math.min(
      maxRD,
      Math.sqrt(
        st.rd * st.rd +
        c * c * idlePeriods
      )
    );
    const leaderRating =
      st.rating -
      cons * currentRD;
    let status;
    if (!qualified) {
      status = 'PROVISIONAL';
    } else if (st.lastDate) {
      status =
        daysSince > inactiveDays
          ? 'INACTIVE'
          : 'ACTIVE';
    } else {
      const graceAge =
        daysBetween_(graceStart, today);
      status =
        graceAge <= graceDays
          ? 'LEGACY / DATE UNKNOWN'
          : 'INACTIVE / NO DATED MATCH';
    }
    let avgOpp = null;
    const oppNames =
      Object.keys(st.opponents);
    if (oppNames.length) {
      avgOpp =
        oppNames.reduce(
          (sum,o) => sum + state[o].rating,
          0
        ) /
        oppNames.length;
    }
    rows.push({
      player: p,
      old: st.old,
      rating: st.rating,
      rd: currentRD,
      baseRD: st.rd,
      leader: leaderRating,
      matches: total,
      wins: st.wins,
      losses: st.losses,
      draws: st.draws,
      unique,
      winPct: total ? st.wins / total : 0,
      avgOpp,
      lastDate: st.lastDate,
      daysSince,
      qualified,
      status
    });
  });

  rows.sort(
    (a,b) =>
      b.leader - a.leader ||
      b.rating - a.rating ||
      a.player.localeCompare(b.player)
  );

  const leaderboard = rows.filter(
    x =>
      x.qualified &&
      (
        x.status === 'ACTIVE' ||
        x.status === 'LEGACY / DATE UNKNOWN'
      )
  );
  const provisional = rows.filter(
    x => !x.qualified
  );
  const inactive = rows.filter(
    x =>
      x.qualified &&
      !(
        x.status === 'ACTIVE' ||
        x.status === 'LEGACY / DATE UNKNOWN'
      )
  );

  return {
    rows,
    leaderboard,
    provisional,
    inactive
  };
}

function weightedSingleMatchUpdate_(
  state,
  match,
  q,
  weightP1,
  weightP2
) {
  const p1 = state[match.p1];
  const p2 = state[match.p2];
  // Freeze both PRE-match states. Both players must be calculated
  // from the same pre-match ratings and RDs.
  const pre1 = {
    rating: p1.rating,
    rd: p1.rd
  };
  const pre2 = {
    rating: p2.rating,
    rd: p2.rd
  };
  const score1 =
    match.s1 > match.s2 ? 1 :
    match.s1 < match.s2 ? 0 :
    0.5;
  const score2 = 1 - score1;
  function updateOne_(own, opp, score, weight) {
    const g =
      1 /
      Math.sqrt(
        1 +
        3 * q * q * opp.rd * opp.rd /
        (Math.PI * Math.PI)
      );
    const E =
      1 /
      (
        1 +
        Math.pow(
          10,
          -g * (own.rating - opp.rating) / 400
        )
      );
    // Weight both the information/variance contribution and
    // the result contribution. That means an uncertain newcomer
    // also reduces the established player's RD less.
    const varianceSum =
      weight *
      g * g *
      E *
      (1 - E);
    const deltaSum =
      weight *
      g *
      (score - E);
    if (varianceSum <= 0) {
      return {
        rating: own.rating,
        rd: own.rd
      };
    }
    const d2 =
      1 /
      (q * q * varianceSum);
    const inv =
      1 / (own.rd * own.rd) +
      1 / d2;
    return {
      rd: Math.sqrt(1 / inv),
      rating:
        own.rating +
        (q / inv) * deltaSum
    };
  }
  const next1 = updateOne_(
    pre1,
    pre2,
    score1,
    weightP1
  );
  const next2 = updateOne_(
    pre2,
    pre1,
    score2,
    weightP2
  );
  p1.rating = next1.rating;
  p1.rd = next1.rd;
  p2.rating = next2.rating;
  p2.rd = next2.rd;
}

function batchUpdate_(state, matches, q, periodIndex, c, maxRD, applyTimeGrowth) {
  const participants = {};
  matches.forEach(m => {participants[m.p1] = true; participants[m.p2] = true;});
  const names = Object.keys(participants);
  const pre = {};
  names.forEach(p => {
    const st = state[p];
    let rd = st.rd;
    if (applyTimeGrowth) {
      let elapsed = 0;
      if (st.lastPeriod !== null) elapsed = Math.max(1, periodIndex - st.lastPeriod);
      // A player's very first dated competition uses their starting RD without extra inflation.
      if (elapsed > 0) rd = Math.min(maxRD, Math.sqrt(rd * rd + c * c * elapsed));
    }
    pre[p] = {rating:st.rating, rd:rd};
  });
  const byPlayer = {};
  names.forEach(p => byPlayer[p] = []);
  matches.forEach(m => {
    const s1 = m.s1 > m.s2 ? 1 : m.s1 < m.s2 ? 0 : 0.5;
    byPlayer[m.p1].push({opp:m.p2, score:s1});
    byPlayer[m.p2].push({opp:m.p1, score:1-s1});
  });
  names.forEach(p => {
    const own = pre[p];
    const games = byPlayer[p];
    let varianceSum = 0;
    let deltaSum = 0;
    games.forEach(game => {
      const opp = pre[game.opp];
      const gg = 1 / Math.sqrt(1 + 3 * q * q * opp.rd * opp.rd / (Math.PI * Math.PI));
      const E = 1 / (1 + Math.pow(10, -gg * (own.rating - opp.rating) / 400));
      varianceSum += gg * gg * E * (1 - E);
      deltaSum += gg * (game.score - E);
    });
    if (varianceSum <= 0) return;
    const d2 = 1 / (q * q * varianceSum);
    const inv = 1 / (own.rd * own.rd) + 1 / d2;
    state[p].rd = Math.sqrt(1 / inv);
    state[p].rating = own.rating + (q / inv) * deltaSum;
    if (applyTimeGrowth) {
      state[p].lastPeriod = periodIndex;
      state[p].playedDated = true;
    }
  });
}

function writeOutputs_(ss, result, issues, cfg) {
  const leaderboardRows = result.leaderboard.map((x,i) => [
    i+1, x.player, round1_(x.leader), round1_(x.rating), round1_(x.rd),
    x.matches, x.wins, x.losses, x.draws, x.winPct, x.unique,
    x.avgOpp === null ? '' : round1_(x.avgOpp), x.lastDate || '', x.status,
    x.old === null || x.old === undefined ? '' : x.old
  ]);
  const allRows = result.rows.map(x => [
    x.player, round1_(x.leader), round1_(x.rating), round1_(x.rd),
    x.matches, x.wins, x.losses, x.draws, x.winPct, x.unique,
    x.avgOpp === null ? '' : round1_(x.avgOpp), x.lastDate || '',
    x.daysSince === null ? '' : x.daysSince, x.status,
    x.old === null || x.old === undefined ? '' : x.old
  ]);
  const provisionalRows = result.provisional.map(x => [
    x.player, round1_(x.leader), x.matches, x.unique,
    Math.max(0, cfg['Minimum matches for leaderboard'] - x.matches),
    Math.max(0, cfg['Minimum different opponents'] - x.unique),
    x.lastDate || '', x.status
  ]);
  const inactiveRows = result.inactive.map(x => [
    x.player, round1_(x.leader), round1_(x.rating), round1_(x.rd),
    x.matches, x.unique, x.lastDate || '', x.daysSince === null ? '' : x.daysSince, x.status
  ]);
  writeTable_(ss.getSheetByName(TT.LEADERBOARD), TT.OUTPUT_HEADER_ROW,
    ['Rank','Player','Rating','Glicko','RD','Matches','W','L','D','Win %','Opponents','Avg Opp Rating','Last Match','Status','Old 0-100'], leaderboardRows);
  writeTable_(ss.getSheetByName(TT.ALL_PLAYERS), TT.OUTPUT_HEADER_ROW,
    ['Player','Rating','Glicko','RD','Matches','W','L','D','Win %','Opponents','Avg Opp Rating','Last Match','Days Since','Status','Old 0-100'], allRows);
  writeTable_(ss.getSheetByName(TT.PROVISIONAL), TT.OUTPUT_HEADER_ROW,
    ['Player','Rating','Matches','Opponents','Matches Needed','Opponents Needed','Last Match','Status'], provisionalRows);
  writeTable_(ss.getSheetByName(TT.INACTIVE), TT.OUTPUT_HEADER_ROW,
    ['Player','Rating','Glicko','RD','Matches','Opponents','Last Match','Days Since','Status'], inactiveRows);
  const issueRows = issues.map(r => [r[0],r[1],r[2],r[3]]);
  writeTable_(ss.getSheetByName(TT.ISSUES), TT.OUTPUT_HEADER_ROW,
    ['Sheet','Row','Issue','Details'], issueRows);
  // Friendly number/date formatting.
  const lb = ss.getSheetByName(TT.LEADERBOARD);
  if (leaderboardRows.length) {
    lb.getRange(6,3,leaderboardRows.length,3).setNumberFormat('0.0');
    lb.getRange(6,10,leaderboardRows.length,1).setNumberFormat('0.0%');
    lb.getRange(6,12,leaderboardRows.length,1).setNumberFormat('0.0');
    lb.getRange(6,13,leaderboardRows.length,1).setNumberFormat('yyyy-mm-dd');
  }
  const ap = ss.getSheetByName(TT.ALL_PLAYERS);
  if (allRows.length) {
    ap.getRange(6,2,allRows.length,3).setNumberFormat('0.0');
    ap.getRange(6,9,allRows.length,1).setNumberFormat('0.0%');
    ap.getRange(6,11,allRows.length,1).setNumberFormat('0.0');
    ap.getRange(6,12,allRows.length,1).setNumberFormat('yyyy-mm-dd');
  }
  const now = new Date();
  [TT.LEADERBOARD, TT.ALL_PLAYERS, TT.PROVISIONAL, TT.INACTIVE, TT.ISSUES].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) sh.getRange('A2').setNote('Last automatic refresh: ' + now.toLocaleString());
  });
}

function writeTable_(sheet, headerRow, headers, rows) {
  if (!sheet) throw new Error('Missing output sheet.');
  const needed = headerRow + Math.max(rows.length, 1) + 5;
  if (sheet.getMaxRows() < needed) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  const clearRows = Math.max(sheet.getMaxRows() - headerRow, 1);
  sheet.getRange(headerRow + 1, 1, clearRows, Math.max(headers.length, sheet.getLastColumn())).clearContent();
  sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(headerRow + 1, 1, rows.length, headers.length).setValues(rows);
}

function clean_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function isScore_(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n);
}

function numberOr_(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return stripTime_(v);
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Google Sheets date serial fallback.
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : stripTime_(d);
  }
  const s = clean_(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : stripTime_(d);
}

function stripTime_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween_(a, b) {
  const ms = stripTime_(b).getTime() - stripTime_(a).getTime();
  return Math.floor(ms / 86400000);
}

function round1_(n) {
  return Math.round(Number(n) * 10) / 10;
}

/* ================= TierStats website publishing layer =================
 * Merged from the recovered site template. Worker-first design:
 *   1. This layer NEVER recalculates ratings — it only asks the
 *      tierstats-publish Worker to regenerate data.js + commit it to
 *      Stats4Tanks/stats4tanks.github.io (menu instantly, trigger debounced,
 *      Worker 5-minute cron as backstop).
 *   2. The Worker owns all data.js commits (single-writer rule).
 *   3. Secrets live ONLY in Project Settings -> Script Properties. The only
 *      value you ever set is WORKER_SECRET, and it MUST equal the secret
 *      already configured on the Worker — never invent a new one. No
 *      GITHUB_TOKEN is used anywhere: this layer never writes to GitHub
 *      directly, so no GitHub PAT belongs in the Sheet.
 * TRIGGER STATUS: do NOT run 'Update website now' and do NOT install the
 * auto-sync trigger until Worker control/retarget is confirmed. 'Setup
 * check' is read-only and safe to run at any time. If the Worker cannot
 * be reused, replace pokeWorkerSync_ with an approved direct-push design
 * — do not improvise one here.
 */

const TT_PUB = {
  GITHUB_REPO: 'Stats4Tanks/stats4tanks.github.io',
  GITHUB_BRANCH: 'main',
  WORKER_SYNC_URL: 'https://tierstats-publish.tierstats.workers.dev/sync',
  SYNC_STATUS_URL: 'https://tierstats-publish.tierstats.workers.dev/sync-status',
  // Sheets whose edits can change website data (outputs + engine inputs).
  DATA_SHEETS: ['Settings', 'Aliases', 'Seeds', 'Matches', 'Inactive'],
  // At most one website poke per 2 minutes; the Worker cron covers the rest.
  DEBOUNCE_MS: 2 * 60 * 1000
};

function ttProps_() {
  return PropertiesService.getScriptProperties();
}

function ttPubCfg_(key) {
  return ttProps_().getProperty(key) || TT_PUB[key] || '';
}

/** Menu action: tell the Worker to regenerate data.js + commit NOW. */
function updateWebsiteNow() {
  const res = pokeWorkerSync_();
  const ui = SpreadsheetApp.getUi();
  if (res.ok) {
    ttProps_().setProperty('TT_PUB_LAST_PUSH_MS', String(Date.now()));
    ui.alert('TierStats: website update triggered.\n' + (res.note || 'The Worker is regenerating data.js.'));
  } else {
    ui.alert('TierStats sync failed: ' + res.error + '\nSee Apps Script Executions log.');
  }
  return res;
}

/** Menu action: show Worker sync-status (last publish age, matches, players). */
function checkSyncStatus() {
  const url = ttPubCfg_('SYNC_STATUS_URL');
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(resp.getContentText() || '{}');
    const msg = 'Matches: ' + (data.matches != null ? data.matches : '?') +
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

/** Menu action: verify Script Properties without pushing anything. Read-only. */
function setupCheck() {
  // Worker-first config: the ONLY value you must supply is WORKER_SECRET,
  // and it must equal the secret already configured on the Worker. Set it
  // only once Worker reuse/retarget is confirmed. No GITHUB_TOKEN is used
  // anywhere in this layer.
  const missing = [];
  if (!ttProps_().getProperty('WORKER_SECRET')) {
    missing.push('WORKER_SECRET (must match the Worker secret — set only after Worker reuse is confirmed)');
  }
  const msg = missing.length
    ? 'Missing Script Properties:\n- ' + missing.join('\n- ') + '\n\nWebsite sync stays dormant until this is set; leaderboard recalculation is unaffected.'
    : 'Script Properties look complete.\nRepo: ' + ttPubCfg_('GITHUB_REPO') +
      ' (branch ' + ttPubCfg_('GITHUB_BRANCH') + ').\nDo NOT install the auto-sync trigger or run Update website now until Worker control is confirmed.';
  SpreadsheetApp.getUi().alert('TierStats setup check\n\n' + msg);
  return { ok: missing.length === 0, missing: missing };
}

/** POST {password} to Worker /sync. Returns {ok, note|error}. Never throws. */
function pokeWorkerSync_() {
  const url = ttPubCfg_('WORKER_SYNC_URL');
  const secret = ttProps_().getProperty('WORKER_SECRET') || '';
  if (!url) return { ok: false, error: 'WORKER_SYNC_URL not set in Script Properties.' };
  if (!secret) return { ok: false, error: 'WORKER_SECRET not set in Script Properties.' };
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ password: secret }),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    let data = {};
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

/**
 * Installable onChange entry point for website auto-sync. GATED: install by
 * running ttInstallWebsiteTrigger manually ONLY after Worker control and
 * retarget are confirmed. Debounced: at most one Worker poke per 2 minutes.
 * Rating recalculation is owned by ttRankingOnEdit and is never triggered
 * from here.
 */
function ttWebsiteOnChange(e) {
  let name = '';
  try {
    if (e && e.range) name = e.range.getSheet().getName();
  } catch (err) { /* change types without a range: treat as relevant */ }
  if (name && TT_PUB.DATA_SHEETS.indexOf(name) === -1) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const last = Number(ttProps_().getProperty('TT_PUB_LAST_PUSH_MS') || 0);
    if (Date.now() - last < TT_PUB.DEBOUNCE_MS) return;
    const res = pokeWorkerSync_();
    if (res.ok) ttProps_().setProperty('TT_PUB_LAST_PUSH_MS', String(Date.now()));
    else Logger.log('Website auto-sync skipped: ' + res.error);
  } finally {
    lock.releaseLock();
  }
}

/**
 * GATED: run this ONCE to install website auto-sync, but ONLY after Worker
 * control and retarget are confirmed. Safe to run again: it removes only
 * its own old trigger first. Does not touch the ranking trigger.
 */
function ttInstallWebsiteTrigger() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'ttWebsiteOnChange') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('ttWebsiteOnChange')
    .forSpreadsheet(ss)
    .onChange()
    .create();
  SpreadsheetApp.getUi().alert(
    'TierStats website auto-sync installed. Edits to Matches, Settings, Aliases, Seeds or Inactive trigger a website update (debounced).'
  );
}
