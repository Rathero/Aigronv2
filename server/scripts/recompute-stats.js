// scripts/recompute-stats.js — Recalcula las stats de las plantillas EXISTENTES al
// sistema físico/especial (6 stats). Las plantillas normales se recomputan de forma
// determinista desde su template_id (genTemplate). Las fusiones rellenan físico=especial
// desde sus stats antiguas. No borra nada: actualiza en sitio (instancias intactas).
//
//   node scripts/recompute-stats.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../src/db");
const E = require("../src/config");

(async () => {
  // 1. Plantillas normales: recomputar desde el id (determinista).
  const r = await db.query("SELECT template_id FROM creature_templates WHERE is_fusion = false");
  let n = 0;
  for (const row of r.rows) {
    const t = E.genTemplate(row.template_id);
    const s = t.base_stats;
    await db.query(
      `UPDATE creature_templates SET
         base_hp=$1, base_spd=$2,
         base_atk_p=$3, base_atk_s=$4, base_def_p=$5, base_def_s=$6,
         base_atk=$3, base_def=$5, lore=$7
       WHERE template_id=$8`,
      [s.hp, s.spd, s.atkP, s.atkS, s.defP, s.defS, t.lore, row.template_id]
    );
    n++;
  }
  // 2. Fusiones: rellenar las columnas nuevas desde las antiguas si faltan.
  const f = await db.query(
    `UPDATE creature_templates SET
       base_atk_p=COALESCE(base_atk_p,base_atk), base_atk_s=COALESCE(base_atk_s,base_atk),
       base_def_p=COALESCE(base_def_p,base_def), base_def_s=COALESCE(base_def_s,base_def)
     WHERE is_fusion = true AND base_atk_p IS NULL`
  );
  console.log(`[recompute] ${n} plantillas recomputadas, ${f.rowCount} fusiones rellenadas.`);
  await db.pool.end();
})();
