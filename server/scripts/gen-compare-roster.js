// scripts/gen-compare-roster.js — Genera, para CADA tipo, una plantilla de
// referencia y 4 instancias (niveles 1/25/50/100) en el usuario, para comparar
// estadísticas y escalado entre tipos y niveles. Idempotente: re-ejecutar
// refresca las plantillas cmp_* y reemplaza sus instancias en el usuario.
//
//   node scripts/gen-compare-roster.js [emailOAuthSubject|userId]
//
// Notas de diseño (para la comparación):
//  - Rareza FIJA = EPICA en todos -> el rango de stats es el mismo, así la
//    comparación aísla TIPO/clase/habilidad y el escalado por nivel.
//  - Las stats base son un roll DETERMINISTA por tipo (semilla = hash del tipo).
//  - Tipo ÚNICO (sin segundo tipo) para que la tarjeta sea limpia.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../src/db");
const E = require("../src/config");

const LEVELS = [1, 25, 50, 100];
const RARITY = "EPICA";

// Plantilla de referencia determinista para un tipo.
function refTemplate(type) {
  const rng = E.mulberry32(E.hashStr("cmp:" + type));
  const rg = E.RANGES[RARITY];
  const pr = (range) => E.pickRange(rng, range);
  const base = { hp: pr(rg.hp), atkP: pr(rg.atkP), atkS: pr(rg.atkS), defP: pr(rg.defP), defS: pr(rg.defS), spd: pr(rg.spd) };
  const pool = E.ABILITY_BY_TYPE[type];
  const ability = pool[Math.floor(rng() * pool.length)];
  const cls = E.isPhysical(type) ? "Físico" : "Especial";
  return { template_id: "cmp_" + type, type, rarity: RARITY, base, ability, cls, name: `[${type}] Ref` };
}

(async () => {
  const arg = process.argv[2];
  // 1. Resolver usuario: por id/auth_subject/display_name si se pasa; si no, el de
  //    más instancias (en prod = tú, el jugador real). Imprime candidatos para verificar.
  let user;
  if (arg) {
    const r = await db.query(
      "SELECT id, display_name FROM users WHERE id::text=$1 OR auth_subject=$1 OR display_name=$1 LIMIT 1", [arg]);
    user = r.rows[0];
    if (!user) { console.error(`No encontré usuario "${arg}".`); process.exit(1); }
  } else {
    const r = await db.query(
      `SELECT u.id, u.display_name, u.auth_provider, count(ci.instance_id) AS n
         FROM users u LEFT JOIN creature_instances ci ON ci.user_id=u.id
        GROUP BY u.id ORDER BY n DESC, u.created_at ASC LIMIT 5`);
    user = r.rows[0];
    if (!user) { console.error("No hay usuario. Abre la app una vez para crear tu usuario."); process.exit(1); }
    console.log("Candidatos (más instancias primero) — si no es el tuyo, re-ejecuta con: node scripts/gen-compare-roster.js <id|nombre>");
    r.rows.forEach((x) => console.log(`  ${x.n.toString().padStart(4)}  ${String(x.display_name).padEnd(20)} ${x.auth_provider.padEnd(8)} ${x.id}`));
  }
  console.log(`\n>> Usuario elegido: ${user.display_name} (${user.id})`);

  // 2. Upsert de las 20 plantillas de referencia.
  const tpls = E.TYPES.map(refTemplate);
  for (const t of tpls) {
    const b = t.base;
    await db.query(
      `INSERT INTO creature_templates
         (template_id, batch_date, name, species_tags, type, type2, rarity,
          base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s,
          ability_id, lore, art_seed, quality_score, is_fusion)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, NULL, $5, $6,$7,$8,$9,$10,$11,$12,$13, $14, $15, $16, 1.0, false)
       ON CONFLICT (template_id) DO UPDATE SET
         name=EXCLUDED.name, type=EXCLUDED.type, type2=NULL, rarity=EXCLUDED.rarity,
         base_hp=EXCLUDED.base_hp, base_atk=EXCLUDED.base_atk, base_def=EXCLUDED.base_def, base_spd=EXCLUDED.base_spd,
         base_atk_p=EXCLUDED.base_atk_p, base_atk_s=EXCLUDED.base_atk_s, base_def_p=EXCLUDED.base_def_p, base_def_s=EXCLUDED.base_def_s,
         ability_id=EXCLUDED.ability_id`,
      [t.template_id, t.name, [t.type.toLowerCase(), "ref"], t.type, t.rarity,
       b.hp, b.atkP, b.defP, b.spd, b.atkP, b.atkS, b.defP, b.defS,
       t.ability, `Referencia de comparación del tipo ${t.type} (${t.cls}).`, E.hashStr("cmp:" + t.type)]
    );
  }

  // 3. Reemplazar las instancias cmp_* del usuario (idempotente).
  const cmpIds = tpls.map((t) => t.template_id);
  await db.query(
    "DELETE FROM creature_instances WHERE user_id=$1 AND template_id = ANY($2::text[])",
    [user.id, cmpIds]);
  let count = 0;
  for (const t of tpls) for (const lvl of LEVELS) {
    await db.query(
      "INSERT INTO creature_instances (user_id, template_id, level) VALUES ($1,$2,$3)",
      [user.id, t.template_id, lvl]);
    count++;
  }

  // 4. Tabla de comparación por consola.
  const sc = (base, lvl) => E.scaled(base, lvl);
  console.log(`\nGeneradas ${count} instancias (${E.TYPES.length} tipos x ${LEVELS.length} niveles). Rareza ${RARITY}.`);
  console.log("Aviso: stats base dependen de la RAREZA, no del tipo (RANGES). El tipo cambia clase/efectividad/habilidad.\n");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("TIPO", 9) + pad("CLASE", 9) + pad("HABILIDAD", 12) + "NIVEL  " + pad("HP", 7) + pad("ATK", 6) + pad("DEF", 6) + "SPD");
  for (const t of tpls) {
    const atk = E.isPhysical(t.type) ? t.base.atkP : t.base.atkS;
    const def = E.isPhysical(t.type) ? t.base.defP : t.base.defS;
    LEVELS.forEach((lvl, i) => {
      console.log(
        pad(i === 0 ? t.type : "", 9) + pad(i === 0 ? t.cls : "", 9) +
        pad(i === 0 ? E.ABILITIES[t.ability].name : "", 12) +
        pad(lvl, 7) + pad(sc(t.base.hp, lvl), 7) + pad(sc(atk, lvl), 6) + pad(sc(def, lvl), 6) + sc(t.base.spd, lvl));
    });
  }
  await db.pool.end();
})();
