// =============================================================================
// innovations.js — Lógica de servidor de las mecánicas innovadoras con estado:
// Puzzle Diario, Jefe Mundial y Némesis. (Ecos viven en dungeon.js; Prismáticas
// y Oráculo son deterministas en el motor, sin estado de servidor.)
//
// El servidor es AUTORITATIVO: revalida los combates con el motor compartido.
// Cada mecánica está detrás de su flag (features.js); los endpoints comprueban
// el flag y responden 404 si está apagada.
// =============================================================================
const E = require("./config");
const db = require("./db");
const { weekStart } = require("./leagues");

const wkStr = () => E.todayStr(weekStart());

// Reconstruye unidades de combate desde ids de plantilla del lote (nivel fijo).
function unitsFromIds(ids, level, team, templatesById) {
  return ids.map((id, i) => {
    const t = templatesById[id];
    if (!t) return null;
    return E.buildUnit({ id, name: t.name, type: t.type, types: t.types, ability: t.ability, base_stats: t.base_stats }, level, team, i);
  }).filter(Boolean);
}

// --------------------------------- PUZZLE ------------------------------------
// Valida la solución del puzzle del día con el motor y guarda el mejor resultado.
// decisions = las del jugador (equipo A). Devuelve { solved, turns, hpLeft, best }.
async function solvePuzzle(userId, decisions, templates) {
  const date = E.todayStr();
  const byId = {}; templates.forEach((t) => (byId[t.id || t.template_id] = normTpl(t)));
  const pz = E.dailyPuzzle(date, templates);
  const A = unitsFromIds(pz.team, pz.level, "A", byId);
  const B = unitsFromIds(pz.enemy, pz.level, "B", byId);
  if (A.length < 3 || B.length < 3) throw new Error("puzzle_unavailable");
  const safe = sanitizeDecisions(decisions);
  const r = E.resolveBattle(A, B, pz.seed | 0, safe);
  const solved = r.winner === "A";
  const turns = r.turns;
  const hpLeft = Math.round(r.hpA);
  if (solved) {
    // Guarda solo si MEJORA (menos turnos; desempata más HP). Atómico por upsert.
    await db.query(
      `INSERT INTO puzzle_results (daily_date, user_id, turns, hp_left, solved)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (daily_date, user_id) DO UPDATE SET
         turns = LEAST(puzzle_results.turns, EXCLUDED.turns),
         hp_left = CASE WHEN EXCLUDED.turns < puzzle_results.turns THEN EXCLUDED.hp_left
                        WHEN EXCLUDED.turns = puzzle_results.turns THEN GREATEST(puzzle_results.hp_left, EXCLUDED.hp_left)
                        ELSE puzzle_results.hp_left END,
         solved = true`,
      [date, userId, turns, hpLeft]
    );
  }
  const best = (await db.query("SELECT turns, hp_left, solved FROM puzzle_results WHERE daily_date=$1 AND user_id=$2", [date, userId])).rows[0] || null;
  return { solved, turns, hpLeft, best };
}
async function puzzleRanking(userId) {
  const date = E.todayStr();
  const r = await db.query(
    `SELECT u.display_name AS name, p.turns, p.hp_left, p.user_id
       FROM puzzle_results p JOIN users u ON u.id=p.user_id
      WHERE p.daily_date=$1 AND p.solved=true
      ORDER BY p.turns ASC, p.hp_left DESC LIMIT 50`, [date]);
  const rows = r.rows.map((x, i) => ({ pos: i + 1, name: x.name, turns: x.turns, hpLeft: x.hp_left, me: x.user_id === userId }));
  const mine = (await db.query("SELECT turns, hp_left FROM puzzle_results WHERE daily_date=$1 AND user_id=$2 AND solved=true", [date, userId])).rows[0];
  let me = rows.find((x) => x.me) || null;
  if (!me && mine) {
    const pos = await db.query("SELECT COUNT(*)::int AS n FROM puzzle_results WHERE daily_date=$1 AND solved=true AND (turns < $2 OR (turns=$2 AND hp_left > $3))", [date, mine.turns, mine.hp_left]);
    me = { pos: pos.rows[0].n + 1, turns: mine.turns, hpLeft: mine.hp_left };
  }
  return { rows, me };
}

// ------------------------------- JEFE MUNDIAL --------------------------------
// Crea/lee el jefe de la semana (HP gigante = base * usuarios estimados).
async function getOrCreateBoss() {
  const wk = wkStr();
  const id = "boss:" + wk;
  let r = await db.query("SELECT * FROM world_boss WHERE id=$1", [id]);
  if (!r.rowCount) {
    const seed = E.hashStr("worldboss:" + wk) >>> 0;
    const type = E.TYPES[seed % E.TYPES.length];
    const name = E.nemesisName("wb:" + wk).toUpperCase(); // nombre épico determinista
    const hp = 2000000 + (seed % 1000) * 5000; // ~2-7M, ajustable por comunidad
    await db.query(
      `INSERT INTO world_boss (id, week_start, name, type, hp_max, hp_left)
       VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (id) DO NOTHING`,
      [id, wk, name, type, hp]
    );
    r = await db.query("SELECT * FROM world_boss WHERE id=$1", [id]);
  }
  return r.rows[0];
}
async function bossState(userId) {
  const b = await getOrCreateBoss();
  const top = await db.query(
    `SELECT u.display_name AS name, c.damage, c.user_id
       FROM world_boss_contrib c JOIN users u ON u.id=c.user_id
      WHERE c.boss_id=$1 ORDER BY c.damage DESC LIMIT 10`, [b.id]);
  const mine = (await db.query("SELECT damage, hits FROM world_boss_contrib WHERE boss_id=$1 AND user_id=$2", [b.id, userId])).rows[0];
  return {
    id: b.id, name: b.name, type: b.type,
    hpMax: Number(b.hp_max), hpLeft: Number(b.hp_left),
    pct: Math.max(0, Math.round(Number(b.hp_left) / Number(b.hp_max) * 100)),
    defeated: !!b.defeated_at,
    top: top.rows.map((x, i) => ({ pos: i + 1, name: x.name, damage: Number(x.damage), me: x.user_id === userId })),
    myDamage: mine ? Number(mine.damage) : 0, myHits: mine ? mine.hits : 0,
  };
}
// Golpea al jefe: el cliente manda decisiones, el servidor calcula el daño con
// el motor (combate contra un "saco" del tipo del jefe) y lo descuenta atómicamente.
async function hitBoss(userId, decisions, templates, user) {
  if (!templates.length) throw new Error("no_templates");
  const b = await getOrCreateBoss();
  if (b.defeated_at) return { defeated: true, boss: await bossState(userId) };
  const byId = {}; templates.forEach((t) => (byId[t.id || t.template_id] = normTpl(t)));
  // Tu equipo real vs 3 sacos del tipo del jefe (mismo nivel): el daño que haces
  // en 8 turnos = tu "golpe" al jefe. Determinista por usuario+intento.
  const teamIds = (await teamIdsOf(userId)) || templates.slice(0, 3).map((t) => t.id || t.template_id);
  const seed = (E.hashStr("wbhit:" + userId + ":" + b.id) ^ (b.hp_left & 0xffffff)) >>> 0;
  const A = unitsFromIds(teamIds, 12, "A", byId);
  if (!A.length) throw new Error("empty_team");
  const bossTpl = templates.find((t) => (t.types || [t.type]).includes(b.type)) || templates[0];
  const Bteam = [0, 1, 2].map((i) => E.buildUnit(normTpl(bossTpl), 12, "B", i));
  const r = E.resolveBattle(A, Bteam, seed, sanitizeDecisions(decisions));
  // Daño al jefe = daño total infligido por A (suma de golpes en el log).
  let dmg = 0;
  r.log.forEach((e) => { if (e.uid && e.uid[0] === "A") (e.hits || []).forEach((h) => (dmg += h.dmg || 0)); });
  dmg = Math.max(1, Math.round(dmg));
  // Descuento atómico + contribución (no baja de 0; marca derrotado al llegar).
  const upd = await db.query(
    `UPDATE world_boss SET hp_left = GREATEST(0, hp_left - $1),
       defeated_at = CASE WHEN hp_left - $1 <= 0 AND defeated_at IS NULL THEN now() ELSE defeated_at END
     WHERE id=$2 RETURNING hp_left, defeated_at`, [dmg, b.id]);
  await db.query(
    `INSERT INTO world_boss_contrib (boss_id, user_id, damage, hits) VALUES ($1,$2,$3,1)
     ON CONFLICT (boss_id, user_id) DO UPDATE SET damage = world_boss_contrib.damage + $3, hits = world_boss_contrib.hits + 1`,
    [b.id, userId, dmg]
  );
  // Recompensa pequeña por golpe (monedas), incentiva participar.
  await db.query("UPDATE users SET coins = coins + 10 WHERE id=$1", [userId]);
  return { dmg, justDefeated: !!(upd.rows[0].defeated_at && Number(upd.rows[0].hp_left) === 0), boss: await bossState(userId) };
}

// --------------------------------- NÉMESIS -----------------------------------
async function getNemesis(userId) {
  let r = await db.query("SELECT * FROM nemesis WHERE user_id=$1", [userId]);
  if (!r.rowCount) {
    await db.query("INSERT INTO nemesis (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, E.nemesisName(userId)]);
    r = await db.query("SELECT * FROM nemesis WHERE user_id=$1", [userId]);
  }
  return r.rows[0];
}
// Construye el equipo de la némesis (counter-pick determinista, escalado por tier).
async function nemesisEncounter(userId, templates) {
  const n = await getNemesis(userId);
  const byId = {}; templates.forEach((t) => (byId[t.id || t.template_id] = normTpl(t)));
  const teamIds = (await teamIdsOf(userId)) || [];
  const myTypes = teamIds.map((id) => byId[id]).filter(Boolean).flatMap((t) => t.types || [t.type]);
  const week = wkStr();
  const picks = E.nemesisTeam(userId, week, myTypes, templates);
  const level = 8 + n.tier * 2; // sube con el tier (vuelve más fuerte)
  const team = picks.map((t, i) => E.buildUnit(normTpl(t), level, "B", i));
  return { name: n.name, tier: n.tier, winsVsMe: n.wins_vs_me, myWins: n.my_wins, level,
    enemy: team, enemyIds: picks.map((t) => t.id || t.template_id) };
}
// Aplica el resultado de un combate contra la némesis.
async function nemesisResult(userId, win) {
  const n = await getNemesis(userId);
  if (win) {
    // La derrotas: sube de tier (vuelve más fuerte) y cuenta tu victoria.
    await db.query("UPDATE nemesis SET my_wins = my_wins + 1, tier = tier + 1, updated_at = now() WHERE user_id=$1", [userId]);
    return { win: true, newTier: n.tier + 1 };
  }
  await db.query("UPDATE nemesis SET wins_vs_me = wins_vs_me + 1, updated_at = now() WHERE user_id=$1", [userId]);
  return { win: false };
}

// --------------------------------- helpers -----------------------------------
function normTpl(t) {
  // Acepta filas de BD (base_hp...) o plantillas del motor (base_stats).
  if (t.base_stats) return { id: t.id || t.template_id, name: t.name, type: t.type, types: t.types || [t.type], ability: t.ability, base_stats: t.base_stats };
  const tplBaseStats = { hp: t.base_hp, atkP: t.base_atk_p ?? t.base_atk, atkS: t.base_atk_s ?? t.base_atk, defP: t.base_def_p ?? t.base_def, defS: t.base_def_s ?? t.base_def, spd: t.base_spd };
  return { id: t.template_id || t.id, name: t.name, type: t.type, types: t.type2 ? [t.type, t.type2] : [t.type], ability: t.ability_id || t.ability, base_stats: tplBaseStats };
}
function sanitizeDecisions(decisions) {
  return (Array.isArray(decisions) ? decisions : [])
    .filter((d) => d && Number.isInteger(d.turn) && typeof d.uid === "string" && d.uid[0] === "A")
    .slice(0, 600)
    .map((d) => ({ turn: d.turn, uid: d.uid, action: d.action === "guard" ? "guard" : d.action === "attack" ? "attack" : "ability", target: typeof d.target === "string" ? d.target : undefined, overcharge: !!d.overcharge }));
}
async function teamIdsOf(userId) {
  const t = await db.query("SELECT snapshot FROM teams WHERE user_id=$1", [userId]);
  if (t.rowCount && t.rows[0].snapshot && t.rows[0].snapshot.length) return t.rows[0].snapshot.map((s) => s.template_id);
  return null;
}

module.exports = {
  solvePuzzle, puzzleRanking,
  getOrCreateBoss, bossState, hitBoss,
  getNemesis, nemesisEncounter, nemesisResult,
  unitsFromIds, normTpl, sanitizeDecisions,
};
