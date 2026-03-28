"use strict";
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(
  require("os").tmpdir() + "\\live_stats_adv.json", "utf8"
));

// Print header row and first 3 player rows to understand column structure
const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
let m, count = 0;
while ((m = rowRe.exec(data.team1)) !== null && count < 6) {
  const row = m[1];
  if (!row.includes("<td") && !row.includes("<th")) continue;
  const cells = [];
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  let c;
  while ((c = cellRe.exec(row)) !== null) {
    const text = c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim();
    cells.push(text);
  }
  if (cells.length > 3) {
    console.log(`Row ${count} (${cells.length} cells): ${JSON.stringify(cells)}`);
    count++;
  }
}
