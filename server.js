"use strict";
const http  = require("http");
const https = require("https");
const path  = require("path");
const fs    = require("fs");
const qs    = require("querystring");

const PORT         = process.env.PORT || 3000;
const GAME_MINS    = 120;
const QUARTER_MINS = GAME_MINS / 4;
const HOT_WINDOW_MS   = 5  * 60 * 1000;  // 5-minute hot window
const QUIET_WINDOW_MS = 10 * 60 * 1000;  // 10-minute cold window
const HISTORY_MAX     = 42;              // ~10.5 min of snapshots at 15-sec intervals

// ── Formula ───────────────────────────────────────────────────────────────────
const WEIGHTS = {
  CP:   0.8962150068520374,
  ED:   0.7968879864324794,
  CM:   0.9222372631321538,
  "1%": 0.6398048905259526,
  SI:   0.449900466686957,
  MG:   0.02012467643642767,
  TO:  -0.8690147413415404,
  ITC:  0.45580331941919333,
  G:    4.451968483148417,
  B:   -1.1085983290944166,
  T:    0.770907475619704,
  GA:   0.9998240754615281,
  HO:   0.2635684440920885,
};
const CONSTANT = 5.475487260287346;

function calcRating(value) {
  let raw;
  if      (value <= 0)  raw = 0;
  else if (value <= 20) raw = (value / 20) * 4;
  else if (value <= 35) raw = 4 + ((value - 20) / 15) * 2;
  else if (value <= 50) raw = 6 + ((value - 35) / 15) * 2;
  else if (value <= 70) raw = 8 + ((value - 50) / 20) * 2;
  else                  raw = 10;
  return Math.round(Math.min(10, Math.max(0, raw)) * 2) / 2;
}

// elapsedFrac: how far through the game we are (0–1).
// The constant is scaled to elapsed time so that when the value is projected
// to full-game it correctly resolves to CONSTANT + projected_stats.
function calculateValue(p, elapsedFrac = 1) {
  let v = CONSTANT * elapsedFrac;
  for (const [col, w] of Object.entries(WEIGHTS)) {
    v += (typeof p[col] === "number" ? p[col] : 0) * w;
  }
  return Math.round(v * 100) / 100;
}

// ── Game time ─────────────────────────────────────────────────────────────────
// Model: Q1 end = 30 min, half time = 60 min, Q3 end = 90 min, full time = 120 min.
// The in-quarter clock is capped at QUARTER_MINS so time-on never pushes past a boundary.
function parseGameTime(sb) {
  if (!sb) return null;

  // Break labels (quarter / half / three-quarter / full time)
  const title = (sb.match(/class="tbtitle"[^>]*>([\s\S]*?)<\/td>/i)||[])[1]||"";
  if (/full\s*time/i.test(title) || /final\s*scores?/i.test(title)) return { quarter: 4, elapsedMins: GAME_MINS };
  if (/(?:three|3\w*)[\s-]*quarter\s*time/i.test(title))    return { quarter: 3, elapsedMins: 90 };
  if (/half\s*time/i.test(title))                            return { quarter: 2, elapsedMins: 60 };
  if (/quarter\s*time/i.test(title))                         return { quarter: 1, elapsedMins: 30 };

  // Live in-quarter clock: "2nd Quarter 14:32"
  const m = sb.match(/(\d+)(?:st|nd|rd|th) Quarter\s+(\d+):(\d+)/i);
  if (!m) return null;
  const quarter  = parseInt(m[1], 10);
  const qClock   = parseInt(m[2], 10) + parseInt(m[3], 10) / 60;
  const qElapsed = Math.min(qClock, QUARTER_MINS); // cap so time-on doesn't exceed boundary
  return { quarter, elapsedMins: (quarter - 1) * QUARTER_MINS + qElapsed };
}

function projectValue(val, elapsedMins) {
  if (!elapsedMins || elapsedMins <= 0) return val;
  return Math.round(val * (GAME_MINS / elapsedMins) * 100) / 100;
}

// ── Footywire fetch ───────────────────────────────────────────────────────────
function fetchFootywire(advv, mid) {
  return new Promise((resolve, reject) => {
    const body = qs.stringify({ mid, advv, sby: "" });
    const req  = https.request({
      hostname: "www.footywire.com",
      path:     "/afl/json/json-refresh-live-stats.json",
      method:   "POST",
      timeout:  8000,
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Referer":        `https://www.footywire.com/afl/footy/live_stats?mid=${mid}`,
        "User-Agent":     "Mozilla/5.0",
      },
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        if (!raw.trim().startsWith("{")) {
          reject(new Error(`Footywire returned non-JSON (status ${res.statusCode}): ${raw.slice(0,80)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Footywire request timed out")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── HTML table parsers ────────────────────────────────────────────────────────
function parseTable(html, colMap) {
  const players = {};
  const rowRe   = /<tr[^>]*class="(darkcolor|lightcolor)"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells  = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = cellRe.exec(rowMatch[2])) !== null)
      cells.push(c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim());
    if (cells.length < 10) continue;
    const name = cells[colMap._name];
    if (!name) continue;
    const p = players[name] || (players[name] = { name });
    for (const [stat, idx] of Object.entries(colMap)) {
      if (stat === "_name") continue;
      const num = parseFloat(cells[idx]);
      p[stat] = isNaN(num) ? 0 : num;
    }
  }
  return players;
}

const BASIC_MAP = { _name: 1, G: 6, B: 7, T: 8, HO: 9, GA: 10 };
const ADV_MAP   = { _name: 1, CP: 2, ED: 4, CM: 6, "1%": 8, SI: 12, MG: 13, TO: 14, ITC: 15 };

function mergeTeam(basicHtml, advHtml, teamName) {
  const basic = parseTable(basicHtml, BASIC_MAP);
  const adv   = parseTable(advHtml,   ADV_MAP);
  const names = new Set([...Object.keys(basic), ...Object.keys(adv)]);
  return [...names].map(name => ({
    team: teamName,
    ...(basic[name] || {}),
    ...(adv[name]   || {}),
    name,
  }));
}

// ── Persistent momentum storage ───────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function momentumFile(mid) { return path.join(DATA_DIR, `momentum_${mid}.json`); }
function loadMomentum(mid) {
  try { return JSON.parse(fs.readFileSync(momentumFile(mid), "utf8")); }
  catch { return []; }
}
function saveMomentum(mid, arr) {
  try { fs.writeFileSync(momentumFile(mid), JSON.stringify(arr)); }
  catch (e) { console.error("saveMomentum:", e.message); }
}

// ── Full game data persistence ────────────────────────────────────────────────
function gameFile(mid) { return path.join(DATA_DIR, `game_${mid}.json`); }
function saveGameData(mid, state) {
  try { fs.writeFileSync(gameFile(mid), JSON.stringify(state)); }
  catch (e) { console.error("saveGameData:", e.message); }
}
function loadGameData(mid) {
  try { return JSON.parse(fs.readFileSync(gameFile(mid), "utf8")); }
  catch { return null; }
}
function buildCachedResponse(cached) {
  const summary = {};
  for (const tm of cached.teams || []) {
    const tp  = (cached.players || []).filter(p => p.team === tm);
    const sc  = tm === cached.teams[0] ? cached.score1 : cached.score2;
    summary[tm] = {
      score:        sc ?? null,
      avgRating:    +(tp.reduce((s, p) => s + (p.rating      || 0), 0) / (tp.length || 1)).toFixed(1),
      avgProjected: +(tp.reduce((s, p) => s + (p.projectedValue || 0), 0) / (tp.length || 1)).toFixed(1),
      topPlayer:    tp[0]?.name || "—",
    };
  }
  return {
    inProgress:      false,
    fromCache:       true,
    teams:           cached.teams        || ["Home", "Away"],
    matchInfo:       cached.matchInfo    || "",
    elapsedMins:     cached.elapsedMins,
    quarter:         cached.quarter,
    players:         cached.players      || [],
    hot5: [], quiet5: [], qTop5: [],
    quarterLog:      cached.quarterLog      || {},
    quarterStatLog:  cached.quarterStatLog  || {},
    hotWindowMins:   0,
    quietWindowMins: 0,
    momentum:        cached.momentum     || [],
    scoreEvents:     cached.scoreEvents  || [],
    quarterStartTs:  cached.quarterStartTs || {},
    summary,
    fetchedAt:       new Date().toISOString(),
  };
}

// ── Rolling snapshot history (in-memory) ──────────────────────────────────────
const STAT_KEYS = Object.keys(WEIGHTS);  // all formula stat names

// Each snapshot: { ts, map: { name -> { value, ...stats } } }
const snapshotHistory = [];

function recordSnapshot(players) {
  const snap = { ts: Date.now(), map: {} };
  players.forEach(p => {
    const entry = { value: p.value };
    STAT_KEYS.forEach(k => { entry[k] = typeof p[k] === "number" ? p[k] : 0; });
    snap.map[p.name] = entry;
  });
  snapshotHistory.push(snap);
  if (snapshotHistory.length > HISTORY_MAX) snapshotHistory.shift();
}

function getRefSnapshot(windowMs, minTs = 0) {
  if (snapshotHistory.length === 0) return null;
  const targetTs  = Date.now() - windowMs;
  const inQuarter = snapshotHistory.filter(s => s.ts >= minTs);
  if (inQuarter.length === 0) return null;
  const older = inQuarter.filter(s => s.ts <= targetTs);
  return older.length > 0 ? older[older.length - 1] : inQuarter[0];
}

// Returns the top stat contributions over the window, sorted by value added (desc).
// Each entry: { stat, delta, contribution }
function statContributions(player, refEntry) {
  if (!refEntry) return [];
  return STAT_KEYS
    .map(stat => {
      const cur   = typeof player[stat] === "number" ? player[stat] : 0;
      const prev  = typeof refEntry[stat] === "number" ? refEntry[stat] : 0;
      const delta = cur - prev;
      const contribution = Math.round(delta * WEIGHTS[stat] * 100) / 100;
      return { stat, delta, contribution };
    })
    .filter(x => Math.abs(x.contribution) >= 0.01)  // drop negligible
    .sort((a, b) => b.contribution - a.contribution);
}

// ── Reconstruct a player's per-quarter delta from the fetch log ──────────────
// Used to patch completedQuarters entries that were stored as null (e.g. bench
// players who came on after the quarter baseline was taken).
function inferQDeltaFromLog(name, q) {
  if (!fetchLog.length) return null;
  let cum          = {};   // running cumulative stats for this player
  let statsBeforeQ = null; // snapshot just before quarter q began
  let statsAtQEnd  = null; // snapshot at the last entry inside quarter q
  let inQ          = false;

  for (const entry of fetchLog) {
    if (entry.q === q && !inQ) {
      statsBeforeQ = { ...cum };
      inQ = true;
    } else if (entry.q !== q && inQ) {
      inQ = false;
    }
    for (const action of (entry.actions || [])) {
      if (action.n !== name) continue;
      if (action.v !== undefined) cum._v = action.v;
      STAT_KEYS.forEach(k => { if (action[k] !== undefined) cum[k] = action[k]; });
    }
    if (entry.q === q) statsAtQEnd = { ...cum };
  }

  if (!statsAtQEnd) return null;
  const before = statsBeforeQ || {};
  const delta = { v: Math.round(((statsAtQEnd._v || 0) - (before._v || 0)) * 100) / 100 };
  STAT_KEYS.forEach(k => { delta[k] = (statsAtQEnd[k] || 0) - (before[k] || 0); });
  return delta;
}

// ── Fixture cache ─────────────────────────────────────────────────────────────
let fixtureCache = null; // { ts: Date.now(), rounds: [...] }

// ── State reset on game change ────────────────────────────────────────────────
let activeMid          = null;
let trackedQuarter     = null;
let quarterBaseline    = null;   // { playerName -> value at start of current quarter }
let completedQuarters  = {};     // { 1: {playerName -> delta}, 2: ..., 3: ..., 4: ... }
let quarterStartTs     = {};     // { quarter -> timestamp when first detected }
let lastScores         = {};     // { teamName -> { G: total, B: total } }
let scoreEvents        = [];     // [{ ts, team, type:'G'|'B' }]
let momentumFull       = [];     // [{ ts, t1, t2 }] — full-game history, persisted to disk
let fetchLog           = [];     // timestamped action-diff log (baseline + stat changes only)
let lastFetchState     = {};     // { playerName -> { v, r, tm, ...stats } } — for diffing

// ── Core fetch ────────────────────────────────────────────────────────────────
async function fetchRatings(mid) {
  if (mid !== activeMid) {
    activeMid         = mid;
    const _saved      = loadGameData(mid);
    trackedQuarter    = _saved?.quarter          ?? null;
    quarterBaseline   = _saved?.quarterBaseline  ?? null;
    completedQuarters = _saved?.completedQuarters || {};
    quarterStartTs    = _saved?.quarterStartTs    || {};
    lastScores        = {};
    scoreEvents       = _saved?.scoreEvents       || [];
    momentumFull      = _saved?.momentum          || loadMomentum(mid);
    fetchLog          = _saved?.fetches           || [];
    // Reconstruct lastFetchState by replaying the saved fetch log
    lastFetchState    = {};
    for (const entry of fetchLog) {
      for (const action of (entry.actions || [])) {
        const { n, tm, ...fields } = action;
        if (!lastFetchState[n]) lastFetchState[n] = {};
        if (tm) lastFetchState[n].tm = tm;
        Object.assign(lastFetchState[n], fields);
      }
    }
    // Patch any null completedQuarters entries using the fetch log
    for (const [q, qData] of Object.entries(completedQuarters)) {
      for (const [name, val] of Object.entries(qData)) {
        if (val === null) {
          const inferred = inferQDeltaFromLog(name, parseInt(q));
          if (inferred) qData[name] = inferred;
        }
      }
    }
    snapshotHistory.length = 0;
  }
  const [basicData, advData] = await Promise.all([
    fetchFootywire("N", mid),
    fetchFootywire("Y", mid),
  ]);

  // ── Scoreboard ──────────────────────────────────────────────────────────────
  let team1Name = "Home", team2Name = "Away", matchInfo = "", gameTime = null;
  let score1 = null, score2 = null;

  if (basicData.scoreboard) {
    const sb = basicData.scoreboard;
    const tm = [...sb.matchAll(/class="l(?:d?row|norm)"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/g)];
    if (tm[0]) team1Name = tm[0][1].trim();
    if (tm[1]) team2Name = tm[1][1].trim();

    gameTime = parseGameTime(sb);
    const qm = sb.match(/(\d+(?:st|nd|rd|th) Quarter\s+[\d:]+)/i);
    if (qm) matchInfo = qm[1].trim();
    if (!matchInfo) {
      const h2 = sb.match(/<h2[^>]*>(.*?)<\/h2>/);
      if (h2) matchInfo = h2[1].replace(/<[^>]+>/g, "").trim();
    }
    const sc = [...sb.matchAll(/class="(?:drow|norm)"[^>]*>(\d+)<\/td>/g)];
    if (sc.length >= 2) {
      score1 = parseInt(sc[sc.length - 2][1]);
      score2 = parseInt(sc[sc.length - 1][1]);
      matchInfo += `  ${score1}–${score2}`;
    }
  }

  // ── Players ─────────────────────────────────────────────────────────────────
  const team1 = mergeTeam(basicData.team1, advData.team1, team1Name);
  const team2 = mergeTeam(basicData.team2, advData.team2, team2Name);
  const all   = [...team1, ...team2];

  // No live players — restore from saved game data if available
  if (all.length === 0) {
    const cached = loadGameData(mid);
    if (cached) return buildCachedResponse(cached);
  }

  const el         = gameTime ? gameTime.elapsedMins : null;
  const elapsedFrac = el ? Math.min(el / GAME_MINS, 1) : 1;
  const currentQ   = gameTime ? gameTime.quarter : null;

  all.forEach(p => {
    p.value          = calculateValue(p, elapsedFrac);
    p.projectedValue = el ? projectValue(p.value, el) : p.value;
    p.rating         = calcRating(p.projectedValue);
  });

  // ── 5-min hot delta ───────────────────────────────────────────────────────────
  const qMinTs        = quarterStartTs[currentQ] || 0;
  const hotRef        = getRefSnapshot(HOT_WINDOW_MS, qMinTs);
  const hotWindowMs   = hotRef ? Date.now() - hotRef.ts : 0;
  const hotWindowMins = Math.round(hotWindowMs / 6000) / 10;

  all.forEach(p => {
    const refEntry = hotRef ? (hotRef.map[p.name] ?? null) : null;
    p.delta5min    = refEntry !== null ? Math.round((p.value - refEntry.value) * 100) / 100 : null;
    p.statContribs = statContributions(p, refEntry);
  });

  // ── 10-min cold delta ─────────────────────────────────────────────────────────
  const quietRef      = getRefSnapshot(QUIET_WINDOW_MS, qMinTs);
  const quietWindowMs = quietRef ? Date.now() - quietRef.ts : 0;
  const quietWindowMins = Math.round(quietWindowMs / 6000) / 10;
  const quietWindowFrac = quietWindowMins / GAME_MINS;

  all.forEach(p => {
    const refEntry = quietRef ? (quietRef.map[p.name] ?? null) : null;
    if (refEntry === null || quietWindowMins === 0) {
      p.delta10min    = null;
      p.expectedDelta = null;
      p.quietDelta    = null;
      p.quietStatContribs = [];
      return;
    }
    p.delta10min        = Math.round((p.value - refEntry.value) * 100) / 100;
    p.expectedDelta     = Math.round(p.projectedValue * quietWindowFrac * 100) / 100;
    p.quietDelta        = Math.round((p.delta10min - p.expectedDelta) * 100) / 100;
    p.quietStatContribs = statContributions(p, refEntry);
  });

  // Record snapshot AFTER computing deltas so it doesn't compare to itself
  recordSnapshot(all);

  // ── Quarter value + stat tracking ─────────────────────────────────────────────
  if (currentQ !== null && currentQ !== trackedQuarter) {
    // Quarter changed — save the outgoing quarter's value+stat deltas
    if (trackedQuarter !== null && quarterBaseline !== null) {
      const qData = {};
      all.forEach(p => {
        const base = quarterBaseline[p.name];
        if (base !== undefined) {
          const entry = { v: Math.round((p.value - base.v) * 100) / 100 };
          STAT_KEYS.forEach(k => { entry[k] = (p[k] || 0) - (base[k] || 0); });
          qData[p.name] = entry;
        } else {
          // No baseline — infer from fetch log; zero-baseline as last resort
          const inferred = inferQDeltaFromLog(p.name, trackedQuarter);
          if (inferred) {
            qData[p.name] = inferred;
          } else {
            const entry = { v: Math.round(p.value * 100) / 100 };
            STAT_KEYS.forEach(k => { entry[k] = p[k] || 0; });
            qData[p.name] = entry;
          }
        }
      });
      completedQuarters[trackedQuarter] = qData;
    }
    trackedQuarter           = currentQ;
    quarterStartTs[currentQ] = Date.now();
    snapshotHistory.length   = 0;   // flush hot/cold cache — new quarter starts clean
    quarterBaseline          = {};
    all.forEach(p => {
      quarterBaseline[p.name] = { v: p.value };
      STAT_KEYS.forEach(k => { quarterBaseline[p.name][k] = p[k] || 0; });
    });
  }
  // Helper: extract value from completedQuarters entry (supports old number format)
  function cqv(entry) { return typeof entry === "object" && entry !== null ? entry.v : entry; }

  all.forEach(p => {
    if (quarterBaseline && p.name && !(p.name in quarterBaseline)) {
      // Player came on mid-quarter — seed their baseline now so delta tracks from here
      quarterBaseline[p.name] = { v: p.value };
      STAT_KEYS.forEach(k => { quarterBaseline[p.name][k] = p[k] || 0; });
    }
    const base = quarterBaseline?.[p.name];
    p.quarterDelta = base !== undefined
      ? Math.round((p.value - base.v) * 100) / 100
      : null;
    p.qStatDeltas = {};
    if (base) STAT_KEYS.forEach(k => { p.qStatDeltas[k] = (p[k] || 0) - (base[k] || 0); });
  });
  const qTop5 = [...all]
    .filter(p => p.quarterDelta !== null)
    .sort((a, b) => b.quarterDelta - a.quarterDelta)
    .slice(0, 10)
    .map((p, i) => ({ ...p, qRank: i + 1 }));

  // ── Quarter log: per-player value per quarter ─────────────────────────────────
  const quarterLog = {};
  const quarterStatLog = {};
  all.forEach(p => {
    function cqEntry(q) {
      const e = completedQuarters[q]?.[p.name];
      return e !== undefined ? e : null;
    }
    function liveEntry() { return { v: p.quarterDelta, ...p.qStatDeltas }; }
    quarterLog[p.name] = {
      Q1: completedQuarters[1] ? cqv(cqEntry(1)) : (currentQ === 1 ? p.quarterDelta : null),
      Q2: completedQuarters[2] ? cqv(cqEntry(2)) : (currentQ === 2 ? p.quarterDelta : null),
      Q3: completedQuarters[3] ? cqv(cqEntry(3)) : (currentQ === 3 ? p.quarterDelta : null),
      Q4: completedQuarters[4] ? cqv(cqEntry(4)) : (currentQ === 4 ? p.quarterDelta : null),
    };
    quarterStatLog[p.name] = {
      Q1: completedQuarters[1] ? cqEntry(1) : (currentQ === 1 ? liveEntry() : null),
      Q2: completedQuarters[2] ? cqEntry(2) : (currentQ === 2 ? liveEntry() : null),
      Q3: completedQuarters[3] ? cqEntry(3) : (currentQ === 3 ? liveEntry() : null),
      Q4: completedQuarters[4] ? cqEntry(4) : (currentQ === 4 ? liveEntry() : null),
    };
  });

  // ── Sort & rank ──────────────────────────────────────────────────────────────
  all.sort((a, b) => b.projectedValue - a.projectedValue);
  all.forEach((p, i) => { p.rank = i + 1; });

  // ── Hot 5 (biggest positive delta5min) ───────────────────────────────────────
  const hot5 = [...all]
    .filter(p => p.delta5min !== null)
    .sort((a, b) => b.delta5min - a.delta5min)
    .slice(0, 10)
    .map((p, i) => ({ ...p, hotRank: i + 1 }));

  // ── Quiet 10 (biggest negative quietDelta — most underperforming their pace) ──
  const quiet5 = [...all]
    .filter(p => p.quietDelta !== null)
    .sort((a, b) => a.quietDelta - b.quietDelta)
    .slice(0, 10)
    .map((p, i) => ({ ...p, quietRank: i + 1 }));

  // ── Momentum: append current totals to full-game timeline ───────────────────
  if (all.length > 0) {
    const t1Total = all.filter(p => p.team === team1Name).reduce((s, p) => s + p.value, 0);
    const t2Total = all.filter(p => p.team === team2Name).reduce((s, p) => s + p.value, 0);
    momentumFull.push({ ts: Date.now(), t1: +t1Total.toFixed(2), t2: +t2Total.toFixed(2) });
    saveMomentum(activeMid, momentumFull);
  }
  const momentum = momentumFull;

  // ── Score event detection ────────────────────────────────────────────────────
  const now = Date.now();
  for (const [teamName, players] of [[team1Name, team1], [team2Name, team2]]) {
    const totalG = players.reduce((s, p) => s + (p.G || 0), 0);
    const totalB = players.reduce((s, p) => s + (p.B || 0), 0);
    const prev = lastScores[teamName];
    if (prev) {
      const dG = Math.max(0, totalG - prev.G);
      const dB = Math.max(0, totalB - prev.B);
      for (let i = 0; i < dG; i++) scoreEvents.push({ ts: now, team: teamName, type: 'G' });
      for (let i = 0; i < dB; i++) scoreEvents.push({ ts: now, team: teamName, type: 'B' });
    }
    lastScores[teamName] = { G: totalG, B: totalB };
  }
  if (scoreEvents.length > 400) scoreEvents.splice(0, scoreEvents.length - 400);

  // ── Team summary ─────────────────────────────────────────────────────────────
  const summary = {};
  for (const tm of [team1Name, team2Name]) {
    const tp = all.filter(p => p.team === tm);
    summary[tm] = {
      score:        tm === team1Name ? score1 : score2,
      avgRating:    +(tp.reduce((s, p) => s + p.rating,         0) / (tp.length || 1)).toFixed(1),
      avgProjected: +(tp.reduce((s, p) => s + p.projectedValue, 0) / (tp.length || 1)).toFixed(1),
      topPlayer:    tp[0] ? tp[0].name : "—",
    };
  }

  // ── Persist game state to disk ────────────────────────────────────────────────
  if (all.length > 0) {
    // Build action diff — only record players whose stats changed
    const isBaseline = fetchLog.length === 0 || Object.keys(lastFetchState).length === 0;
    const actions    = [];
    all.forEach(p => {
      const prev  = lastFetchState[p.name];
      const newV  = +p.value.toFixed(2);
      const newR  = p.rating;
      if (!prev || isBaseline) {
        // First time — full snapshot for this player
        const entry = { n: p.name, tm: p.team, v: newV, r: newR };
        STAT_KEYS.forEach(k => { if (p[k]) entry[k] = p[k]; });
        actions.push(entry);
      } else {
        // Delta — record changed stats; always include v and r for time-series
        const changed = {};
        STAT_KEYS.forEach(k => {
          const cur = p[k] || 0;
          if (cur !== (prev[k] || 0)) changed[k] = cur;
        });
        actions.push({ n: p.name, ...changed, v: newV, r: newR });
      }
      // Update diff baseline
      lastFetchState[p.name] = { v: newV, r: newR, tm: p.team };
      STAT_KEYS.forEach(k => { lastFetchState[p.name][k] = p[k] || 0; });
    });

    // Always record every 15-second fetch for a complete time-series
    fetchLog.push({
      ts:  Date.now(),
      iso: new Date().toISOString(),
      q:   currentQ,
      t:   el,
      s1:  score1,
      s2:  score2,
      ...(isBaseline ? { baseline: true } : {}),
      actions,
    });

    saveGameData(activeMid, {
      teams: [team1Name, team2Name],
      matchInfo, elapsedMins: el, quarter: currentQ,
      score1, score2,
      players: all.map(p => {
        const s = { name: p.name, team: p.team, rank: p.rank, value: p.value,
          projectedValue: p.projectedValue, rating: p.rating, quarterDelta: p.quarterDelta };
        STAT_KEYS.forEach(k => { s[k] = p[k] || 0; });
        return s;
      }),
      quarterLog,
      quarterStatLog,
      momentum:    momentumFull,
      scoreEvents,
      completedQuarters,
      quarterBaseline,
      quarterStartTs,
      fetches:     fetchLog,
      savedAt:     new Date().toISOString(),
    });
  }

  return {
    inProgress:     basicData.inProgress === "Y",
    teams:          [team1Name, team2Name],
    matchInfo,
    elapsedMins:    el,
    quarter:        gameTime ? gameTime.quarter : null,
    players:        all,
    hot5,
    quiet5,
    qTop5,
    quarterLog,
    quarterStatLog,
    quarterStartTs,
    scoreEvents,
    hotWindowMins:   hotWindowMins,
    quietWindowMins: quietWindowMins,
    momentum,
    summary,
    fetchedAt:       new Date().toISOString(),
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, "index.html");

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  if (parsed.pathname === "/api/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
    return;
  }
  if (parsed.pathname === "/api/probe") {
    const mid = parsed.searchParams.get("mid");
    if (!mid) { res.writeHead(400); res.end('{"error":"mid required"}'); return; }
    try {
      const data = await fetchFootywire("N", mid);
      const t1 = parseTable(data.team1 || "", BASIC_MAP);
      const t2 = parseTable(data.team2 || "", BASIC_MAP);
      const count = Object.keys(t1).length + Object.keys(t2).length;
      // Extract team names from scoreboard
      let teams = [];
      if (data.scoreboard) {
        const tm = [...data.scoreboard.matchAll(/class="l(?:d?row|norm)"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/g)];
        teams = tm.map(m => m[1].trim()).filter(Boolean);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: count > 0, players: count, teams }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: false, error: e.message }));
    }
    return;
  }
  if (parsed.pathname === "/api/fixture") {
    try {
      const now = Date.now();
      if (!fixtureCache || now - fixtureCache.ts > 3600000) {
        const raw = await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: "api.squiggle.com.au",
            path: "/?q=games;year=2026",
            method: "GET",
            timeout: 10000,
            headers: { "User-Agent": "AFL-Live-Ratings/1.0 (contact: github.com/afl-live)" },
          }, res2 => {
            let d = "";
            res2.on("data", c => d += c);
            res2.on("end", () => {
              if (!d.trim().startsWith("{")) { reject(new Error(`Squiggle returned non-JSON (HTTP ${res2.statusCode}): ${d.slice(0,120)}`)); return; }
              try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
            });
          });
          r.on("timeout", () => { r.destroy(); reject(new Error("Squiggle timeout")); });
          r.on("error", reject);
          r.end();
        });
        // Convert an Australian Eastern time string to a UTC ms timestamp.
        // Squiggle dates have no tz info: "2026-03-29 14:30:00" means AEST/AEDT local time.
        // AEDT = UTC+11 (Oct–Apr),  AEST = UTC+10 (Apr–Oct).
        function aestToUtcMs(dateStr) {
          if (!dateStr) return null;
          const month = parseInt(dateStr.slice(5, 7), 10);
          const offsetH = (month <= 3 || month >= 10) ? 11 : 10; // AEDT vs AEST
          const utcMs = new Date(dateStr.replace(" ", "T") + "Z").getTime();
          return isNaN(utcMs) ? null : utcMs - offsetH * 3600000;
        }

        // Group by round, add fw_id and UTC timestamp
        const rounds = {};
        for (const g of (raw.games || [])) {
          const fw_id = g.id - 27089;
          const key = g.round === 0 ? "Opening Round" : `Round ${g.round}`;
          if (!rounds[key]) rounds[key] = { roundNum: g.round, roundName: g.roundname || key, games: [] };
          rounds[key].games.push({
            fw_id, squiggle_id: g.id,
            round: g.round, roundName: g.roundname || key,
            hteam: g.hteam, ateam: g.ateam,
            hscore: g.hscore, ascore: g.ascore,
            hgoals: g.hgoalshots ? Math.floor(g.hgoalshots) : null,
            hbehinds: g.hbehinds ?? null,
            agoals: g.agoalshots ? Math.floor(g.agoalshots) : null,
            abehinds: g.abehinds ?? null,
            date: g.date, dateTs: aestToUtcMs(g.date),
            venue: g.venue,
            complete: g.complete, timestr: g.timestr || "",
          });
        }
        // Sort rounds by roundNum
        const sorted = Object.values(rounds).sort((a, b) => a.roundNum - b.roundNum);
        fixtureCache = { ts: now, rounds: sorted };
      }
      // Return { serverNow, rounds } so the client can calibrate its clock offset
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ serverNow: Date.now(), rounds: fixtureCache.rounds }));
    } catch (e) {
      console.error("[fixture]", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (parsed.pathname === "/api/download") {
    const mid = parsed.searchParams.get("mid");
    const file = mid ? gameFile(mid) : null;
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No saved data for this game" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="afl_game_${mid}.json"`,
    });
    res.end(fs.readFileSync(file));
    return;
  }
  if (parsed.pathname === "/api/ratings") {
    const mid = parsed.searchParams.get("mid");
    console.log(`[${new Date().toLocaleTimeString()}] /api/ratings mid=${mid}`);
    if (!mid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mid parameter required" }));
      return;
    }
    try {
      const data = await fetchRatings(mid);
      console.log(`  → OK  teams=${data.teams}  players=${data.players.length}`);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error(`  → ERR ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  try {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(HTML_PATH, "utf8"));
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(PORT, () => console.log(`AFL Live Ratings → http://localhost:${PORT}`));
