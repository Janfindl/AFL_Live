"use strict";
// v2026-04-04
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
const BURST_WINDOW_MS = 10 * 60 * 1000;  // 10-minute burst window
const BURST_THRESHOLD = 10;              // min value gain to qualify as a burst
const HISTORY_MAX     = 42;              // ~10.5 min of snapshots at 15-sec intervals

// ── Formula ───────────────────────────────────────────────────────────────────
const WEIGHTS = {
  CP:   0.970085,
  ED:   0.644891,
  CM:   0.693636,
  "1%": 0.636595,
  SI:   0.404205,
  MG:   0.018249,
  TO:  -0.279263,
  ITC:  0.398164,
  G:    4.089152,
  B:   -1.444759,
  T:    0.712906,
  GA:   1.012134,
  HO:   0.251832,
  CG:  -1.124769,
};
const CONSTANT = 9.257290;

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
  if (/full\s*time/i.test(title) || /final\s*scores?/i.test(title)) return { quarter: 4, elapsedMins: GAME_MINS, isFullTime: true };
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

// Projected value = accrued + 30 × fraction of game remaining.
// The 30 is a deliberate prior representing a ~5.0 midpoint rating floor.
// It decays to zero by full time, letting real accumulated stats take over.
// e.g. at half time: accrued + 30 × 0.5 = accrued + 15
function projectValue(val, elapsedMins) {
  const fracRemaining = elapsedMins >= GAME_MINS ? 0
    : Math.max(0, (GAME_MINS - (elapsedMins || 0)) / GAME_MINS);
  return Math.round((val + 30 * fracRemaining) * 100) / 100;
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

const BASIC_MAP = { _name: 1, G: 6, B: 7, T: 8, HO: 9, GA: 10, CG: 13, FF: 15, FA: 16 };
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

// ── Persistent storage ────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function momentumFile(mid) { return path.join(DATA_DIR, `momentum_${mid}.json`); }
function loadMomentum(mid) {
  try { return JSON.parse(fs.readFileSync(momentumFile(mid), "utf8")); }
  catch { return []; }
}
function saveMomentum(mid, arr) {
  try { fs.writeFileSync(momentumFile(mid), JSON.stringify(arr)); }
  catch (e) { console.error("saveMomentum:", e.message); }
}

function gameFile(mid) { return path.join(DATA_DIR, `game_${mid}.json`); }
function loadGameData(mid) {
  try { return JSON.parse(fs.readFileSync(gameFile(mid), "utf8")); }
  catch { return null; }
}

// ── GitHub-backed cloud persistence ──────────────────────────────────────────
// Set GITHUB_TOKEN (PAT with contents:write) and GITHUB_REPO (owner/repo) on
// Railway to survive redeployments without a persistent volume.
//
// Flow:
//  • Boot  → pull any game_*.json / momentum_*.json missing from DATA_DIR
//  • Save  → write locally, schedule a GitHub push (debounced to 5 min)
//  • Full time detected → push to GitHub immediately (5-second delay)
//
const GH_TOKEN = process.env.GITHUB_TOKEN || null;
const GH_REPO  = process.env.GITHUB_REPO  || null;   // "owner/repo"
const GH_BRANCH = process.env.GITHUB_DATA_BRANCH || "master";

const ghShaCache  = new Map();   // repoPath -> last known SHA
const ghPushQueue = new Map();   // mid -> timeout handle

function ghRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.github.com",
      path:     apiPath,
      method,
      timeout:  12000,
      headers: {
        "Authorization":        `Bearer ${GH_TOKEN}`,
        "User-Agent":           "AFL-Live-Ratings/1.0",
        "Accept":               "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload ? {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        } : {}),
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("GitHub timeout")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ghPutFile(repoPath, buf) {
  const content = buf.toString("base64");
  const sha     = ghShaCache.get(repoPath);
  const r = await ghRequest("PUT",
    `/repos/${GH_REPO}/contents/${repoPath}`,
    { message: `data: ${repoPath}`, content, branch: GH_BRANCH, ...(sha ? { sha } : {}) }
  );
  if (r.status === 409 || r.status === 422) {
    // SHA stale — fetch current SHA and retry once
    const g = await ghRequest("GET", `/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`);
    if (g.body?.sha) {
      ghShaCache.set(repoPath, g.body.sha);
      return ghPutFile(repoPath, buf);
    }
  }
  if (r.status >= 400) throw new Error(`GitHub PUT ${repoPath}: HTTP ${r.status}`);
  if (r.body?.content?.sha) ghShaCache.set(repoPath, r.body.content.sha);
}

async function ghGetFile(repoPath) {
  const r = await ghRequest("GET", `/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`);
  if (r.status !== 200 || !r.body?.content) return null;
  ghShaCache.set(repoPath, r.body.sha);
  return Buffer.from(r.body.content.replace(/\n/g, ""), "base64");
}

async function ghListDataDir() {
  const r = await ghRequest("GET", `/repos/${GH_REPO}/contents/data?ref=${GH_BRANCH}`);
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body.filter(f => f.type === "file").map(f => f.name);
}

// On boot: download any game/momentum files not already in DATA_DIR
async function syncFromGitHub() {
  if (!GH_TOKEN || !GH_REPO) return;
  console.log("[github] syncing data files from GitHub…");
  let names;
  try { names = await ghListDataDir(); }
  catch (e) { console.error("[github] list failed:", e.message); return; }

  for (const name of names) {
    if (!/^(game|momentum)_\d+\.json$/.test(name)) continue;
    const local = path.join(DATA_DIR, name);
    if (fs.existsSync(local)) continue;
    try {
      const buf = await ghGetFile(`data/${name}`);
      if (buf) { fs.writeFileSync(local, buf); console.log(`[github] pulled  ${name}`); }
    } catch (e) { console.error(`[github] pull ${name}:`, e.message); }
  }
  console.log("[github] sync complete");
}

// Push a game's files to GitHub (called after writes, debounced per mid)
async function ghPushGame(mid) {
  const gf = gameFile(mid);
  const mf = momentumFile(mid);
  if (fs.existsSync(gf)) await ghPutFile(`data/game_${mid}.json`,     fs.readFileSync(gf));
  if (fs.existsSync(mf)) await ghPutFile(`data/momentum_${mid}.json`, fs.readFileSync(mf));
  console.log(`[github] pushed  game_${mid}.json`);
}

function scheduleGhPush(mid, urgent = false) {
  if (!GH_TOKEN || !GH_REPO) return;
  if (ghPushQueue.has(mid)) clearTimeout(ghPushQueue.get(mid));
  const delay = urgent ? 5000 : 60 * 1000;  // 5 s for game-end, 1 min otherwise
  ghPushQueue.set(mid, setTimeout(() => {
    ghPushQueue.delete(mid);
    ghPushGame(mid).catch(e => console.error(`[github] push mid=${mid}:`, e.message));
  }, delay));
}

// On SIGTERM (Railway redeploy/shutdown), flush all pending GitHub pushes before exiting
// so in-progress game data is never lost when a new deploy is triggered.
// All games are pushed in parallel and the whole flush is capped at 20s so we
// always finish within Railway's 30s SIGTERM grace window.
async function flushAndExit() {
  const pending = [...ghPushQueue.keys()];
  if (pending.length > 0) {
    console.log(`[github] SIGTERM — flushing ${pending.length} pending push(es) in parallel...`);
    for (const mid of pending) { clearTimeout(ghPushQueue.get(mid)); ghPushQueue.delete(mid); }
    const timeout = new Promise(r => setTimeout(r, 20000));
    await Promise.race([
      Promise.allSettled(pending.map(mid =>
        ghPushGame(mid).catch(e => console.error(`[github] flush push mid=${mid}: ${e.message}`))
      )),
      timeout,
    ]);
  }
  process.exit(0);
}
process.on("SIGTERM", flushAndExit);
process.on("SIGINT",  flushAndExit);

// ── saveGameData: write locally + schedule GitHub push ────────────────────────
function saveGameData(mid, state) {
  try { fs.writeFileSync(gameFile(mid), JSON.stringify(state)); }
  catch (e) { console.error("saveGameData:", e.message); }
  const isFullTime    = (state.elapsedMins ?? 0) >= GAME_MINS;
  const completedQs   = Object.keys(state.completedQuarters || {}).length;
  const prevCompletedQs = _prevCompletedQuarters.get(mid) || 0;
  const isQuarterEnd  = completedQs > prevCompletedQs;
  _prevCompletedQuarters.set(mid, completedQs);
  scheduleGhPush(mid, isFullTime || isQuarterEnd);
}
const _prevCompletedQuarters = new Map(); // mid -> number of completed quarters last push
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
  // Re-apply modified projected value (saved files may pre-date this calculation)
  applyModProjectedValue(cached.players || [], cached.completedQuarters || {});

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
    bursts:          computeBursts(cached.fetches || []),
    summary,
    fetchedAt:       new Date().toISOString(),
  };
}

// ── Rolling snapshot history (in-memory, per-game) ───────────────────────────
const STAT_KEYS = Object.keys(WEIGHTS);  // all formula stat names

// Each snapshot: { ts, map: { name -> { value, ...stats } } }
function recordSnapshot(players, snapshotHistory) {
  const snap = { ts: Date.now(), map: {} };
  players.forEach(p => {
    const entry = { value: p.value };
    STAT_KEYS.forEach(k => { entry[k] = typeof p[k] === "number" ? p[k] : 0; });
    snap.map[p.name] = entry;
  });
  snapshotHistory.push(snap);
  if (snapshotHistory.length > HISTORY_MAX) snapshotHistory.shift();
}

function getRefSnapshot(windowMs, minTs = 0, snapshotHistory) {
  if (snapshotHistory.length === 0) return null;
  const targetTs  = Date.now() - windowMs;
  const inQuarter = snapshotHistory.filter(s => s.ts >= minTs);
  if (inQuarter.length === 0) return null;
  const older = inQuarter.filter(s => s.ts <= targetTs);
  return older.length > 0 ? older[older.length - 1] : inQuarter[0];
}

// ── Burst detection ───────────────────────────────────────────────────────────
// Scans the fetch log for any 15-minute window where a player gained 20+ value.
// Returns non-overlapping bursts per player, sorted by gain descending.
function computeBursts(fetchLog) {
  // Rebuild per-player value + cumulative stat time series from the fetch log.
  const playerMap   = new Map(); // name -> { team, series: [{ts, value, q, stats}] }
  const runningStats = new Map(); // name -> current cumulative stats

  for (const entry of (fetchLog || [])) {
    for (const action of (entry.actions || [])) {
      if (action.v === undefined) continue;
      const name = action.n;
      if (!playerMap.has(name)) playerMap.set(name, { team: null, series: [] });
      const ps = playerMap.get(name);
      if (action.tm) ps.team = action.tm;

      // Maintain running cumulative stats (fetchLog stores only changed fields after baseline)
      if (!runningStats.has(name)) runningStats.set(name, {});
      const cur = runningStats.get(name);
      STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });

      ps.series.push({ ts: entry.ts, value: action.v, q: entry.q, stats: { ...cur } });
    }
  }

  const allBursts = [];

  for (const [name, { team, series }] of playerMap) {
    if (series.length < 2) continue;

    // Greedy left-to-right scan: find earliest burst, then skip past it.
    let nextAllowedIdx = 0;

    for (let i = 0; i < series.length; i++) {
      if (i < nextAllowedIdx) continue;

      const startTs  = series[i].ts;
      const startVal = series[i].value;
      const winEnd   = startTs + BURST_WINDOW_MS;

      let bestGain   = 0;
      let bestEndIdx = -1;

      for (let j = i + 1; j < series.length; j++) {
        if (series[j].ts > winEnd) break;
        const gain = series[j].value - startVal;
        if (gain > bestGain) { bestGain = gain; bestEndIdx = j; }
      }

      if (bestGain >= BURST_THRESHOLD) {
        const startStats = series[i].stats;
        const endStats   = series[bestEndIdx].stats;
        const statContribs = STAT_KEYS
          .map(stat => {
            const delta        = (endStats[stat] || 0) - (startStats[stat] || 0);
            const contribution = Math.round(delta * WEIGHTS[stat] * 100) / 100;
            return { stat, delta, contribution };
          })
          .filter(x => Math.abs(x.contribution) >= 0.01)
          .sort((a, b) => b.contribution - a.contribution);

        allBursts.push({
          name,
          team,
          startTs,
          endTs:       series[bestEndIdx].ts,
          gain:        Math.round(bestGain * 100) / 100,
          quarter:     series[i].q,
          statContribs,
        });
        nextAllowedIdx = bestEndIdx + 1;
        i = bestEndIdx;
      }
    }
  }

  // Sort chronologically — earliest burst first
  allBursts.sort((a, b) => a.startTs - b.startTs);
  return allBursts;
}

// ── Modified projected value ──────────────────────────────────────────────────
// modPV = PV + max(0, bestQ - avgQ)
//
// avgQ = PV / 4  (expected value per quarter at the current projection)
// bestQ = highest value scored in any observable quarter:
//         completed quarters (from completedQuarters map) + current live quarter (quarterDelta)
//
// Mutates p.projectedValue and p.rating in-place.
function applyModProjectedValue(players, completedQuarters) {
  players.forEach(p => {
    // Collect all observable quarter values
    const qVals = Object.values(completedQuarters || {})
      .map(qData => {
        const entry = qData[p.name];
        if (entry == null) return null;
        return typeof entry === "object" ? (entry.v ?? null) : entry;
      })
      .filter(v => v !== null && isFinite(v));

    // Also include the current live quarter's accrued value
    if (p.quarterDelta !== null && p.quarterDelta !== undefined && isFinite(p.quarterDelta)) {
      qVals.push(p.quarterDelta);
    }

    if (qVals.length === 0) return; // no quarter data yet (early Q1)

    const avgQ     = p.projectedValue / 4;
    const maxQ     = Math.max(...qVals);
    const qmxDelta = Math.max(0, maxQ - avgQ);
    if (qmxDelta <= 0) return;

    p.projectedValue = Math.round((p.projectedValue + qmxDelta) * 100) / 100;
    p.rating         = calcRating(p.projectedValue);
  });
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
function inferQDeltaFromLog(name, q, fetchLog) {
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

// ── Per-game state ────────────────────────────────────────────────────────────
// All mutable game state is stored per mid so concurrent fetchRatings calls
// (background recorder + user requests) never corrupt each other.
const gameStates = new Map(); // mid -> GameState

function getState(mid) {
  if (gameStates.has(mid)) return gameStates.get(mid);
  const saved = loadGameData(mid);
  const state = {
    trackedQuarter:    saved?.quarter          ?? null,
    quarterBaseline:   saved?.quarterBaseline  ?? null,
    completedQuarters: saved?.completedQuarters || {},
    quarterStartTs:    saved?.quarterStartTs    || {},
    lastScores:        {},
    scoreEvents:       saved?.scoreEvents       || [],
    momentumFull:      saved?.momentum          || loadMomentum(mid),
    fetchLog:          saved?.fetches           || [],
    lastFetchState:    {},
    snapshotHistory:   [],   // rolling snapshots for hot/cold deltas (in-memory only)
    fullTimeTs:        saved?.fullTimeTs        ?? null,  // timestamp of first full-time detection
    burstCache:        { ts: 0, bursts: [] },             // recomputed every 2 min (in-memory only)
  };
  // Rebuild lastFetchState by replaying the saved fetch log
  for (const entry of state.fetchLog) {
    for (const action of (entry.actions || [])) {
      const { n, tm, ...fields } = action;
      if (!state.lastFetchState[n]) state.lastFetchState[n] = {};
      if (tm) state.lastFetchState[n].tm = tm;
      Object.assign(state.lastFetchState[n], fields);
    }
  }
  // Rebuild snapshotHistory from fetch log so hot/cold works immediately on load
  if (state.fetchLog.length > 0) {
    const running = new Map(); // name -> { value, ...stats }
    const rawSnaps = [];
    for (const logEntry of state.fetchLog) {
      for (const action of (logEntry.actions || [])) {
        const name = action.n;
        if (!running.has(name)) running.set(name, {});
        const cur = running.get(name);
        if (action.tm) cur.tm = action.tm;
        if (typeof action.v === "number") cur.value = action.v;
        STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });
      }
      if (running.size > 0) {
        const snap = { ts: logEntry.ts, map: {} };
        for (const [name, p] of running) {
          if (typeof p.value === "number") {
            const s = { value: p.value };
            STAT_KEYS.forEach(k => { s[k] = typeof p[k] === "number" ? p[k] : 0; });
            snap.map[name] = s;
          }
        }
        rawSnaps.push(snap);
      }
    }
    state.snapshotHistory = rawSnaps.slice(-HISTORY_MAX);

    // Rebuild quarterBaseline from fetchLog so quarterDelta is correct after restarts.
    // Replay the log to find where the current tracked quarter starts, and capture
    // the cumulative player stats just before that point as the baseline.
    if (state.trackedQuarter !== null) {
      const q        = state.trackedQuarter;
      const runningQ = new Map(); // name -> { _v, ...stats }
      let   baseline = null;

      for (const logEntry of state.fetchLog) {
        // First entry in this quarter — freeze current cumulative state as baseline
        if (logEntry.q === q && baseline === null) {
          baseline = {};
          for (const [name, cur] of runningQ) {
            baseline[name] = { v: cur._v || 0 };
            STAT_KEYS.forEach(k => { baseline[name][k] = cur[k] || 0; });
          }
        }
        for (const action of (logEntry.actions || [])) {
          const name = action.n;
          if (!runningQ.has(name)) runningQ.set(name, {});
          const cur = runningQ.get(name);
          if (typeof action.v === "number") cur._v = action.v;
          STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });
        }
      }

      if (baseline !== null) state.quarterBaseline = baseline;
    }
  }
  // Patch any null completedQuarters entries using the fetch log
  for (const [q, qData] of Object.entries(state.completedQuarters)) {
    for (const [name, val] of Object.entries(qData)) {
      if (val === null) {
        const inferred = inferQDeltaFromLog(name, parseInt(q), state.fetchLog);
        if (inferred) qData[name] = inferred;
      }
    }
  }
  gameStates.set(mid, state);
  return state;
}

// ── Core fetch ────────────────────────────────────────────────────────────────
async function fetchRatings(mid) {
  const state = getState(mid);
  const {
    snapshotHistory,
  } = state;
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
    p.value             = calculateValue(p, elapsedFrac);
    const rawPv         = el ? projectValue(p.value, el) : p.value;
    const fracElapsed   = el ? Math.min(el / GAME_MINS, 1) : 1;
    // prevProjectedValue = accrued × 1/(1 - fracRemaining) = accrued / fracElapsed
    const prevPv        = fracElapsed > 0 ? p.value / fracElapsed : rawPv;
    p.projectedValue    = Math.round((rawPv + prevPv) / 2 * 100) / 100;
    p.rating            = calcRating(p.projectedValue);
  });

  // ── 5-min hot delta ───────────────────────────────────────────────────────────
  const hotRef        = getRefSnapshot(HOT_WINDOW_MS, 0, snapshotHistory);
  const hotWindowMs   = hotRef ? Date.now() - hotRef.ts : 0;
  const hotWindowMins = Math.round(hotWindowMs / 6000) / 10;

  all.forEach(p => {
    const refEntry = hotRef ? (hotRef.map[p.name] ?? null) : null;
    p.delta5min    = refEntry !== null ? Math.round((p.value - refEntry.value) * 100) / 100 : null;
    p.statContribs = statContributions(p, refEntry);
  });

  // ── 10-min cold delta ─────────────────────────────────────────────────────────
  const quietRef      = getRefSnapshot(QUIET_WINDOW_MS, 0, snapshotHistory);
  const quietWindowMs = quietRef ? Date.now() - quietRef.ts : 0;
  const quietWindowMins = Math.round(quietWindowMs / 6000) / 10;
  const quietWindowFrac = quietWindowMins / GAME_MINS;

  // ── Stat-correction detection ─────────────────────────────────────────────────
  // First time full time is detected: record everything normally and stamp the time.
  // All subsequent full-time fetches are stat corrections — player totals are updated
  // but the timeline (momentum, snapshots, score events) is frozen at the final whistle.
  const isFullTimeNow = gameTime?.isFullTime === true;
  if (isFullTimeNow && state.fullTimeTs === null) {
    state.fullTimeTs = Date.now();
  }
  const isStatCorrection = isFullTimeNow && state.fullTimeTs !== null
    && Date.now() - state.fullTimeTs > 5000;  // >5s after first full-time detection

  all.forEach(p => {
    const refEntry = quietRef ? (quietRef.map[p.name] ?? null) : null;
    if (isStatCorrection || refEntry === null || quietWindowMins === 0) {
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

  // Record snapshot only during live play (not stat corrections)
  if (!isStatCorrection) recordSnapshot(all, snapshotHistory);

  // ── Quarter value + stat tracking ─────────────────────────────────────────────
  if (currentQ !== null && currentQ !== state.trackedQuarter) {
    // Quarter changed — save the outgoing quarter's value+stat deltas
    if (state.trackedQuarter !== null && state.quarterBaseline !== null) {
      const qData = {};
      all.forEach(p => {
        const base = state.quarterBaseline[p.name];
        if (base !== undefined) {
          const entry = { v: Math.round((p.value - base.v) * 100) / 100 };
          STAT_KEYS.forEach(k => { entry[k] = (p[k] || 0) - (base[k] || 0); });
          qData[p.name] = entry;
        } else {
          const inferred = inferQDeltaFromLog(p.name, state.trackedQuarter, state.fetchLog);
          if (inferred) {
            qData[p.name] = inferred;
          } else {
            const entry = { v: Math.round(p.value * 100) / 100 };
            STAT_KEYS.forEach(k => { entry[k] = p[k] || 0; });
            qData[p.name] = entry;
          }
        }
      });
      state.completedQuarters[state.trackedQuarter] = qData;
    }
    state.trackedQuarter              = currentQ;
    state.quarterStartTs[currentQ]    = Date.now();
    state.quarterBaseline             = {};
    all.forEach(p => {
      state.quarterBaseline[p.name] = { v: p.value };
      STAT_KEYS.forEach(k => { state.quarterBaseline[p.name][k] = p[k] || 0; });
    });
  }
  // Helper: extract value from completedQuarters entry (supports old number format)
  function cqv(entry) { return typeof entry === "object" && entry !== null ? entry.v : entry; }

  all.forEach(p => {
    if (state.quarterBaseline && p.name && !(p.name in state.quarterBaseline)) {
      state.quarterBaseline[p.name] = { v: p.value };
      STAT_KEYS.forEach(k => { state.quarterBaseline[p.name][k] = p[k] || 0; });
    }
    const base = state.quarterBaseline?.[p.name];
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
      const e = state.completedQuarters[q]?.[p.name];
      return e !== undefined ? e : null;
    }
    function liveEntry() { return { v: p.quarterDelta, ...p.qStatDeltas }; }
    quarterLog[p.name] = {
      Q1: state.completedQuarters[1] ? cqv(cqEntry(1)) : (currentQ === 1 ? p.quarterDelta : null),
      Q2: state.completedQuarters[2] ? cqv(cqEntry(2)) : (currentQ === 2 ? p.quarterDelta : null),
      Q3: state.completedQuarters[3] ? cqv(cqEntry(3)) : (currentQ === 3 ? p.quarterDelta : null),
      Q4: state.completedQuarters[4] ? cqv(cqEntry(4)) : (currentQ === 4 ? p.quarterDelta : null),
    };
    quarterStatLog[p.name] = {
      Q1: state.completedQuarters[1] ? cqEntry(1) : (currentQ === 1 ? liveEntry() : null),
      Q2: state.completedQuarters[2] ? cqEntry(2) : (currentQ === 2 ? liveEntry() : null),
      Q3: state.completedQuarters[3] ? cqEntry(3) : (currentQ === 3 ? liveEntry() : null),
      Q4: state.completedQuarters[4] ? cqEntry(4) : (currentQ === 4 ? liveEntry() : null),
    };
  });

  // ── Modified projected value (best-quarter bonus) ────────────────────────────
  applyModProjectedValue(all, state.completedQuarters);

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

  // ── Momentum: frozen during stat corrections ──────────────────────────────────
  if (!isStatCorrection && all.length > 0) {
    const t1Total = all.filter(p => p.team === team1Name).reduce((s, p) => s + p.value, 0);
    const t2Total = all.filter(p => p.team === team2Name).reduce((s, p) => s + p.value, 0);
    state.momentumFull.push({ ts: Date.now(), t1: +t1Total.toFixed(2), t2: +t2Total.toFixed(2) });
    saveMomentum(mid, state.momentumFull);
  }
  const momentum = state.momentumFull;

  // ── Score event detection: frozen during stat corrections ────────────────────
  if (!isStatCorrection) {
    const now = Date.now();
    for (const [teamName, players] of [[team1Name, team1], [team2Name, team2]]) {
      const totalG = players.reduce((s, p) => s + (p.G || 0), 0);
      const totalB = players.reduce((s, p) => s + (p.B || 0), 0);
      const prev = state.lastScores[teamName];
      if (prev) {
        const dG = Math.max(0, totalG - prev.G);
        const dB = Math.max(0, totalB - prev.B);
        for (let i = 0; i < dG; i++) state.scoreEvents.push({ ts: now, team: teamName, type: 'G' });
        for (let i = 0; i < dB; i++) state.scoreEvents.push({ ts: now, team: teamName, type: 'B' });
      }
      state.lastScores[teamName] = { G: totalG, B: totalB };
    }
    if (state.scoreEvents.length > 400) state.scoreEvents.splice(0, state.scoreEvents.length - 400);
  }

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
    const isBaseline = state.fetchLog.length === 0 || Object.keys(state.lastFetchState).length === 0;
    const actions    = [];
    all.forEach(p => {
      const prev  = state.lastFetchState[p.name];
      const newV  = +p.value.toFixed(2);
      const newR  = p.rating;
      if (!prev || isBaseline) {
        const entry = { n: p.name, tm: p.team, v: newV, r: newR };
        STAT_KEYS.forEach(k => { if (p[k]) entry[k] = p[k]; });
        actions.push(entry);
      } else {
        const changed = {};
        STAT_KEYS.forEach(k => {
          const cur = p[k] || 0;
          if (cur !== (prev[k] || 0)) changed[k] = cur;
        });
        actions.push({ n: p.name, ...changed, v: newV, r: newR });
      }
      state.lastFetchState[p.name] = { v: newV, r: newR, tm: p.team };
      STAT_KEYS.forEach(k => { state.lastFetchState[p.name][k] = p[k] || 0; });
    });

    state.fetchLog.push({
      ts:  Date.now(),
      iso: new Date().toISOString(),
      q:   currentQ,
      t:   el,
      s1:  score1,
      s2:  score2,
      ...(isBaseline ? { baseline: true } : {}),
      actions,
    });

    saveGameData(mid, {
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
      momentum:         state.momentumFull,
      scoreEvents:      state.scoreEvents,
      completedQuarters: state.completedQuarters,
      quarterBaseline:  state.quarterBaseline,
      quarterStartTs:   state.quarterStartTs,
      fullTimeTs:       state.fullTimeTs,
      fetches:          state.fetchLog,
      savedAt:          new Date().toISOString(),
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
    quarterStartTs:  state.quarterStartTs,
    scoreEvents:     state.scoreEvents,
    hotWindowMins:   hotWindowMins,
    quietWindowMins: quietWindowMins,
    momentum,
    bursts:          (() => {
      const now = Date.now();
      if (now - state.burstCache.ts >= 2 * 60 * 1000) {
        state.burstCache = { ts: now, bursts: computeBursts(state.fetchLog) };
      }
      return state.burstCache.bursts;
    })(),
    summary,
    fetchedAt:       new Date().toISOString(),
  };
}

// ── Fixture cache helpers ─────────────────────────────────────────────────────

// Convert Squiggle's timezone-naive Australian Eastern date string to UTC ms.
// DST (AEDT, UTC+11) runs from first Sunday of October → first Sunday of April.
// Everything else is AEST (UTC+10).
function firstSundayOfMonth(year, month0) {
  // Returns the day-of-month of the first Sunday in the given month (0-based index).
  return 1 + (7 - new Date(Date.UTC(year, month0, 1)).getUTCDay()) % 7;
}

function aestToUtcMs(dateStr) {
  if (!dateStr) return null;
  const year  = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10); // 1-based
  const day   = parseInt(dateStr.slice(8, 10), 10);

  // DST ends first Sunday of April; DST starts first Sunday of October.
  const dstEndDay   = firstSundayOfMonth(year, 3);  // April  (month0=3)
  const dstStartDay = firstSundayOfMonth(year, 9);  // October (month0=9)

  const inDST =
    (month > 10 || (month === 10 && day >= dstStartDay)) ||
    (month <  4 || (month ===  4 && day <  dstEndDay));

  const offsetH = inDST ? 11 : 10;
  const utcMs   = new Date(dateStr.replace(" ", "T") + "Z").getTime();
  return isNaN(utcMs) ? null : utcMs - offsetH * 3600000;
}

const FIXTURE_FILE = path.join(__dirname, "data", "fixture_2026.json");

const FIXTURE_REFRESH_MS = 6 * 60 * 60 * 1000; // re-read file every 6 hours

function refreshFixture() {
  if (fixtureCache && Date.now() - fixtureCache.ts < FIXTURE_REFRESH_MS) return;
  const raw = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));
  const rounds = {};
  for (const g of (raw.games || [])) {
    const fw_id = g.id - 27089;
    const key   = g.round === 0 ? "Opening Round" : `Round ${g.round}`;
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
  fixtureCache = { ts: Date.now(), rounds: Object.values(rounds).sort((a, b) => a.roundNum - b.roundNum) };
}

// ── Background auto-recorder ──────────────────────────────────────────────────
// Automatically fetches & persists data for every live game every 15 seconds,
// regardless of whether anyone is watching. This ensures full game records are
// saved to disk (DATA_DIR) even if the user isn't on the dashboard.

// Scrape Footywire's live stats landing page to get all currently-live match IDs.
// This is more reliable than Squiggle which can lag in updating game status.
function fetchLiveMidsFromFootywire() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.footywire.com",
      path:     "/afl/footy/live_stats",
      method:   "GET",
      timeout:  8000,
      headers:  { "User-Agent": "Mozilla/5.0" },
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        const mids = new Set();
        const re = /mid=(\d+)/g;
        let m;
        while ((m = re.exec(raw)) !== null) mids.add(Number(m[1]));
        resolve(mids);
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Footywire live_stats timeout")); });
    req.on("error", reject);
    req.end();
  });
}

const autoRecording = new Set(); // fw_ids currently being auto-recorded

// Returns true if the current time falls within the active window of any
// scheduled game: from 10 minutes before kickoff to 3 hours after.
function isAnyGameWindowActive() {
  if (!fixtureCache) return false;
  const now = Date.now();
  const PRE_MS  = 10 * 60 * 1000;   // 10 min before kickoff
  const POST_MS = 180 * 60 * 1000;  // 3 hours after kickoff
  for (const round of fixtureCache.rounds) {
    for (const g of round.games) {
      if (!g.dateTs) continue;
      if (now >= g.dateTs - PRE_MS && now <= g.dateTs + POST_MS) return true;
    }
  }
  return false;
}

async function autoRecordTick() {
  // Keep fixture loaded (reads from file once, then cached)
  refreshFixture();

  // Only hit Footywire if we're within a game window or already tracking something
  if (!isAnyGameWindowActive() && autoRecording.size === 0) return;

  // Use Footywire directly to find live games — no Squiggle lag
  let liveMids = new Set();
  try {
    liveMids = await fetchLiveMidsFromFootywire();
  } catch(e) {
    console.error(`[autoRecord] Footywire live detection failed: ${e.message}`);
  }

  const now = Date.now();
  const candidates = new Set(liveMids);

  // Also keep tracking any game in the post-full-time stat-correction window
  for (const [mid, gs] of gameStates) {
    if (gs.fullTimeTs && now - gs.fullTimeTs < 12 * 60 * 1000) {
      candidates.add(Number(mid));
    }
  }

  // Stop tracking games that are no longer candidates
  for (const mid of autoRecording) {
    if (!candidates.has(mid)) {
      autoRecording.delete(mid);
      console.log(`[autoRecord] stopped  mid=${mid}`);
    }
  }

  // Fetch each candidate (saves to disk via fetchRatings)
  for (const mid of candidates) {
    if (!autoRecording.has(mid)) {
      autoRecording.add(mid);
      console.log(`[autoRecord] started  mid=${mid}`);
    }
    try {
      await fetchRatings(String(mid));
    } catch(e) {
      console.error(`[autoRecord] mid=${mid}: ${e.message}`);
    }
  }
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
      refreshFixture();
      // Include the set of fw_ids with saved game data so the client can
      // show/hide the Review button without a separate round-trip.
      const savedGames = fs.readdirSync(DATA_DIR)
        .filter(f => /^game_\d+\.json$/.test(f))
        .map(f => parseInt(f.slice(5, -5), 10));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ serverNow: Date.now(), rounds: fixtureCache.rounds, savedGames, liveGames: [...autoRecording] }));
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
  if (parsed.pathname === "/api/has-data") {
    const mid = parsed.searchParams.get("mid");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasSaved: !!(mid && fs.existsSync(gameFile(mid))) }));
    return;
  }
  if (parsed.pathname === "/api/import" && req.method === "POST") {
    const mid = parsed.searchParams.get("mid");
    if (!mid) { res.writeHead(400); res.end(JSON.stringify({ error: "mid required" })); return; }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 20 * 1024 * 1024) { req.destroy(); } });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data.teams) || !Array.isArray(data.players)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid game data: missing teams or players" }));
          return;
        }
        saveGameData(mid, data);
        // Evict cached state so next load re-reads the imported file
        gameStates.delete(mid);
        console.log(`[import] saved game_${mid}.json (${data.players.length} players)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, players: data.players.length, teams: data.teams }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
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
}).listen(PORT, () => {
  console.log(`AFL Live Ratings → http://localhost:${PORT}`);
  console.log(`Data directory   → ${DATA_DIR}`);
  console.log(`GitHub repo      → ${GH_REPO || "(not configured — set GITHUB_TOKEN + GITHUB_REPO)"}`);
  // Pull saved game data from GitHub, then start the background recorder
  syncFromGitHub()
    .catch(e => console.error("[github] startup sync failed:", e.message))
    .finally(() => {
      autoRecordTick();
      setInterval(autoRecordTick, 15000);
    });
});
