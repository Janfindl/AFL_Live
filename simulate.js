"use strict";
/**
 * AFL Commentary Simulator
 * Replays a saved game's fetch log and generates pundit commentary
 * for goals, bursts and quarter ends using the real event timestamps.
 *
 * Usage:
 *   node simulate.js                    # defaults to game_11437.json
 *   node simulate.js --mid 11429
 *   node simulate.js --mid 11437 --dry  # detect triggers only, no Claude calls
 */

const https = require("https");
const fs    = require("path");
const path  = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const CORPUS_PATH = path.join(DATA_DIR, "commentary_corpus.json");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const midArg = args[indexOf("--mid") + 1] || "11437";
const DRY   = args.includes("--dry");
function indexOf(flag) { const i = args.indexOf(flag); return i === -1 ? -Infinity : i; }

const GAME_FILE = path.join(DATA_DIR, `game_${midArg}.json`);
if (!require("fs").existsSync(GAME_FILE)) {
  console.error(`No game file found: ${GAME_FILE}`);
  process.exit(1);
}

// ── Load game data ────────────────────────────────────────────────────────────
const game = JSON.parse(require("fs").readFileSync(GAME_FILE, "utf8"));
const { teams, fetches, scoreEvents, bursts, momentum, completedQuarters } = game;
const [team1, team2] = teams;

console.log(`\n🏉  Simulating: ${team1} vs ${team2}`);
console.log(`   Fetches: ${fetches.length}  |  Score events: ${scoreEvents.length}  |  Bursts: ${bursts.length}`);
console.log(`   Completed quarters: Q${Object.keys(completedQuarters || {}).join(", Q")}`);
console.log(DRY ? "   Mode: DRY RUN (no Claude calls)\n" : `   Mode: LIVE (Claude Haiku)\n`);

// ── Weights (must match collector.js) ─────────────────────────────────────────
const WEIGHTS = {
  CP:0.970085, ED:0.644891, CM:0.693636, "1%":0.636595,
  SI:0.404205, MG:0.018249, TO:-0.279263, ITC:0.398164,
  G:4.089152, B:-1.444759, T:0.712906, GA:1.012134, HO:0.251832, CG:-1.124769,
};
const STAT_KEYS = Object.keys(WEIGHTS);

// ── Corpus ────────────────────────────────────────────────────────────────────
let corpus = [];
try { corpus = JSON.parse(require("fs").readFileSync(CORPUS_PATH, "utf8")); } catch {}

function getExamples(tags, n = 3) {
  const pool = corpus.filter(e => e.tags.some(t => tags.includes(t)));
  return (pool.length ? pool : corpus)
    .map(e => ({ e, r: Math.random() })).sort((a, b) => a.r - b.r)
    .slice(0, n).map(x => x.e.text);
}

// ── Claude API ────────────────────────────────────────────────────────────────
function callClaude(prompt) {
  if (DRY) return Promise.resolve("[DRY RUN — no API call]");
  return new Promise(resolve => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { resolve("[ANTHROPIC_API_KEY not set]"); return; }
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
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
        try { resolve(JSON.parse(d).content?.[0]?.text?.trim() || "[empty response]"); }
        catch { resolve("[parse error]"); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve("[timeout]"); });
    req.on("error", e => resolve(`[error: ${e.message}]`));
    req.write(body); req.end();
  });
}

// ── Game time helpers ─────────────────────────────────────────────────────────
const Q_NAMES = ["", "1st", "2nd", "3rd", "4th"];
function gameTimeStr(q, tElapsed) {
  const qMins  = (tElapsed - (q - 1) * 30);
  const mins   = Math.floor(qMins);
  const secs   = Math.round((qMins - mins) * 60);
  return `${Q_NAMES[q] || `Q${q}`} Quarter ${mins}:${String(secs).padStart(2, "0")}`;
}

// ── Reconstruct player states from fetch log ──────────────────────────────────
function buildPlayerStates(fetchLog) {
  // Returns array of { ts, q, t, s1, s2, playerMap }
  // playerMap: name -> { name, team, ...stats, v, r }
  const states = [];
  const playerMap = {};

  for (const fetch of fetchLog) {
    for (const action of (fetch.actions || [])) {
      const name = action.n;
      if (!playerMap[name]) playerMap[name] = { name, team: action.tm || "" };
      const p = playerMap[name];
      if (action.tm) p.team = action.tm;
      // Apply all stat/value fields from this action
      STAT_KEYS.forEach(k => { if (typeof action[k] === "number") p[k] = action[k]; });
      if (typeof action.v === "number") p.v = action.v;
      if (typeof action.r === "number") p.r = action.r;
    }
    states.push({
      ts: fetch.ts,
      q:  fetch.q,
      t:  fetch.t,
      s1: fetch.s1,
      s2: fetch.s2,
      // Deep-copy current player states
      playerMap: Object.fromEntries(
        Object.entries(playerMap).map(([k, v]) => [k, { ...v }])
      ),
    });
  }
  return states;
}

// ── Build synthetic game-state object for commentary prompts ──────────────────
function buildGameState(state, allScoreEvents, allBursts, allMomentum) {
  const players = Object.values(state.playerMap)
    .sort((a, b) => (b.v || 0) - (a.v || 0));

  const summary = {};
  for (const tm of teams) {
    const tp = players.filter(p => p.team === tm);
    const score = tm === team1 ? state.s1 : state.s2;
    summary[tm] = {
      score,
      avgRating:    +(tp.reduce((s, p) => s + (p.r || 0), 0) / (tp.length || 1)).toFixed(1),
      avgProjected: +(tp.reduce((s, p) => s + (p.v || 0), 0) / (tp.length || 1)).toFixed(1),
      topPlayer:    tp[0]?.name || "—",
    };
  }

  const matchInfo = `${gameTimeStr(state.q, state.t)}  ${state.s1}–${state.s2}`;

  return {
    teams,
    quarter: state.q,
    elapsedMins: state.t,
    matchInfo,
    score1: state.s1,
    score2: state.s2,
    players: players.map(p => ({
      name: p.name, team: p.team,
      value: p.v || 0, projectedValue: p.v || 0, rating: p.r || 0,
      ...Object.fromEntries(STAT_KEYS.map(k => [k, p[k] || 0])),
    })),
    scoreEvents: allScoreEvents.filter(e => e.ts <= state.ts),
    bursts:      allBursts.filter(b => b.endTs <= state.ts),
    momentum:    allMomentum.filter(m => m.ts <= state.ts),
    summary,
  };
}

// ── Prompt builders ───────────────────────────────────────────────────────────
function buildGoalPrompt(team, scorer, gameState) {
  const { teams, matchInfo, summary } = gameState;
  const [t1, t2] = teams;
  const s1 = summary[t1]?.score ?? 0;
  const s2 = summary[t2]?.score ?? 0;
  const margin = Math.abs(s1 - s2);
  const leader = s1 > s2 ? t1 : s1 < s2 ? t2 : null;
  const scoreLine = leader ? `${leader} lead by ${margin}` : "level";
  const examples = getExamples(["live_call", "stat_based", "colour"], 3);
  const exBlock = examples.length
    ? `Real AFL pundit examples:\n${examples.map(e => `• "${e}"`).join("\n")}\n\n`
    : "";

  const scorerLine = scorer
    ? `${scorer.name} (${team}) kicks a goal. ${scorer.name}: ${scorer.G || 0}g ${scorer.B || 0}b, ${scorer.CP || 0} CP, rating ${scorer.rating || "?"}/10.`
    : `${team} kick a goal.`;

  return `You are a live AFL pundit. ${exBlock}Event: ${scorerLine} ${matchInfo}\nScore: ${t1} ${s1} – ${t2} ${s2} (${scoreLine}).\n\nOne pundit comment (1-2 sentences). No preamble.`;
}

function buildBurstPrompt(burst, gameState) {
  const { teams, matchInfo, summary } = gameState;
  const [t1, t2] = teams;
  const s1 = summary[t1]?.score ?? 0;
  const s2 = summary[t2]?.score ?? 0;
  const top3 = burst.statContribs.slice(0, 3).map(c => `${c.delta > 0 ? "+" : ""}${c.delta} ${c.stat}`).join(", ");
  const examples = getExamples(["stat_based", "colour"], 3);
  const exBlock = examples.length
    ? `Real AFL pundit examples:\n${examples.map(e => `• "${e}"`).join("\n")}\n\n`
    : "";

  return `You are a live AFL pundit. ${exBlock}Event: ${burst.name} (${burst.team}) has been dominant over the last 10 minutes — value burst of +${burst.gain} pts. Key stats: ${top3}. ${matchInfo}\nScore: ${t1} ${s1} – ${t2} ${s2}.\n\nOne pundit comment (1-2 sentences). No preamble.`;
}

function buildQuarterEndPrompt(q, gameState) {
  const { teams, summary, players } = gameState;
  const [t1, t2] = teams;
  const s1 = summary[t1]?.score ?? 0;
  const s2 = summary[t2]?.score ?? 0;
  const leader = s1 > s2 ? t1 : s1 < s2 ? t2 : null;
  const top = players[0];
  const qLabels = ["", "first", "second", "third", "fourth"];
  const examples = getExamples(["stat_based", "analysis"], 3);
  const exBlock = examples.length
    ? `Real AFL pundit examples:\n${examples.map(e => `• "${e}"`).join("\n")}\n\n`
    : "";

  return `You are a live AFL pundit. ${exBlock}Event: End of the ${qLabels[q] || `Q${q}`} quarter. Score: ${t1} ${s1} – ${t2} ${s2}${leader ? `, ${leader} lead by ${Math.abs(s1-s2)}` : ", level"}.\nBest on ground: ${top?.name} (${top?.team}), ${top?.CP||0} CP, ${top?.G||0} goals, ${top?.T||0} tackles, rating ${top?.rating||"?"}/10.\n\nOne pundit comment (1-2 sentences). No preamble.`;
}

// ── Find closest state to a timestamp ─────────────────────────────────────────
function stateAtTs(states, ts) {
  // Find the last state at or before ts
  let best = states[0];
  for (const s of states) {
    if (s.ts <= ts) best = s;
    else break;
  }
  return best;
}

function findScorer(team, prevState, currState) {
  const prev = prevState?.playerMap || {};
  const curr = currState?.playerMap || {};
  let best = null, bestDelta = 0;
  for (const [name, p] of Object.entries(curr)) {
    if (p.team !== team) continue;
    const prevG = prev[name]?.G || 0;
    const delta = (p.G || 0) - prevG;
    if (delta > bestDelta) { bestDelta = delta; best = p; }
  }
  return best;
}

// ── Simulation ────────────────────────────────────────────────────────────────
async function simulate() {
  const states = buildPlayerStates(fetches);
  const log    = [];

  // Find all goal events (not behinds)
  const goals = scoreEvents.filter(e => e.type === "G");

  // Quarter-end timestamps: last fetch of each completed quarter
  const quarterEndFetches = {};
  for (const s of states) {
    if (s.q && s.q <= 4) quarterEndFetches[s.q] = s;
  }

  // Build trigger list: goals + bursts + quarter ends, sorted by ts
  const triggers = [];

  goals.forEach((ev, i) => {
    const stateIdx = states.findIndex(s => s.ts >= ev.ts);
    const currState = states[Math.max(0, stateIdx)];
    const prevState = states[Math.max(0, stateIdx - 1)];
    triggers.push({ type: "goal", ts: ev.ts, team: ev.team, currState, prevState, goalIdx: i });
  });

  bursts.forEach(b => {
    const stateIdx = states.findIndex(s => s.ts >= b.endTs);
    const currState = states[Math.max(0, stateIdx)];
    triggers.push({ type: "burst", ts: b.endTs, burst: b, currState });
  });

  Object.entries(completedQuarters).forEach(([q, _]) => {
    const qNum = parseInt(q);
    // Find the fetch where quarter changed (last fetch of that quarter)
    let lastQState = null;
    for (const s of states) { if (s.q === qNum) lastQState = s; else if (s.q > qNum) break; }
    if (lastQState) triggers.push({ type: "quarter_end", ts: lastQState.ts, quarter: qNum, currState: lastQState });
  });

  triggers.sort((a, b) => a.ts - b.ts);

  console.log(`📋  Triggers: ${goals.length} goals, ${bursts.length} bursts, ${Object.keys(completedQuarters).length} quarter ends = ${triggers.length} total\n`);
  console.log("═".repeat(72));

  for (const trigger of triggers) {
    const gameState = buildGameState(
      trigger.currState,
      scoreEvents, bursts, momentum
    );

    let label, prompt, icon;
    if (trigger.type === "goal") {
      const scorer = findScorer(trigger.team, trigger.prevState, trigger.currState);
      icon  = "🎯";
      label = `GOAL  ${trigger.team}`;
      prompt = buildGoalPrompt(trigger.team, scorer ? { ...scorer, rating: scorer.r } : null, gameState);
    } else if (trigger.type === "burst") {
      icon  = "⚡";
      label = `BURST  ${trigger.burst.name} (${trigger.burst.team})  +${trigger.burst.gain}`;
      prompt = buildBurstPrompt(trigger.burst, gameState);
    } else {
      icon  = "🏁";
      label = `Q${trigger.quarter} END`;
      prompt = buildQuarterEndPrompt(trigger.quarter, gameState);
    }

    const timeStr = gameState.matchInfo;
    console.log(`\n${icon}  [${timeStr}]  ${label}`);

    const line = await callClaude(prompt);
    console.log(`   "${line}"`);

    log.push({ ts: trigger.ts, type: trigger.type, label, timeStr, line });

    // Polite gap between API calls
    if (!DRY) await new Promise(r => setTimeout(r, 800));
  }

  console.log("\n" + "═".repeat(72));
  console.log(`\n✅  Simulation complete. ${log.length} commentary lines generated.\n`);

  // Save output
  const outPath = path.join(DATA_DIR, `sim_${midArg}.json`);
  require("fs").writeFileSync(outPath, JSON.stringify(log, null, 2), "utf8");
  console.log(`💾  Saved to ${outPath}`);
}

simulate().catch(e => { console.error(e); process.exit(1); });
