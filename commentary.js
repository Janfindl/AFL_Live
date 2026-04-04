"use strict";
/**
 * AFL Live Commentary Engine
 * Triggered on each /api/push, detects game events, generates pundit-style
 * commentary via Claude API using AFL_Comms corpus examples for style grounding.
 *
 * Environment variables required:
 *   ANTHROPIC_API_KEY  — Claude API key
 *
 * Exports:
 *   onPush(mid, data, prev)  — call after each push; fire-and-forget
 *   getLog(mid)              — returns commentary log for a game
 */

const https   = require("https");
const fs      = require("fs");
const path    = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL              = "claude-haiku-4-5-20251001";
const MAX_TOKENS         = 100;
const MAX_TOKENS_OUTLIER = 150;
const MAX_LOG            = 60;   // max commentary lines stored per game
const RATE_LIMIT_MS      = 2 * 60 * 1000;   // min gap between same trigger type
const OUTLIER_NOVELTY_MS = 15 * 60 * 1000;  // min gap between outlier calls for same player
const OUTLIER_THRESHOLD  = 2.0;             // min z-score to flag a stat
const OUTLIER_MIN_STATS  = 2;              // player needs this many outlier stats to trigger

// Fields that are metadata, not game stats
const OUTLIER_SKIP = new Set(["name", "team", "value", "projectedValue", "rating", "quarterDelta"]);

// ── Corpus ────────────────────────────────────────────────────────────────────

let _corpus = null;

function loadCorpus() {
  if (_corpus) return _corpus;
  try {
    const p = path.join(DATA_DIR, "commentary_corpus.json");
    _corpus = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log(`[commentary] corpus loaded: ${_corpus.length} examples`);
  } catch {
    _corpus = [];
    console.warn("[commentary] corpus not found — run sync_corpus.js to populate it");
  }
  return _corpus;
}

function getExamples(tags, n = 3) {
  const corpus = loadCorpus();
  if (!corpus.length) return [];
  const pool = corpus.filter(e => e.tags.some(t => tags.includes(t)));
  if (!pool.length) return corpus.slice(0, n).map(e => e.text);
  return pool
    .map(e => ({ e, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map(x => x.e.text);
}

// ── Outlier detection ─────────────────────────────────────────────────────────

function computeGameStats(players) {
  if (!players.length) return {};
  const result = {};
  const keys = Object.keys(players[0]).filter(k => !OUTLIER_SKIP.has(k) && typeof players[0][k] === "number");
  for (const stat of keys) {
    const vals    = players.map(p => p[stat] || 0);
    const nonzero = vals.filter(v => v > 0);
    if (nonzero.length < 6) continue;
    const mean     = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const stddev   = Math.sqrt(variance);
    if (stddev < 0.3) continue;
    result[stat] = { mean, stddev };
  }
  return result;
}

function findTopOutlier(players, gameStats) {
  let best = null;
  for (const p of players) {
    const elevated = [];
    for (const [stat, { mean, stddev }] of Object.entries(gameStats)) {
      const val = p[stat] || 0;
      if (val === 0) continue;
      const z = (val - mean) / stddev;
      if (Math.abs(z) >= OUTLIER_THRESHOLD) {
        elevated.push({ stat, z: +z.toFixed(2), value: val, mean: +mean.toFixed(1), stddev: +stddev.toFixed(1) });
      }
    }
    if (elevated.length < OUTLIER_MIN_STATS) continue;
    elevated.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const combinedZ = elevated.reduce((s, x) => s + Math.abs(x.z), 0);
    if (!best || combinedZ > best.combinedZ) {
      best = { player: p, stats: elevated.slice(0, 4), combinedZ };
    }
  }
  return best;
}

// ── Event detection ───────────────────────────────────────────────────────────

/**
 * Detect new game events by diffing current vs previous state.
 * Returns array of trigger objects ready for prompt building.
 */
function detectTriggers(data, prev) {
  const triggers = [];

  // ── New score events (goals) ──────────────────────────────────────────────
  const prevEventCount = prev?.scoreEvents?.length || 0;
  const newEvents = (data.scoreEvents || []).slice(prevEventCount);
  for (const ev of newEvents) {
    if (ev.type !== "G") continue;
    const scorer = findScorer(ev.team, data.players, prev?.players);
    triggers.push({ type: "goal", team: ev.team, scorer, data });
  }

  // ── New burst detected ────────────────────────────────────────────────────
  const prevBurstCount = prev?.bursts?.length || 0;
  const newBursts = (data.bursts || []).slice(prevBurstCount);
  for (const burst of newBursts) {
    triggers.push({ type: "burst", burst, data });
  }

  // ── Quarter transition ────────────────────────────────────────────────────
  const prevQ = prev?.quarter || 0;
  const curQ  = data.quarter  || 0;
  if (prev && curQ > prevQ && prevQ > 0) {
    triggers.push({ type: "quarter_end", quarter: prevQ, data });
  }

  // ── Significant momentum swing ────────────────────────────────────────────
  const swing = detectMomentumSwing(data, prev);
  if (swing) triggers.push({ type: "momentum", ...swing, data });

  // ── Multi-stat outlier (Q2+ only) ─────────────────────────────────────────
  if (curQ >= 2 && (data.players || []).length >= 10) {
    const gameStats = computeGameStats(data.players);
    const outlier   = findTopOutlier(data.players, gameStats);
    if (outlier) {
      const recentBurst = (data.bursts || [])
        .filter(b => b.name === outlier.player.name)
        .sort((a, b) => b.endTs - a.endTs)[0] || null;
      triggers.push({ type: "outlier", ...outlier, recentBurst, data });
    }
  }

  return triggers;
}

function findScorer(team, players, prevPlayers) {
  if (!prevPlayers || !players) return null;
  const prevMap = Object.fromEntries(prevPlayers.map(p => [p.name, p]));
  const candidates = players
    .filter(p => p.team === team)
    .map(p => ({ p, delta: (p.G || 0) - (prevMap[p.name]?.G || 0) }))
    .filter(x => x.delta > 0)
    .sort((a, b) => b.delta - a.delta);
  return candidates[0]?.p || null;
}

function detectMomentumSwing(data, prev) {
  if (!prev) return null;
  const mom = data.momentum || [];
  if (mom.length < 6) return null;

  const now    = mom[mom.length - 1];
  const fivAgo = mom[Math.max(0, mom.length - 20)];
  const t1 = data.teams?.[0];
  const t2 = data.teams?.[1];
  const d1 = (now.t1 - fivAgo.t1);
  const d2 = (now.t2 - fivAgo.t2);

  if (d1 - d2 > 15) return { swingTeam: t1, otherTeam: t2, delta: +(d1 - d2).toFixed(1) };
  if (d2 - d1 > 15) return { swingTeam: t2, otherTeam: t1, delta: +(d2 - d1).toFixed(1) };
  return null;
}

// ── Prompt building ───────────────────────────────────────────────────────────

function buildPrompt(trigger) {
  const { data } = trigger;
  const t1  = data.teams?.[0] || "Home";
  const t2  = data.teams?.[1] || "Away";
  const s1  = data.summary?.[t1]?.score ?? 0;
  const s2  = data.summary?.[t2]?.score ?? 0;
  const q   = data.quarter || 1;
  const mi  = (data.matchInfo || `Q${q}`).replace(/\s+\d+–\d+$/, "").trim();

  let exampleTags, eventLine, dataLine;

  if (trigger.type === "goal") {
    exampleTags = ["live_call", "stat_based", "colour"];
    const scorer  = trigger.scorer;
    const margin  = Math.abs(s1 - s2);
    const leader  = s1 > s2 ? t1 : s1 < s2 ? t2 : null;
    const scoreLine = leader
      ? `${leader} leads by ${margin} point${margin !== 1 ? "s" : ""}`
      : "scores locked";
    eventLine = scorer
      ? `${scorer.name} (${trigger.team}) has kicked a goal. ${mi}`
      : `${trigger.team} kick a goal. ${mi}`;
    dataLine = `Score: ${t1} ${s1} – ${t2} ${s2} (${scoreLine}).` +
      (scorer ? ` ${scorer.name}: ${scorer.G || 0}g ${scorer.B || 0}b, ${scorer.CP || 0} contested possessions, ${scorer.SI || 0} score involvements, rating ${scorer.rating || "?"}/10.` : "");

  } else if (trigger.type === "burst") {
    exampleTags = ["stat_based", "colour"];
    const b     = trigger.burst;
    const top3  = b.statContribs.slice(0, 3).map(c => `${c.delta > 0 ? "+" : ""}${c.delta} ${c.stat}`).join(", ");
    eventLine = `${b.name} (${b.team}) has been dominant in the last 10 minutes (Q${b.quarter}). ${mi}`;
    dataLine  = `Value burst: +${b.gain} points. Driven by: ${top3}. Score: ${t1} ${s1} – ${t2} ${s2}.`;

  } else if (trigger.type === "quarter_end") {
    exampleTags = ["stat_based", "analysis"];
    const qNames = ["", "first", "second", "third", "fourth"];
    const qLabel = qNames[trigger.quarter] || `Q${trigger.quarter}`;
    const top    = data.players?.[0];
    eventLine = `End of the ${qLabel} quarter. Score: ${t1} ${s1} – ${t2} ${s2}.`;
    dataLine  = top
      ? `Best on ground: ${top.name} (${top.team}), ${top.CP || 0} contested possessions, ${top.G || 0} goals, ${top.T || 0} tackles, rating ${top.rating || "?"}/10.`
      : "";

  } else if (trigger.type === "momentum") {
    exampleTags = ["colour", "stat_based"];
    eventLine = `${trigger.swingTeam} are surging — they have significantly outplayed ${trigger.otherTeam} over the last five minutes. ${mi}`;
    dataLine  = `${trigger.swingTeam} value swing: +${trigger.delta} pts. Score: ${t1} ${s1} – ${t2} ${s2}.`;

  } else if (trigger.type === "outlier") {
    return buildOutlierPrompt(trigger, t1, t2, s1, s2, mi);

  } else {
    return null;
  }

  const examples = getExamples(exampleTags, 3);
  const exBlock  = examples.length
    ? `Real AFL pundit examples (match this style):\n${examples.map(e => `• "${e}"`).join("\n")}\n\n`
    : "";

  return (
    `You are a live AFL radio/TV pundit. Generate one short comment (1-2 sentences max).\n\n` +
    exBlock +
    `Event: ${eventLine}\n` +
    (dataLine ? `Stats: ${dataLine}\n` : "") +
    `\nRespond with only the commentary line. No preamble.`
  );
}

function buildOutlierPrompt(trigger, t1, t2, s1, s2, mi) {
  const { player, stats, recentBurst } = trigger;
  const leader    = s1 > s2 ? t1 : s1 < s2 ? t2 : null;
  const margin    = Math.abs(s1 - s2);
  const scoreLine = leader ? `${leader} lead by ${margin}` : "scores level";

  const statBlock = stats
    .map(s => `  • ${s.stat}: ${s.value}  (z=${s.z >= 0 ? "+" : ""}${s.z}, game avg ${s.mean} ± ${s.stddev})`)
    .join("\n");

  let burstLine = "";
  if (recentBurst) {
    const top2 = recentBurst.statContribs.slice(0, 2)
      .map(c => `${c.delta > 0 ? "+" : ""}${c.delta} ${c.stat}`).join(", ");
    burstLine = `\nRecent surge: +${recentBurst.gain} value pts in last 10 min (${top2}).`;
  }

  return (
    `You are a live AFL pundit.\n\n` +
    `${player.name} (${player.team}) is a multi-stat outlier at ${mi}.\n\n` +
    `Outlier stats vs all players in this game:\n${statBlock}\n` +
    burstLine + `\n` +
    `Score: ${t1} ${s1} – ${t2} ${s2} (${scoreLine}).\n\n` +
    `In 2-3 sentences: what do these stats mean together, how has it changed the game, ` +
    `and what it signals from here. No preamble.`
  );
}

// ── Claude API call ───────────────────────────────────────────────────────────

function callClaude(prompt, maxTokens = MAX_TOKENS) {
  return new Promise(resolve => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { resolve(null); return; }

    const body = JSON.stringify({
      model:      MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      timeout:  10000,
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length":    Buffer.byteLength(body),
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          resolve(r.content?.[0]?.text?.trim() || null);
        } catch { resolve(null); }
      });
    });

    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error",   () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const _lastTriggerTs = new Map();  // `${mid}:${type}` -> ts
const _outlierTs     = new Map();  // `${mid}:${playerName}` -> ts

function isRateLimited(mid, trigger) {
  if (trigger.type === "outlier") {
    const key  = `${mid}:${trigger.player.name}`;
    const last = _outlierTs.get(key) || 0;
    return (Date.now() - last) < OUTLIER_NOVELTY_MS;
  }
  const key  = `${mid}:${trigger.type}`;
  const last = _lastTriggerTs.get(key) || 0;
  return (Date.now() - last) < RATE_LIMIT_MS;
}

function markTriggered(mid, trigger) {
  if (trigger.type === "outlier") {
    _outlierTs.set(`${mid}:${trigger.player.name}`, Date.now());
  } else {
    _lastTriggerTs.set(`${mid}:${trigger.type}`, Date.now());
  }
}

// ── Commentary log ────────────────────────────────────────────────────────────

const _logs = new Map(); // mid -> [{ts, trigger, line, q, matchInfo}]

function addToLog(mid, entry) {
  if (!_logs.has(mid)) _logs.set(mid, []);
  const log = _logs.get(mid);
  log.push(entry);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call after each /api/push. Detects events and fires async commentary
 * generation. Non-blocking — never throws.
 */
async function onPush(mid, data, prev) {
  if (!process.env.ANTHROPIC_API_KEY) return;

  let triggers;
  try {
    triggers = detectTriggers(data, prev);
  } catch (e) {
    console.error("[commentary] detectTriggers:", e.message);
    return;
  }

  for (const trigger of triggers) {
    if (isRateLimited(mid, trigger)) continue;
    markTriggered(mid, trigger);

    try {
      const prompt = buildPrompt(trigger);
      if (!prompt) continue;

      const maxTok = trigger.type === "outlier" ? MAX_TOKENS_OUTLIER : MAX_TOKENS;
      const line   = await callClaude(prompt, maxTok);
      if (!line) continue;

      const entry = {
        ts:        Date.now(),
        trigger:   trigger.type,
        line,
        q:         data.quarter,
        matchInfo: data.matchInfo || null,
        ...(trigger.type === "outlier" ? { player: trigger.player.name } : {}),
      };
      addToLog(String(mid), entry);
      console.log(`[commentary] mid=${mid} [${trigger.type}${trigger.player ? ` ${trigger.player.name}` : ""}] ${line.slice(0, 90)}`);
    } catch (e) {
      console.error(`[commentary] mid=${mid} trigger=${trigger.type}:`, e.message);
    }
  }
}

/**
 * Returns the commentary log for a game (most recent last).
 * Falls back to a saved simulation file (sim_<mid>.json) if no live log exists.
 */
function getLog(mid) {
  const live = _logs.get(String(mid)) || [];
  if (live.length) return live;

  const simPath = path.join(DATA_DIR, `sim_${mid}.json`);
  try {
    const sim = JSON.parse(fs.readFileSync(simPath, "utf8"));
    return sim.map(e => ({
      ts:        e.ts,
      trigger:   e.type,
      line:      e.line,
      matchInfo: e.timeStr,
      q:         null,
    }));
  } catch {
    return [];
  }
}

module.exports = { onPush, getLog };
