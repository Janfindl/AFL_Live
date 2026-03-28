"use strict";
const http = require("http");
let raw = "";
http.get("http://localhost:3000/api/ratings", res => {
  res.on("data", d => raw += d);
  res.on("end", () => {
    const d = JSON.parse(raw);
    console.log("Teams:", d.teams);
    console.log("Players:", d.players.length);
    d.players.slice(0, 5).forEach(p =>
      console.log(`  ${p.rank}. ${p.name} (${p.team}) value:${p.value} rating:${p.rating}`)
    );
    console.log("Summary:", JSON.stringify(d.summary, null, 2));
  });
}).on("error", e => console.error(e.message));
