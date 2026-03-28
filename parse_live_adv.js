"use strict";
const fs = require("fs");
const os = require("os");

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

function calculateValue(p) {
  let v = CONSTANT;
  for (const [col, w] of Object.entries(WEIGHTS)) {
    v += (typeof p[col] === "number" ? p[col] : 0) * w;
  }
  return Math.round(v * 100) / 100;
}

// Parse rows from a table HTML; colMap = { colName: cellIndex }
function parseTable(html, colMap) {
  const players = {};
  const rowRe = /<tr[^>]*class="(darkcolor|lightcolor)"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = cellRe.exec(rowMatch[2])) !== null) {
      cells.push(c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim());
    }
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

// Column indices for player rows (no leading blank cell in data rows)
// Basic table:  No(0), Player(1), K(2), HB(3), D(4), M(5), G(6), B(7), T(8), HO(9), GA(10), ...
const BASIC_MAP = { _name: 1, G: 6, B: 7, T: 8, HO: 9, GA: 10 };

// Advanced table: No(0), Player(1), CP(2), UP(3), ED(4), DE%(5), CM(6), MI5(7), 1%(8), BO(9), CCL(10), SCL(11), SI(12), MG(13), TO(14), ITC(15), T50(16)
const ADV_MAP = { _name: 1, CP: 2, ED: 4, CM: 6, "1%": 8, SI: 12, MG: 13, TO: 14, ITC: 15 };

function mergeTeam(basicHtml, advHtml, teamName) {
  const basic = parseTable(basicHtml, BASIC_MAP);
  const adv   = parseTable(advHtml,   ADV_MAP);
  const all   = new Set([...Object.keys(basic), ...Object.keys(adv)]);
  return [...all].map(name => ({
    team: teamName,
    ...( basic[name] || {} ),
    ...( adv[name]   || {} ),
    name,
  }));
}

const basicData = JSON.parse(fs.readFileSync(os.tmpdir() + "\\live_stats_basic.json", "utf8"));
const advData   = JSON.parse(fs.readFileSync(os.tmpdir() + "\\live_stats_adv.json",   "utf8"));

const team1 = mergeTeam(basicData.team1, advData.team1, "Collingwood");
const team2 = mergeTeam(basicData.team2, advData.team2, "GWS Giants");
const all   = [...team1, ...team2];

all.forEach(p => {
  p.value  = calculateValue(p);
  p.rating = calcRating(p.value);
});
all.sort((a, b) => b.value - a.value);
all.forEach((p, i) => p.rank = i + 1);

const w  = (s, n) => String(s).padEnd(n);
const wr = (s, n) => String(s).padStart(n);

console.log("\n2026 R3: Collingwood vs GWS Giants — Live Value Ratings (Advanced)");
console.log("=".repeat(105));
console.log(
  w("Rnk",4) + w("Player",22) + w("Team",14) +
  wr("CP",4) + wr("ED",4) + wr("CM",4) + wr("1%",4) +
  wr("SI",4) + wr("MG",6) + wr("TO",4) + wr("ITC",4) +
  wr("G",4) + wr("B",4) + wr("T",4) + wr("GA",4) + wr("HO",4) +
  wr("Value",7) + wr("Rtg",5)
);
console.log("-".repeat(105));
for (const p of all) {
  console.log(
    wr(p.rank,3) + " " + w(p.name,22) + w(p.team,14) +
    wr(p.CP||0,4) + wr(p.ED||0,4) + wr(p.CM||0,4) + wr(p["1%"]||0,4) +
    wr(p.SI||0,4) + wr(p.MG||0,6) + wr(p.TO||0,4) + wr(p.ITC||0,4) +
    wr(p.G||0,4) + wr(p.B||0,4) + wr(p.T||0,4) + wr(p.GA||0,4) + wr(p.HO||0,4) +
    wr(p.value,7) + wr(p.rating,5)
  );
}

console.log("\n--- Team Averages ---");
for (const team of ["Collingwood","GWS Giants"]) {
  const tp = all.filter(p => p.team === team);
  const avgVal = (tp.reduce((s,p) => s + p.value, 0) / tp.length).toFixed(2);
  const avgRat = (tp.reduce((s,p) => s + p.rating, 0) / tp.length).toFixed(1);
  console.log(`${team}: avg value ${avgVal}, avg rating ${avgRat}`);
}
