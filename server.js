"use strict";
// v2026-04-04 — pure HTTP server (data collection handled by collector.js)

// Load .env if present
const fs0 = require("fs"), path0 = require("path");
try {
  fs0.readFileSync(path0.join(__dirname, ".env"), "utf8")
    .split(/\r?\n/).forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
} catch {}

const http        = require("http");
const https       = require("https");
const path        = require("path");
const fs          = require("fs");
const { execSync } = require("child_process");

const GIT_SHA = (() => {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
})();

// Commentary engine — optional, loads gracefully if module not present
let commentary = null;
try { commentary = require("./commentary"); } catch (e) { console.warn("[commentary] module not loaded:", e.message); }

const PORT     = process.env.PORT || 3000;
const GAME_MINS = 120;

// ── Formula constants (needed for buildCachedResponse after /api/import) ─────
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

// ── Player key: disambiguate players sharing a surname (e.g. C Warner / C Warner)
function pkeyAction(a) { return a.j ? `${a.n}#${a.j}` : a.n; }

// Quartile-weighted team rating with game-progress stabilisation.
// Blends projected ratings (reactive) with value-based ratings (stable)
// weighted by game progress. Early game leans on projected, late game
// anchors to actual accumulated value.
function weightedTeamRatings(allPlayers, teams, elapsedMins) {
  const GAME_MINS = 120;
  function quartileRating(teamPlayers) {
    if (!teamPlayers.length) return 0;
    const n = teamPlayers.length;
    const qSize = Math.ceil(n / 4);
    const avg = (arr, key) => arr.length ? arr.reduce((s, p) => s + (p[key] || 0), 0) / arr.length : 0;

    // Projected rating (from projectedValue — reactive, volatile early)
    const byRating = [...teamPlayers].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const rq1 = avg(byRating.slice(0, qSize), 'rating');
    const rq2 = avg(byRating.slice(qSize, qSize * 2), 'rating');
    const rq3 = avg(byRating.slice(qSize * 2, qSize * 3), 'rating');
    const rq4 = avg(byRating.slice(qSize * 3), 'rating');
    const projTeam = Math.min(10, (rq1 * 0.5 + rq2 * 0.25 + rq3 * 0.15 + rq4 * 0.1) * 1.2);

    // Value rating (from raw value — stable, grounded in actual stats)
    const byValue = [...teamPlayers].sort((a, b) => (b.value || 0) - (a.value || 0));
    const valRatings = byValue.map(p => calcRating(p.value || 0));
    const vq1 = valRatings.slice(0, qSize).reduce((s,v) => s+v, 0) / qSize;
    const vq2 = valRatings.slice(qSize, qSize*2).reduce((s,v) => s+v, 0) / Math.min(qSize, valRatings.length - qSize);
    const vq3 = valRatings.slice(qSize*2, qSize*3).reduce((s,v) => s+v, 0) / Math.min(qSize, valRatings.length - qSize*2);
    const vq4 = valRatings.slice(qSize*3).reduce((s,v) => s+v, 0) / Math.max(1, valRatings.length - qSize*3);
    const valTeam = Math.min(10, (vq1 * 0.5 + vq2 * 0.25 + vq3 * 0.15 + vq4 * 0.1) * 1.2);

    // Blend: early game trusts projected (rewards hot starts),
    // late game anchors to value (stabilises as data accumulates)
    const el = elapsedMins || GAME_MINS;
    const valWeight = Math.min(0.5, el / GAME_MINS * 0.5); // 0 → 0.5 over the game
    return +Math.min(10, projTeam * (1 - valWeight) + valTeam * valWeight).toFixed(1);
  }
  const result = {};
  for (const tm of teams) {
    result[tm] = quartileRating(allPlayers.filter(p => p.team === tm));
  }
  return result;
}

function calcRating(value) {
  // Linear: PV 10 → 1, PV 70 → 10, clamped
  const raw = 1 + (Math.min(Math.max(value, 10), 70) - 10) * (9 / 60);
  return Math.round(raw * 2) / 2;
}

// ── Persistent storage ────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function gameFile(mid) { return path.join(DATA_DIR, `game_${mid}.json`); }
function loadGameData(mid) {
  try { return JSON.parse(fs.readFileSync(gameFile(mid), "utf8")); }
  catch { return null; }
}
function fetchFile(mid) { return path.join(DATA_DIR, `fetches_${mid}.json`); }
function loadFetches(mid) {
  try { return JSON.parse(fs.readFileSync(fetchFile(mid), "utf8")); }
  catch { return []; }
}

// ── GitHub-backed cloud persistence ──────────────────────────────────────────
const GH_TOKEN  = process.env.GITHUB_TOKEN || null;
const GH_REPO   = process.env.GITHUB_REPO  || null;
const GH_BRANCH = (process.env.GITHUB_DATA_BRANCH || "master").toLowerCase();

const ghShaCache = new Map();

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

// Git Blobs API — returns raw content for any file size, no CDN involved
function ghGetBlob(blobSha) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path:     `/repos/${GH_REPO}/git/blobs/${blobSha}`,
      method:   "GET",
      timeout:  15000,
      headers: {
        "Authorization":        `Bearer ${GH_TOKEN}`,
        "User-Agent":           "AFL-Live-Ratings/1.0",
        "Accept":               "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub blob HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("GitHub blob timeout")); });
    req.on("error", reject);
    req.end();
  });
}

async function ghGetFile(repoPath) {
  const r = await ghRequest("GET", `/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`);
  if (r.status !== 200) {
    console.warn(`[github] GET ${repoPath} → HTTP ${r.status}`);
    return null;
  }
  if (r.body?.content) {
    ghShaCache.set(repoPath, r.body.sha);
    return Buffer.from(r.body.content.replace(/\n/g, ""), "base64");
  }
  // GitHub omits inline content for large files — fetch via Blobs API using SHA
  if (r.body?.sha) {
    console.log(`[github] ${repoPath} large file, fetching blob ${r.body.sha.slice(0,7)}`);
    const buf = await ghGetBlob(r.body.sha);
    ghShaCache.set(repoPath, r.body.sha);
    return buf;
  }
  console.warn(`[github] GET ${repoPath} → 200 but no content or download_url`);
  return null;
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
    if (!/^(game|momentum|sim)_\d+\.json$/.test(name)) continue;
    const local   = path.join(DATA_DIR, name);
    const isSim   = name.startsWith("sim_");
    // Always overwrite sim files (updated externally); skip game/momentum if already present
    if (!isSim && fs.existsSync(local)) continue;
    try {
      const buf = await ghGetFile(`data/${name}`);
      if (buf) { fs.writeFileSync(local, buf); console.log(`[github] pulled  ${name}`); }
    } catch (e) { console.error(`[github] pull ${name}:`, e.message); }
  }
  console.log("[github] sync complete");
}

// ── Top 10 best 15-min windows (needed by buildCachedResponse) ───────────────
const BURST_WINDOW_MINS = 15;
const STAT_KEYS = Object.keys(WEIGHTS);

function computeBursts(fetchLog) {
  const playerMap    = new Map();
  const runningStats = new Map();
  // Compute play-time (pt) per fetch entry: cumulative game-clock advance,
  // excluding quarter breaks.
  let pt = 0;
  let prevFetch = null;
  for (const entry of (fetchLog || [])) {
    if (prevFetch && entry.q != null && prevFetch.q != null
        && entry.q === prevFetch.q
        && entry.t != null && prevFetch.t != null) {
      const dt = entry.t - prevFetch.t;
      if (dt > 0) pt += dt;
    }
    const entryPt = pt;
    const gameMins = entry.t;
    for (const action of (entry.actions || [])) {
      if (action.v === undefined) continue;
      const key = pkeyAction(action);
      if (!playerMap.has(key)) playerMap.set(key, { name: action.n, team: null, series: [] });
      const ps = playerMap.get(key);
      if (action.tm) ps.team = action.tm;
      if (!runningStats.has(key)) runningStats.set(key, {});
      const cur = runningStats.get(key);
      STAT_KEYS.forEach(k => { if (typeof action[k] === "number") cur[k] = action[k]; });
      const lastEntry = ps.series.length > 0 ? ps.series[ps.series.length - 1] : null;
      if (!lastEntry || entryPt > lastEntry.pt || lastEntry.q !== entry.q) {
        ps.series.push({ ts: entry.ts, value: action.v, q: entry.q, gm: gameMins, pt: entryPt, stats: { ...cur } });
      } else {
        lastEntry.value = action.v;
        lastEntry.stats = { ...cur };
        lastEntry.ts = entry.ts;
        lastEntry.gm = gameMins;
      }
    }
    prevFetch = entry;
  }
  const allWindows = [];
  for (const [key, { name, team, series }] of playerMap) {
    if (series.length < 2) continue;
    const candidates = [];
    for (let i = 0; i < series.length; i++) {
      const winEnd = series[i].pt + BURST_WINDOW_MINS;
      let bestGain = 0, bestEndIdx = -1;
      for (let j = i + 1; j < series.length; j++) {
        if (series[j].pt > winEnd) break;
        const gain = series[j].value - series[i].value;
        if (gain > bestGain) { bestGain = gain; bestEndIdx = j; }
      }
      if (bestGain > 0 && bestEndIdx >= 0) candidates.push({ gain: bestGain, si: i, ei: bestEndIdx });
    }
    candidates.sort((a, b) => b.gain - a.gain);
    const used = [];
    for (const c of candidates) {
      const overlaps = used.some(u => c.si <= u.ei && c.ei >= u.si);
      if (overlaps) continue;
      used.push(c);
      const startStats = series[c.si].stats;
      const endStats   = series[c.ei].stats;
      const statContribs = STAT_KEYS
        .map(stat => {
          const delta        = (endStats[stat] || 0) - (startStats[stat] || 0);
          const contribution = Math.round(delta * WEIGHTS[stat] * 100) / 100;
          return { stat, delta, contribution };
        })
        .filter(x => Math.abs(x.contribution) >= 0.01)
        .sort((a, b) => b.contribution - a.contribution);
      allWindows.push({
        name, team,
        startTs: series[c.si].ts,
        endTs:   series[c.ei].ts,
        startGm: series[c.si].gm,
        endGm:   series[c.ei].gm,
        startQ:  series[c.si].q,
        endQ:    series[c.ei].q,
        gain:    Math.round(c.gain * 100) / 100,
        quarter: series[c.si].q,
        statContribs,
      });
    }
  }
  allWindows.sort((a, b) => b.gain - a.gain);
  return allWindows.slice(0, 10);
}

// ── Modified projected value (needed by buildCachedResponse) ─────────────────
function applyModProjectedValue(players, completedQuarters) {
  players.forEach(p => {
    const pk = p.jersey ? `${p.name}#${p.jersey}` : p.name;
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

// ── buildCachedResponse: used after /api/import for imported data ─────────────
function buildCachedResponse(cached, mid) {
  const allPlayers = cached.players || [];
  const teams = cached.teams || [];
  const teamRatings = weightedTeamRatings(allPlayers, teams, cached.elapsedMins);
  const summary = {};
  for (const tm of teams) {
    const tp  = allPlayers.filter(p => p.team === tm);
    const sc  = tm === teams[0] ? cached.score1 : cached.score2;
    summary[tm] = {
      score:        sc ?? null,
      avgRating:    teamRatings[tm] || 0,
      avgProjected: +(tp.reduce((s, p) => s + (p.projectedValue || 0), 0) / (tp.length || 1)).toFixed(1),
      topPlayer:    tp[0]?.name || "—",
    };
  }
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
    estimatedQMins:  cached.estimatedQMins || {},
    bursts:          computeBursts(mid ? loadFetches(mid) : (cached.fetches || [])),
    summary,
    fetchedAt:       new Date().toISOString(),
  };
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

// ── HTTP server ───────────────────────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, "index.html");

// Collector writes every 15s; 90s gives buffer for 6 missed polls before showing stale.
// 5 min buffer — survives collector restarts during Railway deployments
const IN_PROGRESS_STALE_MS = 5 * 60 * 1000;

// Always re-fetch from GitHub every 20s — no separate long TTL for "finished" games.
// A brief gap in collector pushes was previously flipping TTL to 5 min, freezing the UI.
const gameCache = new Map(); // mid -> { data, fetchedAt }
const CACHE_TTL_MS = 20 * 1000;

async function getGameData(mid) {
  const cached = gameCache.get(mid);
  const now    = Date.now();

  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) return cached.data;

  // Fetch fresh from GitHub: get blob SHA via Contents API, then fetch blob (handles any file size)
  if (GH_TOKEN && GH_REPO) {
    try {
      const repoPath = `data/game_${mid}.json`;
      const apiPath  = `/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`;
      console.log(`[cache] fetching meta mid=${mid} path=${apiPath}`);
      const meta = await ghRequest("GET", apiPath);
      if (meta.status !== 200 || !meta.body?.sha) {
        const msg = typeof meta.body === "object" ? JSON.stringify(meta.body) : String(meta.body).slice(0, 120);
        throw new Error(`Contents API HTTP ${meta.status}: ${msg}`);
      }
      const sha = meta.body.sha;
      ghShaCache.set(repoPath, sha);
      let buf;
      if (meta.body.content) {
        // Small file — inline content available, skip extra blob call
        buf = Buffer.from(meta.body.content.replace(/\n/g, ""), "base64");
        console.log(`[cache] meta inline mid=${mid} bytes=${buf.length}`);
      } else {
        console.log(`[cache] fetching blob ${sha.slice(0,7)} mid=${mid}`);
        buf = await ghGetBlob(sha);
        console.log(`[cache] blob ok mid=${mid} bytes=${buf?.length}`);
      }
      if (buf && buf.length > 0) {
        const data = JSON.parse(buf.toString("utf8"));
        data._source = "github";
        try { fs.writeFileSync(gameFile(mid), buf); } catch (we) { console.warn(`[cache] disk write mid=${mid}: ${we.message}`); }
        gameCache.set(mid, { data, fetchedAt: now });
        return data;
      }
      console.warn(`[cache] GitHub returned empty for mid=${mid}`);
    } catch (e) {
      console.error(`[cache] GitHub pull mid=${mid}: ${e.message}`);
    }
  } else {
    console.warn(`[cache] No GitHub config (GH_TOKEN=${!!GH_TOKEN} GH_REPO=${!!GH_REPO}) — disk only`);
  }

  // Fall back to disk
  const diskData = loadGameData(mid);
  if (diskData) {
    diskData._source = "disk";
    gameCache.set(mid, { data: diskData, fetchedAt: now });
    return diskData;
  }
  return null;
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  if (parsed.pathname === "/api/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString(), sha: GIT_SHA }));
    return;
  }

  if (parsed.pathname === "/api/sync" && req.method === "POST") {
    const secret = parsed.searchParams.get("secret");
    if (!process.env.PUSH_SECRET || secret !== process.env.PUSH_SECRET) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "sync started" }));
    syncFromGitHub().catch(e => console.error("[github] manual sync failed:", e.message));
    return;
  }

  // Collector pushes game data directly — bypasses GitHub read path entirely
  if (parsed.pathname === "/api/push" && req.method === "POST") {
    const secret = parsed.searchParams.get("secret");
    const mid    = parsed.searchParams.get("mid");
    if (!process.env.PUSH_SECRET || secret !== process.env.PUSH_SECRET) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }
    if (!mid) { res.writeHead(400); res.end("mid required"); return; }
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        data._source = "push";
        const prevEntry = gameCache.get(String(mid));
        const prevData  = prevEntry?.data || null;
        gameCache.set(String(mid), { data, fetchedAt: Date.now() });
        try { fs.writeFileSync(gameFile(mid), JSON.stringify(data)); } catch {}
        console.log(`[push] mid=${mid} players=${(data.players||[]).length} inProgress=${data.inProgress}`);
        // Fire-and-forget commentary generation
        if (commentary && data.inProgress) {
          commentary.onPush(String(mid), data, prevData).catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(e.message);
      }
    });
    return;
  }

  if (parsed.pathname === "/api/fixture") {
    try {
      refreshFixture();
      let savedGames = fs.readdirSync(DATA_DIR)
        .filter(f => /^game_\d+\.json$/.test(f))
        .map(f => parseInt(f.slice(5, -5), 10));
      // If no local game files, try syncing from GitHub first
      if (savedGames.length === 0 && GH_TOKEN && GH_REPO) {
        console.log("[fixture] no local games — triggering sync");
        try { await syncFromGitHub(); } catch (e) { console.error("[fixture] sync failed:", e.message); }
        savedGames = fs.readdirSync(DATA_DIR)
          .filter(f => /^game_\d+\.json$/.test(f))
          .map(f => parseInt(f.slice(5, -5), 10));
      }
      // Extract final scores from saved game data
      const gameScores = {};
      for (const mid of savedGames) {
        try {
          const gd = loadGameData(mid);
          if (gd && gd.summary && gd.teams) {
            const s1 = gd.summary[gd.teams[0]]?.score;
            const s2 = gd.summary[gd.teams[1]]?.score;
            if (s1 != null && s2 != null) gameScores[mid] = { h: s1, a: s2 };
          }
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ serverNow: Date.now(), rounds: fixtureCache.rounds, savedGames, gameScores, liveGames: [] }));
    } catch (e) {
      console.error("[fixture]", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (parsed.pathname === "/api/probe") {
    const mid = parsed.searchParams.get("mid");
    if (!mid) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ found: false })); return; }
    // Use cache or disk only — no GitHub call so this stays fast under 5 s polling
    const cacheEntry = gameCache.get(mid);
    const data = cacheEntry?.data || loadGameData(mid);
    if (!data) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ found: false }));
      return;
    }
    const savedAt = data.savedAt ? new Date(data.savedAt).getTime() : 0;
    const isLive  = savedAt > 0 && (Date.now() - savedAt) < IN_PROGRESS_STALE_MS;
    const inProg  = isLive ? !!(data.inProgress) : false;
    const t1 = data.teams?.[0], t2 = data.teams?.[1];
    const s1 = data.summary?.[t1]?.score ?? null;
    const s2 = data.summary?.[t2]?.score ?? null;
    const timestr = data.matchInfo ? data.matchInfo.replace(/\s+\d+–\d+$/, "").trim() : "";
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ found: true, inProgress: inProg, hscore: s1, ascore: s2, timestr }));
    return;
  }

  if (parsed.pathname === "/api/has-data") {
    const mid = parsed.searchParams.get("mid");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasSaved: !!(mid && fs.existsSync(gameFile(mid))) }));
    return;
  }

  if (parsed.pathname === "/api/download") {
    const mid  = parsed.searchParams.get("mid");
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
        try { fs.writeFileSync(gameFile(mid), JSON.stringify(data)); }
        catch (e) { console.error("import write:", e.message); }
        if (GH_TOKEN && GH_REPO) {
          ghPutFile(`data/game_${mid}.json`, fs.readFileSync(gameFile(mid)))
            .catch(e => console.error(`[github] import push mid=${mid}:`, e.message));
        }
        gameCache.delete(mid);  // force fresh fetch on next /api/ratings
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

  if (parsed.pathname === "/api/commentary") {
    const mid = parsed.searchParams.get("mid");
    const log = (commentary && mid) ? commentary.getLog(mid) : [];
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(log));
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
      const cached = await getGameData(mid);
      if (!cached) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No data for this game" }));
        return;
      }
      const savedAt = cached.savedAt ? new Date(cached.savedAt).getTime() : 0;
      const isLive  = savedAt > 0 && (Date.now() - savedAt) < IN_PROGRESS_STALE_MS;
      cached.inProgress = isLive ? !!(cached.inProgress) : false;
      // Always recompute rating using current formula (stored values may use old scale)
      (cached.players || []).forEach(p => {
        if (p.projectedValue != null) p.rating = calcRating(p.projectedValue);
      });
      // Recompute summary avgRating from fresh player ratings (combined scale)
      if (cached.summary && cached.teams) {
        const tr = weightedTeamRatings(cached.players || [], cached.teams, cached.elapsedMins);
        for (const tm of Object.keys(tr)) {
          if (cached.summary[tm]) cached.summary[tm].avgRating = tr[tm];
        }
      }
      cached._servedAt  = new Date().toISOString();
      cached._v         = GIT_SHA;
      console.log(`  → OK  players=${(cached.players||[]).length}  live=${isLive}  age=${Math.round((Date.now()-savedAt)/1000)}s  src=${cached._source||'?'}`);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(cached));
    } catch (err) {
      console.error(`  → ERR ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  try {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
    res.end(fs.readFileSync(HTML_PATH, "utf8"));
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`AFL Live Ratings → http://localhost:${PORT}`);
  console.log(`Data directory   → ${DATA_DIR}`);
  console.log(`GitHub repo      → ${GH_REPO || "(none)"}`);
  console.log(`GitHub token     → ${GH_TOKEN ? `set (${GH_TOKEN.slice(0,6)}…)` : "NOT SET"}`);
  console.log(`Push secret      → ${process.env.PUSH_SECRET ? "set" : "not set"}`);
  syncFromGitHub()
    .catch(e => console.error("[github] startup sync failed:", e.message));
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT",  () => process.exit(0));
