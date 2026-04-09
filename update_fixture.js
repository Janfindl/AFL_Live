"use strict";
// Fetches the full 2026 AFL fixture from Squiggle, compares it against the
// stored data/fixture_2026.json, reports any changes, and saves the updated
// file if anything has changed. Run once a week.

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const FIXTURE_FILE = path.join(__dirname, "data", "fixture_2026.json");

function fetchSquiggle() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.squiggle.com.au",
      path:     "/?q=games;year=2026",
      method:   "GET",
      timeout:  15000,
      headers:  { "User-Agent": "AFL-Live-Ratings/1.0 (fixture-updater)" },
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        if (!raw.trim().startsWith("{")) {
          reject(new Error(`Squiggle non-JSON (HTTP ${res.statusCode}): ${raw.slice(0, 120)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Squiggle timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function gameKey(g) { return g.id; }

function diff(oldGames, newGames) {
  const oldMap = new Map(oldGames.map(g => [gameKey(g), g]));
  const newMap = new Map(newGames.map(g => [gameKey(g), g]));
  const changes = [];

  // New games
  for (const [id, g] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ type: "NEW", id, desc: `${g.hteam} vs ${g.ateam} (Round ${g.round}, ${g.date})` });
    }
  }

  // Removed games
  for (const [id, g] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ type: "REMOVED", id, desc: `${g.hteam} vs ${g.ateam} (Round ${g.round})` });
    }
  }

  // Changed fields
  const watchFields = ["date", "venue", "hteam", "ateam", "round", "hscore", "ascore", "complete", "timestr"];
  for (const [id, ng] of newMap) {
    const og = oldMap.get(id);
    if (!og) continue;
    for (const field of watchFields) {
      const ov = og[field] ?? null;
      const nv = ng[field] ?? null;
      if (ov !== nv) {
        changes.push({
          type: "CHANGED",
          id,
          field,
          desc: `${ng.hteam} vs ${ng.ateam} (Round ${ng.round}): ${field} ${JSON.stringify(ov)} → ${JSON.stringify(nv)}`,
        });
      }
    }
  }

  return changes;
}

async function main() {
  console.log(`[fixture-update] ${new Date().toISOString()}`);

  // Load existing fixture
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));
  } catch (e) {
    console.error(`[fixture-update] Could not read ${FIXTURE_FILE}: ${e.message}`);
    process.exit(1);
  }

  // Fetch latest from Squiggle
  let latest;
  try {
    latest = await fetchSquiggle();
  } catch (e) {
    console.error(`[fixture-update] Squiggle fetch failed: ${e.message}`);
    process.exit(1);
  }

  const oldGames = existing.games || [];
  const newGames = latest.games   || [];

  console.log(`[fixture-update] Stored: ${oldGames.length} games  |  Squiggle: ${newGames.length} games`);

  const changes = diff(oldGames, newGames);

  if (changes.length === 0) {
    console.log("[fixture-update] No changes detected.");
    return;
  }

  // Print changes grouped by type
  const byType = { NEW: [], REMOVED: [], CHANGED: [] };
  for (const c of changes) byType[c.type].push(c);

  if (byType.NEW.length)     { console.log(`\n--- ${byType.NEW.length} new game(s) ---`);     byType.NEW.forEach(c => console.log(`  + ${c.desc}`)); }
  if (byType.REMOVED.length) { console.log(`\n--- ${byType.REMOVED.length} removed game(s) ---`); byType.REMOVED.forEach(c => console.log(`  - ${c.desc}`)); }
  if (byType.CHANGED.length) { console.log(`\n--- ${byType.CHANGED.length} field change(s) ---`); byType.CHANGED.forEach(c => console.log(`  ~ ${c.desc}`)); }

  // Save updated fixture
  fs.writeFileSync(FIXTURE_FILE, JSON.stringify(latest, null, 2));
  console.log(`\n[fixture-update] Saved updated fixture to ${FIXTURE_FILE}`);
  console.log("[fixture-update] Commit and push data/fixture_2026.json to deploy the changes.");
}

main().catch(e => { console.error(e); process.exit(1); });
