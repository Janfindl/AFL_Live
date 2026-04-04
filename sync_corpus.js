"use strict";
/**
 * sync_corpus.js
 * Copies the best commentary examples from AFL_Comms into AFL_Live.
 * Run this whenever you add more videos to AFL_Comms:
 *
 *   node sync_corpus.js
 *
 * Output: AFL_Live/data/commentary_corpus.json
 */

const fs   = require("fs");
const path = require("path");

const SRC  = path.join(__dirname, "..", "AFL_Comms", "data", "processed", "corpus.json");
const DEST = path.join(__dirname, "data", "commentary_corpus.json");

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source corpus not found: ${SRC}`);
    console.error("Run 'node process.js' in AFL_Comms first.");
    process.exit(1);
  }

  const corpus = JSON.parse(fs.readFileSync(SRC, "utf8"));
  console.log(`Loaded ${corpus.length} sentences from AFL_Comms corpus.`);

  // Keep only tagged sentences (not pure 'general') and apply quality filters
  const filtered = corpus.filter(e => {
    // Must have at least one non-general tag, or be a good general line
    const hasTag = e.tags.some(t => t !== "general");
    if (!hasTag) return false;

    const t = e.text;
    // Min length — single words / fragments not useful
    if (t.split(/\s+/).length < 6) return false;
    // Drop lines that are mostly noise (music, applause, etc.)
    if (/^\[/.test(t)) return false;
    // Drop lines with garbled speech patterns
    if ((t.match(/\bum\b|\buh\b/gi) || []).length > 2) return false;

    return true;
  });

  console.log(`Filtered to ${filtered.length} quality examples.`);

  // Limit per tag to keep corpus balanced and lean
  const PER_TAG = 60;
  const tagBuckets = { stat_based: [], live_call: [], colour: [], analysis: [] };
  for (const e of filtered) {
    for (const tag of e.tags) {
      if (tagBuckets[tag] && tagBuckets[tag].length < PER_TAG) {
        tagBuckets[tag].push(e);
        break;
      }
    }
  }

  const out = Object.values(tagBuckets).flat();
  // Shuffle so prompts get varied examples on each call
  out.sort(() => Math.random() - 0.5);

  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, JSON.stringify(out, null, 2), "utf8");

  const tagCounts = {};
  for (const e of out) {
    for (const t of e.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  console.log("\nCorpus written to:", DEST);
  console.log("Tag breakdown:");
  for (const [tag, n] of Object.entries(tagCounts)) {
    console.log(`  ${tag.padEnd(14)}: ${n}`);
  }
  console.log(`\nTotal examples: ${out.length}`);
}

main();
