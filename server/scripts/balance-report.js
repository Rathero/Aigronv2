// scripts/balance-report.js — Telemetría de BALANCE desde combates reales.
// Agrega win-rate por TIPO y por HABILIDAD a partir de battles.replay (últimos
// N días, defecto 14). Sin esto, balancear el generador diario es a ciegas.
//
//   node scripts/balance-report.js [días]
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../src/db");

(async () => {
  const days = parseInt(process.argv[2] || "14", 10);
  const r = await db.query(
    "SELECT result, replay FROM battles WHERE replay IS NOT NULL AND created_at > now() - make_interval(days => $1)",
    [days]
  );
  const byType = {}, byAbility = {};
  const bump = (map, key, won) => {
    const e = map[key] || (map[key] = { games: 0, wins: 0 });
    e.games++; if (won) e.wins++;
  };
  for (const row of r.rows) {
    const rep = row.replay;
    if (!rep || !rep.team || !rep.opponent) continue;
    const won = row.result === "WIN";
    for (const u of rep.team) {
      (u.types || [u.type]).filter(Boolean).forEach((ty) => bump(byType, ty, won));
      if (u.ability) bump(byAbility, u.ability, won);
    }
    for (const u of rep.opponent) {
      (u.types || [u.type]).filter(Boolean).forEach((ty) => bump(byType, ty, !won));
      if (u.ability) bump(byAbility, u.ability, !won);
    }
  }
  const table = (map, label) => {
    console.log(`\n=== Win-rate por ${label} (${days} días, ${r.rowCount} combates) ===`);
    const rows = Object.entries(map)
      .filter(([, v]) => v.games >= 5)
      .map(([k, v]) => ({ k, games: v.games, wr: v.wins / v.games }))
      .sort((a, b) => b.wr - a.wr);
    for (const x of rows) {
      const flag = x.wr > 0.56 ? " ⬆ fuerte" : x.wr < 0.44 ? " ⬇ débil" : "";
      console.log(`  ${x.k.padEnd(22)} ${(x.wr * 100).toFixed(1).padStart(5)}%  (${x.games})${flag}`);
    }
    if (!rows.length) console.log("  (sin datos suficientes: se necesitan >=5 apariciones)");
  };
  table(byType, "TIPO");
  table(byAbility, "HABILIDAD");
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
