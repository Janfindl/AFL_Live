"use strict";
// v2026-04-04 — standalone data collector (no HTTP server)
const http  = require("http");
const https = require("https");
const path  = require("path");
const fs    = require("fs");
const qs    = require("querystring");

const GAME_MINS    = 120;
const QUARTER_MINS = GAME_MINS / 4;
const HOT_WINDOW_MS   = 5  * 60 * 1000;
const QUIET_WINDOW_MS = 10 * 60 * 1000;
const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_THRESHOLD = 10;
const HISTORY_MAX     = 42;

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

// ── Player key: disambiguate players sharing a surname (e.g. C Warner / C Warner)
function pkey(p) { return p.jersey ? `${p.name}#${p.jersey}` : p.name; }
function pkeyAction(a) { return a.j ? `${a.n}#${a.j}` : a.n; }

function calcRating(value) {
  // Linear: PV 10 → 1, PV 70 → 10, clamped
  const raw = 1 + (Math.min(Math.max(value, 10), 70) - 10) * (9 / 60);
  return Math.round(raw * 2) / 2;
}

function calculateValue(p, elapsedFrac = 1) {
  let v = CONSTANT * elapsedFrac;
  for (const [col, w] of Object.entries(WEIGHTS)) {
    v += (typeof p[col] === "number" ? p[col] : 0) * w;
  }
  return Math.round(v * 100) / 100;
}

// ── Game time ─────────────────────────────────────────────────────────────────
function parseGameTime(sb) {
  if (!sb) return null;
  const title = (sb.match(/class="tbtitle"[^>]*>([\s\S]*?)<\/td>/i)||[])[1]||"";
  if (/full\s*time/i.test(title) || /final\s*scores?/i.test(title)) return { quarter: 4, elapsedMins: GAME_MINS, isFullTime: true };
  if (/(?:three|3\w*)[\s-]*quarter\s*time/i.test(title))    return { quarter: 3, elapsedMins: 90 };
  if (/half\s*time/i.test(title))                            return { quarter: 2, elapsedMins: 60 };
  if (/quarter\s*time/i.test(title))                         return { quarter: 1, elapsedMins: 30 };
  const m = sb.match(/(\d+)(?:st|nd|rd|th) Quarter\s+(\d+):(\d+)/i);
  if (!m) return null;
  const quarter  = parseInt(m[1], 10);
  const qClock   = parseInt(m[2], 10) + parseInt(m[3], 10) / 60;
  const qElapsed = Math.min(qClock, QUARTER_MINS);
  return { quarter, elapsedMins: (quarter - 1) * QUARTER_MINS + qElapsed };
}

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
// Returns dict keyed by jersey number (col 0) — consistent across basic/adv tables
// regardless of whether names are full ("Chad Warner") or abbreviated ("C Warner").
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
    const jersey = cells[0];
    const name   = cells[colMap._name];
    if (!jersey || !name) continue;
    const p = players[jersey] || (players[jersey] = { name, jersey });
    for (const [stat, idx] of Object.entries(colMap)) {
      if (stat === "_name") continue;
      const num = parseFloat(cells[idx]);
      p[stat] = isNaN(num) ? 0 : num;
    }
  }
  return players;
}

const BASIC_MAP = { _name: 1, K: 2, HB: 3, D: 4, M: 5, G: 6, B: 7, T: 8, HO: 9, GA: 10, I50: 11, R50: 12, CG: 13, FF: 15, FA: 16 };
const ADV_MAP   = { _name: 1, CP: 2, UP: 3, ED: 4, "DE%": 5, CM: 6, UM: 7, "1%": 8, SI: 12, MG: 13, TO: 14, ITC: 15 };

function mergeTeam(basicHtml, advHtml, teamName) {
  const basic   = parseTable(basicHtml, BASIC_MAP);
  const adv     = parseTable(advHtml,   ADV_MAP);
  const jerseys = new Set([...Object.keys(basic), ...Object.keys(adv)]);
  return [...jerseys].map(jersey => {
    const b = basic[jersey] || {};
    const a = adv[jersey]   || {};
    // Prefer the full name from the basic table; fall back to adv abbreviated name
    const name = b.name || a.name || jersey;
    const merged = { team: teamName, ...a, ...b, name, jersey };
    return merged;
  });
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
function pushToServer(mid, data) {
  const url = process.env.SERVER_URL;
  const secret = process.env.PUSH_SECRET;
  if (!url || !secret) return;
  try {
    const body = JSON.stringify(data);
    const parsed = new URL(`${url}/api/push?mid=${mid}&secret=${encodeURIComponent(secret)}`);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      timeout:  8000,
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => { res.resume(); });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

function saveGameData(mid, data) {
  try { fs.writeFileSync(gameFile(mid), JSON.stringify(data)); }
  catch (e) { console.error("saveGameData:", e.message); }
  pushToServer(mid, data);
  scheduleGhPush(mid);
}

// ── GitHub-backed cloud persistence ──────────────────────────────────────────
const GH_TOKEN  = process.env.GITHUB_TOKEN || null;
const GH_REPO   = process.env.GITHUB_REPO  || null;
const GH_BRANCH = process.env.GITHUB_DATA_BRANCH || "master";

const ghShaCache  = new Map();
const ghPushQueue = new Map();

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

async function ghPushGame(mid) {
  const gf = gameFile(mid);
  const mf = momentumFile(mid);
  if (fs.existsSync(gf)) await ghPutFile(`data/game_${mid}.json`,     fs.readFileSync(gf));
  if (fs.existsSync(mf)) await ghPutFile(`data/momentum_${mid}.json`, fs.readFileSync(mf));
  console.log(`[github] pushed  game_${mid}.json`);
}

const ghPushInFlight = new Set(); // mids currently being pushed

function scheduleGhPush(mid) {
  if (!GH_TOKEN || !GH_REPO) return;
  // If a push is already in flight for this mid, queue one follow-up
  if (ghPushInFlight.has(mid)) {
    if (!ghPushQueue.has(mid)) {
      ghPushQueue.set(mid, true); // mark: push again once current one lands
    }
    return;
  }
  ghPushInFlight.add(mid);
  ghPushQueue.delete(mid);
  ghPushGame(mid)
    .catch(e => console.error(`[github] push mid=${mid}:`, e.message))
    .finally(() => {
      ghPushInFlight.delete(mid);
      // If a follow-up was requested while we were in flight, do it now
      if (ghPushQueue.has(mid)) {
        ghPushQueue.delete(mid);
        scheduleGhPush(mid);
      }
    });
}

async function flushAndExit() {
  // Push any queued follow-ups plus any games not yet pushed
  const toPush = new Set([...ghPushQueue.keys(), ...ghPushInFlight]);
  ghPushQueue.clear();
  if (toPush.size > 0) {
    console.log(`[github] SIGTERM — flushing ${toPush.size} game(s)...`);
    const timeout = new Promise(r => setTimeout(r, 20000));
    await Promise.race([
      Promise.allSettled([...toPush].map(mid =>
        ghPushGame(mid).catch(e => console.error(`[github] flush mid=${mid}: ${e.message}`))
      )),
      timeout,
    ]);
  }
  process.exit(0);
}
process.on("SIGTERM", flushAndExit);
process.on("SIGINT",  flushAndExit);

// ── Rolling snapshot history ──────────────────────────────────────────────────
const STAT_KEYS  = Object.keys(WEIGHTS);
const BASIC_KEYS = ["K","HB","D","M","I50","R50","FF","FA"];

function recordSnapshot(players, snapshotHistory) {
  const snap = { ts: Date.now(), map: {} };
  players.forEach(p => {
    const entry = { value: p.value };
    STAT_KEYS.forEach(k => { entry[k] = typeof p[k] === "number" ? p[k] : 0; });
    snap.map[pkey(p)] = entry;
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
function computeBursts(fetchLog) {
  const playerMap    = new Map();
  const runningStats = new Map();
  for (const entry of (fetchLog || [])) {
    for (const action of (entry.actions || [])) {
      if (action.v === undefined) continue;
      const key = pkeyAction(action);
      if (!playerMap.has(key)) playerMap.set(key, { name: action.n, team: null, series: [] });
      const ps = playerMap.get(key);
      if (action.tm) ps.team = action.tm;
      if (!runningStats.has(key)) runningStats.set(key, {});
      const cur = runningStats.get(key);
      STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });
      ps.series.push({ ts: entry.ts, value: action.v, q: entry.q, stats: { ...cur } });
    }
  }
  const allBursts = [];
  for (const [key, { name, team, series }] of playerMap) {
    if (series.length < 2) continue;
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
          name, team, startTs,
          endTs:   series[bestEndIdx].ts,
          gain:    Math.round(bestGain * 100) / 100,
          quarter: series[i].q,
          statContribs,
        });
        nextAllowedIdx = bestEndIdx + 1;
        i = bestEndIdx;
      }
    }
  }
  allBursts.sort((a, b) => a.startTs - b.startTs);
  return allBursts;
}

// ── Modified projected value ──────────────────────────────────────────────────
function applyModProjectedValue(players, completedQuarters) {
  players.forEach(p => {
    const pk = pkey(p);
    const qVals = Object.values(completedQuarters || {})
      .map(qData => {
        const entry = qData[pk] ?? qData[p.name]; // fallback for pre-jersey data
        if (entry == null) return null;
        return typeof entry === "object" ? (entry.v ?? null) : entry;
      })
      .filter(v => v !== null && isFinite(v));
    if (p.quarterDelta !== null && p.quarterDelta !== undefined && isFinite(p.quarterDelta)) {
      qVals.push(p.quarterDelta);
    }
    if (qVals.length === 0) return;
    const avgQ     = p.projectedValue / 4;
    const maxQ     = Math.max(...qVals);
    const qmxDelta = Math.max(0, maxQ - avgQ) / 2;
    if (qmxDelta <= 0) return;
    p.projectedValue = Math.round((p.projectedValue + qmxDelta) * 100) / 100;
    p.rating         = calcRating(p.projectedValue);
  });
}

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
    .filter(x => Math.abs(x.contribution) >= 0.01)
    .sort((a, b) => b.contribution - a.contribution);
}

// ── Reconstruct a player's per-quarter delta from the fetch log ──────────────
function inferQDeltaFromLog(key, q, fetchLog) {
  if (!fetchLog.length) return null;
  let cum          = {};
  let statsBeforeQ = null;
  let statsAtQEnd  = null;
  let inQ          = false;
  for (const entry of fetchLog) {
    if (entry.q === q && !inQ) {
      statsBeforeQ = { ...cum };
      inQ = true;
    } else if (entry.q !== q && inQ) {
      inQ = false;
    }
    for (const action of (entry.actions || [])) {
      if (pkeyAction(action) !== key) continue;
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

// ── Fixture cache helpers ─────────────────────────────────────────────────────
let fixtureCache = null;

function firstSundayOfMonth(year, month0) {
  return 1 + (7 - new Date(Date.UTC(year, month0, 1)).getUTCDay()) % 7;
}

function aestToUtcMs(dateStr) {
  if (!dateStr) return null;
  const year  = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const day   = parseInt(dateStr.slice(8, 10), 10);
  const dstEndDay   = firstSundayOfMonth(year, 3);
  const dstStartDay = firstSundayOfMonth(year, 9);
  const inDST =
    (month > 10 || (month === 10 && day >= dstStartDay)) ||
    (month <  4 || (month ===  4 && day <  dstEndDay));
  const offsetH = inDST ? 11 : 10;
  const utcMs   = new Date(dateStr.replace(" ", "T") + "Z").getTime();
  return isNaN(utcMs) ? null : utcMs - offsetH * 3600000;
}

const FIXTURE_FILE       = path.join(__dirname, "data", "fixture_2026.json");
const FIXTURE_REFRESH_MS = 6 * 60 * 60 * 1000;

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

// ── Per-game state ────────────────────────────────────────────────────────────
const gameStates = new Map();

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
    snapshotHistory:   [],
    fullTimeTs:        saved?.fullTimeTs        ?? null,
    burstCache:        { ts: 0, bursts: [] },
  };
  for (const entry of state.fetchLog) {
    for (const action of (entry.actions || [])) {
      const key = pkeyAction(action);
      const { n, j, tm, ...fields } = action;
      if (!state.lastFetchState[key]) state.lastFetchState[key] = {};
      if (tm) state.lastFetchState[key].tm = tm;
      Object.assign(state.lastFetchState[key], fields);
    }
  }
  if (state.fetchLog.length > 0) {
    const running = new Map();
    const rawSnaps = [];
    for (const logEntry of state.fetchLog) {
      for (const action of (logEntry.actions || [])) {
        const key = pkeyAction(action);
        if (!running.has(key)) running.set(key, {});
        const cur = running.get(key);
        if (action.tm) cur.tm = action.tm;
        if (typeof action.v === "number") cur.value = action.v;
        STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });
      }
      if (running.size > 0) {
        const snap = { ts: logEntry.ts, map: {} };
        for (const [key, p] of running) {
          if (typeof p.value === "number") {
            const s = { value: p.value };
            STAT_KEYS.forEach(k => { s[k] = typeof p[k] === "number" ? p[k] : 0; });
            snap.map[key] = s;
          }
        }
        rawSnaps.push(snap);
      }
    }
    state.snapshotHistory = rawSnaps.slice(-HISTORY_MAX);

    if (state.trackedQuarter !== null) {
      const q        = state.trackedQuarter;
      const runningQ = new Map();
      let   baseline = null;
      for (const logEntry of state.fetchLog) {
        if (logEntry.q === q && baseline === null) {
          baseline = {};
          for (const [key, cur] of runningQ) {
            baseline[key] = { v: cur._v || 0 };
            STAT_KEYS.forEach(k => { baseline[key][k] = cur[k] || 0; });
          }
        }
        for (const action of (logEntry.actions || [])) {
          const key = pkeyAction(action);
          if (!runningQ.has(key)) runningQ.set(key, {});
          const cur = runningQ.get(key);
          if (typeof action.v === "number") cur._v = action.v;
          STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });
        }
      }
      if (baseline !== null) state.quarterBaseline = baseline;
    }
  }
  // ── Migrate name-only keys → name#jersey in completedQuarters & quarterBaseline
  // Build jersey lookup from fetch log actions that have jersey ('j') field
  const jerseyLookup = {}; // name → Set of jerseys
  for (const entry of state.fetchLog) {
    for (const action of (entry.actions || [])) {
      if (action.n && action.j) {
        if (!jerseyLookup[action.n]) jerseyLookup[action.n] = new Set();
        jerseyLookup[action.n].add(action.j);
      }
    }
  }
  function migrateKeys(obj) {
    if (!obj) return obj;
    const migrated = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key.includes('#')) { migrated[key] = val; continue; } // already migrated
      const jerseys = jerseyLookup[key];
      if (jerseys && jerseys.size >= 1) {
        for (const j of jerseys) migrated[`${key}#${j}`] = val;
      } else {
        migrated[key] = val; // no jersey info, keep as-is
      }
    }
    return migrated;
  }
  for (const q of Object.keys(state.completedQuarters)) {
    state.completedQuarters[q] = migrateKeys(state.completedQuarters[q]);
  }
  if (state.quarterBaseline) {
    state.quarterBaseline = migrateKeys(state.quarterBaseline);
  }

  for (const [q, qData] of Object.entries(state.completedQuarters)) {
    for (const [key, val] of Object.entries(qData)) {
      if (val === null) {
        const inferred = inferQDeltaFromLog(key, parseInt(q), state.fetchLog);
        if (inferred) qData[key] = inferred;
      }
    }
  }
  gameStates.set(mid, state);
  return state;
}

// ── Core fetch ────────────────────────────────────────────────────────────────
async function fetchRatings(mid) {
  const state = getState(mid);
  const { snapshotHistory } = state;
  const [basicData, advData] = await Promise.all([
    fetchFootywire("N", mid),
    fetchFootywire("Y", mid),
  ]);

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

  const team1 = mergeTeam(basicData.team1, advData.team1, team1Name);
  const team2 = mergeTeam(basicData.team2, advData.team2, team2Name);
  const all   = [...team1, ...team2];

  if (all.length === 0) return;

  const el          = gameTime ? gameTime.elapsedMins : null;
  const elapsedFrac = el ? Math.min(el / GAME_MINS, 1) : 1;
  const currentQ    = gameTime ? gameTime.quarter : null;

  all.forEach(p => {
    p.value             = calculateValue(p, elapsedFrac);
    const rawPv         = el ? projectValue(p.value, el) : p.value;
    const fracElapsed   = el ? Math.min(el / GAME_MINS, 1) : 1;
    const prevPv        = fracElapsed > 0 ? p.value / fracElapsed : rawPv;
    p.projectedValue    = Math.round((rawPv + prevPv) / 2 * 100) / 100;
    p.rating            = calcRating(p.projectedValue);
  });

  const hotRef        = getRefSnapshot(HOT_WINDOW_MS, 0, snapshotHistory);
  const hotWindowMs   = hotRef ? Date.now() - hotRef.ts : 0;
  const hotWindowMins = Math.round(hotWindowMs / 6000) / 10;

  all.forEach(p => {
    const refEntry = hotRef ? (hotRef.map[pkey(p)] ?? null) : null;
    p.delta5min    = refEntry !== null ? Math.round((p.value - refEntry.value) * 100) / 100 : null;
    p.statContribs = statContributions(p, refEntry);
  });

  const quietRef        = getRefSnapshot(QUIET_WINDOW_MS, 0, snapshotHistory);
  const quietWindowMs   = quietRef ? Date.now() - quietRef.ts : 0;
  const quietWindowMins = Math.round(quietWindowMs / 6000) / 10;
  const quietWindowFrac = quietWindowMins / GAME_MINS;

  const isFullTimeNow = gameTime?.isFullTime === true;
  if (isFullTimeNow && state.fullTimeTs === null) {
    state.fullTimeTs = Date.now();
  }
  const isStatCorrection = isFullTimeNow && state.fullTimeTs !== null
    && Date.now() - state.fullTimeTs > 5000;

  all.forEach(p => {
    const refEntry = quietRef ? (quietRef.map[pkey(p)] ?? null) : null;
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

  if (!isStatCorrection) recordSnapshot(all, snapshotHistory);

  if (currentQ !== null && currentQ !== state.trackedQuarter) {
    if (state.trackedQuarter !== null && state.quarterBaseline !== null) {
      const qData = {};
      all.forEach(p => {
        const pk = pkey(p);
        const base = state.quarterBaseline[pk];
        if (base !== undefined) {
          const entry = { v: Math.round((p.value - base.v) * 100) / 100 };
          STAT_KEYS.forEach(k => { entry[k] = (p[k] || 0) - (base[k] || 0); });
          qData[pk] = entry;
        } else {
          const inferred = inferQDeltaFromLog(pk, state.trackedQuarter, state.fetchLog);
          if (inferred) {
            qData[pk] = inferred;
          } else {
            const entry = { v: Math.round(p.value * 100) / 100 };
            STAT_KEYS.forEach(k => { entry[k] = p[k] || 0; });
            qData[pk] = entry;
          }
        }
      });
      state.completedQuarters[state.trackedQuarter] = qData;
    }
    state.trackedQuarter              = currentQ;
    state.quarterStartTs[currentQ]    = Date.now();
    state.quarterBaseline             = {};
    all.forEach(p => {
      const pk = pkey(p);
      state.quarterBaseline[pk] = { v: p.value };
      STAT_KEYS.forEach(k => { state.quarterBaseline[pk][k] = p[k] || 0; });
    });
  }

  function cqv(entry) { return typeof entry === "object" && entry !== null ? entry.v : entry; }

  all.forEach(p => {
    const pk = pkey(p);
    if (state.quarterBaseline && pk && !(pk in state.quarterBaseline)) {
      state.quarterBaseline[pk] = { v: p.value };
      STAT_KEYS.forEach(k => { state.quarterBaseline[pk][k] = p[k] || 0; });
    }
    const base = state.quarterBaseline?.[pk];
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

  const quarterLog = {};
  const quarterStatLog = {};
  all.forEach(p => {
    const pk = pkey(p);
    function cqEntry(q) {
      const e = state.completedQuarters[q]?.[pk];
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

  applyModProjectedValue(all, state.completedQuarters);

  all.sort((a, b) => b.projectedValue - a.projectedValue);
  all.forEach((p, i) => { p.rank = i + 1; });

  const hot5 = [...all]
    .filter(p => p.delta5min !== null)
    .sort((a, b) => b.delta5min - a.delta5min)
    .slice(0, 10)
    .map((p, i) => ({ ...p, hotRank: i + 1 }));

  const quiet5 = [...all]
    .filter(p => p.quietDelta !== null)
    .sort((a, b) => a.quietDelta - b.quietDelta)
    .slice(0, 10)
    .map((p, i) => ({ ...p, quietRank: i + 1 }));

  if (!isStatCorrection && all.length > 0) {
    const t1Total = all.filter(p => p.team === team1Name).reduce((s, p) => s + p.value, 0);
    const t2Total = all.filter(p => p.team === team2Name).reduce((s, p) => s + p.value, 0);
    state.momentumFull.push({ ts: Date.now(), t1: +t1Total.toFixed(2), t2: +t2Total.toFixed(2) });
    saveMomentum(mid, state.momentumFull);
  }
  const momentum = state.momentumFull;

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

  // ── Build fetch log entry ─────────────────────────────────────────────────────
  const isBaseline = state.fetchLog.length === 0 || Object.keys(state.lastFetchState).length === 0;
  const actions    = [];
  all.forEach(p => {
    const pk    = pkey(p);
    const prev  = state.lastFetchState[pk];
    const newV  = +p.value.toFixed(2);
    const newR  = p.rating;
    if (!prev || isBaseline) {
      const entry = { n: p.name, j: p.jersey, tm: p.team, v: newV, r: newR };
      STAT_KEYS.forEach(k => { if (p[k]) entry[k] = p[k]; });
      actions.push(entry);
    } else {
      const changed = {};
      STAT_KEYS.forEach(k => {
        const cur = p[k] || 0;
        if (cur !== (prev[k] || 0)) changed[k] = cur;
      });
      actions.push({ n: p.name, j: p.jersey, ...changed, v: newV, r: newR });
    }
    state.lastFetchState[pk] = { v: newV, r: newR, tm: p.team };
    STAT_KEYS.forEach(k => { state.lastFetchState[pk][k] = p[k] || 0; });
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

  // ── Compute bursts (cached every 2 min) ───────────────────────────────────────
  const now = Date.now();
  if (now - state.burstCache.ts >= 2 * 60 * 1000) {
    state.burstCache = { ts: now, bursts: computeBursts(state.fetchLog) };
  }
  const bursts = state.burstCache.bursts;

  // ── Persist full pre-computed response + internal state to disk ───────────────
  const savedPlayers = all.map(p => {
    const s = { name: p.name, team: p.team, jersey: p.jersey, rank: p.rank, value: p.value,
      projectedValue: p.projectedValue, rating: p.rating, quarterDelta: p.quarterDelta };
    STAT_KEYS.forEach(k => { s[k] = p[k] || 0; });
    BASIC_KEYS.forEach(k => { if (p[k]) s[k] = p[k]; });
    return s;
  });

  saveGameData(mid, {
    // Full pre-computed API response fields
    inProgress:      basicData.inProgress === "Y",
    teams:           [team1Name, team2Name],
    matchInfo,
    elapsedMins:     el,
    quarter:         currentQ,
    players:         savedPlayers,
    hot5:            hot5.map(p => { const s = { ...p }; return s; }),
    quiet5:          quiet5.map(p => { const s = { ...p }; return s; }),
    qTop5:           qTop5.map(p => { const s = { ...p }; return s; }),
    quarterLog,
    quarterStatLog,
    hotWindowMins,
    quietWindowMins,
    momentum,
    scoreEvents:     state.scoreEvents,
    quarterStartTs:  state.quarterStartTs,
    bursts,
    summary,
    // Internal state fields (for restart recovery)
    completedQuarters: state.completedQuarters,
    quarterBaseline:   state.quarterBaseline,
    fullTimeTs:        state.fullTimeTs,
    fetches:           state.fetchLog,
    savedAt:           new Date().toISOString(),
  });
}

// ── Footywire live detection ──────────────────────────────────────────────────
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

function isAnyGameWindowActive() {
  if (!fixtureCache) return false;
  const now = Date.now();
  const PRE_MS  = 10 * 60 * 1000;
  const POST_MS = 180 * 60 * 1000;
  for (const round of fixtureCache.rounds) {
    for (const g of round.games) {
      if (!g.dateTs) continue;
      if (now >= g.dateTs - PRE_MS && now <= g.dateTs + POST_MS) return true;
    }
  }
  return false;
}

const autoRecording = new Set();

async function autoRecordTick() {
  refreshFixture();
  if (!isAnyGameWindowActive() && autoRecording.size === 0) return;
  let liveMids = new Set();
  try {
    liveMids = await fetchLiveMidsFromFootywire();
  } catch(e) {
    console.error(`[autoRecord] Footywire live detection failed: ${e.message}`);
  }
  const tickNow    = Date.now();
  const candidates = new Set(liveMids);
  for (const [mid, gs] of gameStates) {
    if (gs.fullTimeTs && tickNow - gs.fullTimeTs < 12 * 60 * 1000) {
      candidates.add(Number(mid));
    }
  }
  for (const mid of autoRecording) {
    if (!candidates.has(mid)) {
      autoRecording.delete(mid);
      console.log(`[autoRecord] stopped  mid=${mid}`);
    }
  }
  await Promise.allSettled([...candidates].map(mid => {
    if (!autoRecording.has(mid)) {
      autoRecording.add(mid);
      console.log(`[autoRecord] started  mid=${mid}`);
    }
    return fetchRatings(String(mid))
      .catch(e => console.error(`[autoRecord] mid=${mid}: ${e.message}`));
  }));
}

// ── Startup ───────────────────────────────────────────────────────────────────
console.log(`AFL Live Collector starting`);
console.log(`Data directory → ${DATA_DIR}`);
console.log(`GitHub repo    → ${GH_REPO || "(not configured — set GITHUB_TOKEN + GITHUB_REPO)"}`);

syncFromGitHub()
  .catch(e => console.error("[github] startup sync failed:", e.message))
  .finally(() => {
    gameStates.clear();
    autoRecordTick();
    setInterval(autoRecordTick, 15000);
  });
