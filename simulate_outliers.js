"use strict";
/**
 * Outlier commentary simulator
 * Replays the game fetch log, scanning each state for players with 2+
 * statistically unusual stats. Surfaces the top candidate per scan window
 * and generates pundit commentary via Claude.
 *
 * Usage:
 *   node simulate_outliers.js --dry
 *   node simulate_outliers.js --mid 11437
 *   node simulate_outliers.js --threshold 1.3
 */

const path = require("path");
const fs   = require("fs");

// Load .env if present
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8")
    .split(/\r?\n/).forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
} catch {}

const DATA_DIR = path.join(__dirname, "data");

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY       = args.includes("--dry");
const midArg    = (() => { const i = args.indexOf("--mid");       return i >= 0 ? args[i+1] : "11437"; })();
const THRESHOLD = (() => { const i = args.indexOf("--threshold"); return i >= 0 ? parseFloat(args[i+1]) : 2.5; })();

const GAME_FILE = path.join(DATA_DIR, `game_${midArg}.json`);
if (!fs.existsSync(GAME_FILE)) { console.error(`No game file: ${GAME_FILE}`); process.exit(1); }

const game = JSON.parse(fs.readFileSync(GAME_FILE, "utf8"));
const { teams, fetches, bursts = [] } = game;
const [team1, team2] = teams;

// ── Stats ─────────────────────────────────────────────────────────────────────
const ALL_STAT_KEYS  = ["CP","ED","CM","1%","SI","MG","TO","ITC","G","B","T","GA","HO","CG"];
// Stats worth calling out as outliers (skip pure volume accumulators like MG, B)
const OUTLIER_STATS  = ["CP","G","T","SI","HO","CM","ITC","CG","TO"];

// ── Rebuild player states from fetch log ──────────────────────────────────────
function buildPlayerStates(fetchLog) {
  const states    = [];
  const playerMap = {};
  for (const fetch of fetchLog) {
    for (const action of (fetch.actions || [])) {
      const name = action.n;
      if (!playerMap[name]) playerMap[name] = { name, team: action.tm || "" };
      const p = playerMap[name];
      if (action.tm) p.team = action.tm;
      ALL_STAT_KEYS.forEach(k => { if (typeof action[k] === "number") p[k] = action[k]; });
      if (typeof action.v === "number") p.v = action.v;
      if (typeof action.r === "number") p.r = action.r;
    }
    states.push({
      ts: fetch.ts, q: fetch.q, t: fetch.t, s1: fetch.s1, s2: fetch.s2,
      playerMap: Object.fromEntries(Object.entries(playerMap).map(([k, v]) => [k, { ...v }])),
    });
  }
  return states;
}

// ── Z-score computation across all players in this state ──────────────────────
function computeGameStats(players) {
  const result = {};
  for (const stat of OUTLIER_STATS) {
    const vals    = players.map(p => p[stat] || 0);
    const nonzero = vals.filter(v => v > 0);
    if (nonzero.length < 6) continue; // need population
    const mean     = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const stddev   = Math.sqrt(variance);
    if (stddev < 0.3) continue; // no meaningful spread
    result[stat] = { mean, stddev };
  }
  return result;
}

// ── Find players with 2+ outlier stats ───────────────────────────────────────
function findOutliers(players, gameStats, thresh) {
  const candidates = [];
  for (const p of players) {
    const elevated = [];
    for (const [stat, { mean, stddev }] of Object.entries(gameStats)) {
      const val = p[stat] || 0;
      if (val === 0) continue;
      const z = (val - mean) / stddev;
      if (Math.abs(z) >= thresh) {
        elevated.push({ stat, z: +z.toFixed(2), value: val, mean: +mean.toFixed(1), stddev: +stddev.toFixed(1) });
      }
    }
    if (elevated.length < 2) continue;
    elevated.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const combinedZ = elevated.reduce((s, x) => s + Math.abs(x.z), 0);
    candidates.push({ player: p, stats: elevated.slice(0, 4), combinedZ });
  }
  return candidates.sort((a, b) => b.combinedZ - a.combinedZ);
}

// ── Prompt builder ────────────────────────────────────────────────────────────
const Q_NAMES = ["","1st","2nd","3rd","4th"];
function gameTimeStr(q, t) {
  const qMins = t - (q - 1) * 30;
  const mins  = Math.floor(qMins);
  const secs  = Math.round((qMins - mins) * 60);
  return `${Q_NAMES[q] || `Q${q}`} Qtr ${mins}:${String(secs).padStart(2,"0")}`;
}

const PV_STATS = new Set(["CP","ED","CM","1%","SI","MG","TO","ITC","G","B","T","GA","HO","CG"]);

function buildOutlierPrompt(candidate, state, recentBurst) {
  const { player, stats } = candidate;
  const timeStr  = gameTimeStr(state.q, state.t);
  const s1 = state.s1, s2 = state.s2;
  const leader    = s1 > s2 ? team1 : s1 < s2 ? team2 : null;
  const margin    = Math.abs(s1 - s2);
  const scoreLine = leader ? `${leader} lead by ${margin}` : "level";

  // PV stats first, then by z descending
  const sorted = [...stats].sort((a, b) => {
    const ap = PV_STATS.has(a.stat) ? 0 : 1;
    const bp = PV_STATS.has(b.stat) ? 0 : 1;
    return ap - bp || Math.abs(b.z) - Math.abs(a.z);
  });

  const statBlock = sorted
    .map(s => `${s.stat}: ${s.value} (field avg ${s.mean})`)
    .join(", ");

  let burstLine = "";
  if (recentBurst) {
    const top2 = recentBurst.statContribs.slice(0, 2)
      .map(c => `${c.delta > 0 ? "+" : ""}${c.delta} ${c.stat}`).join(", ");
    burstLine = ` Surging last 10 min: ${top2}.`;
  }

  return (
    `You are a live AFL pundit. One pundit line, max 20 words. Vivid, specific, no clichés. ` +
    `Vary your opening — never start with the player's name. ` +
    `Never use mathematical or statistical terminology.\n\n` +
    `${player.name} (${player.team}) at ${timeStr}: ${statBlock}.${burstLine} ` +
    `Score: ${team1} ${s1}–${team2} ${s2} (${scoreLine}).\n\nOne line only. No preamble.`
  );
}

// ── Claude API ────────────────────────────────────────────────────────────────
function callClaude(prompt) {
  if (DRY) return Promise.resolve("[DRY RUN — no API call]");
  return new Promise(resolve => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { resolve("[ANTHROPIC_API_KEY not set]"); return; }
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 75,
      messages: [{ role: "user", content: prompt }],
    });
    const req = require("https").request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      timeout: 15000,
      headers: {
        "Content-Type": "application/json", "x-api-key": apiKey,
        "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).content?.[0]?.text?.trim() || "[empty]"); }
        catch { resolve("[parse error]"); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve("[timeout]"); });
    req.on("error",   e => resolve(`[error: ${e.message}]`));
    req.write(body); req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function simulate() {
  const states = buildPlayerStates(fetches);

  console.log(`\n🔍  Outlier simulation: ${team1} vs ${team2}`);
  console.log(`    Threshold: z ≥ ${THRESHOLD}  |  Min 2 stats  |  Q2+ only`);
  console.log(`    Fetches: ${states.length}  |  Bursts: ${bursts.length}`);
  console.log(DRY ? "    Mode: DRY RUN\n" : "    Mode: LIVE (Claude Haiku)\n");
  console.log("═".repeat(72));

  const NOVELTY_MS = 15 * 60 * 1000; // 15 min between calls for same player
  const SCAN_STEP  = 4;               // scan every 4th fetch (~60s at 15s intervals)

  const noveltyMap  = new Map();
  const scannedMins = new Set(); // deduplicate fetches at the same game-minute
  const log         = [];

  for (let i = 0; i < states.length; i += SCAN_STEP) {
    const state   = states[i];
    if ((state.q || 0) < 2) continue;

    // Skip if we've already scanned this quarter-minute (quarter-end clustering)
    const minKey = `${state.q}:${Math.floor(state.t || 0)}`;
    if (scannedMins.has(minKey)) continue;
    scannedMins.add(minKey);

    const players    = Object.values(state.playerMap);
    const gameStats  = computeGameStats(players);
    const candidates = findOutliers(players, gameStats, THRESHOLD);

    for (const candidate of candidates) {
      const key    = candidate.player.name;
      const lastTs = noveltyMap.get(key) || 0;
      if (state.ts - lastTs < NOVELTY_MS) continue;
      noveltyMap.set(key, state.ts);

      const recentBurst = bursts
        .filter(b => b.name === candidate.player.name && b.endTs <= state.ts)
        .sort((a, b) => b.endTs - a.endTs)[0] || null;

      const timeStr     = gameTimeStr(state.q, state.t);
      const statSummary = candidate.stats
        .map(s => `${s.stat}=${s.value}(z${s.z >= 0 ? "+" : ""}${s.z})`).join("  ");

      console.log(`\n📊  [${timeStr}]  ${candidate.player.name} (${candidate.player.team})  combinedZ=${candidate.combinedZ.toFixed(2)}`);
      console.log(`     ${statSummary}`);

      const prompt = buildOutlierPrompt(candidate, state, recentBurst);
      const line   = await callClaude(prompt);
      console.log(`     "${line}"`);

      log.push({
        ts: state.ts, type: "outlier", timeStr,
        player: candidate.player.name, team: candidate.player.team,
        stats: candidate.stats, combinedZ: +candidate.combinedZ.toFixed(2), line,
      });

      if (!DRY) await new Promise(r => setTimeout(r, 800));
      break; // one outlier surfaced per scan window
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log(`\n✅  Done. ${log.length} outlier commentary lines generated.\n`);

  const outPath = path.join(DATA_DIR, `sim_outliers_${midArg}.json`);
  fs.writeFileSync(outPath, JSON.stringify(log, null, 2));
  console.log(`💾  Saved → ${outPath}`);
}

simulate().catch(e => { console.error(e); process.exit(1); });
