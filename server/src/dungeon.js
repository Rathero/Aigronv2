// =============================================================================
// dungeon.js — Mazmorra del día (roguelike). El servidor es AUTORITATIVO: guarda
// el estado de la run (equipo con HP arrastrado, reliquias, monedas, etapa) y lo
// avanza paso a paso. La semilla es diaria y compartida (ranking justo). El
// combate reutiliza el motor determinista; el cliente lo reproduce para animar y
// el servidor recalcula para validar (anti-trampa).
//
// Etapas (state.stage): 'choosing' (elegir 1 de 2 nodos) -> según el nodo:
//   combate -> 'combat' (resolver) -> 'draft' (elegir reliquia) -> 'choosing'
//   descanso/tienda -> efecto -> 'choosing'.  Jefe superado -> 'cleared'.
// =============================================================================
const E = require("../../web/engine.js");
const db = require("./db");
const C = require("./config");

const COMBAT_KINDS = ["COMBATE", "ELITE", "JEFE"];

// --------------------------------- helpers ----------------------------------
function memberFromUnit(u) {
  return {
    tplId: u.tplId, name: u.name, type: u.type, types: u.types, ability: u.ability, level: u.level,
    base: { hpMax: u.hpMax, atkP: u.atkP, atkS: u.atkS, defP: u.defP, defS: u.defS, spd: u.spd },
    hp: u.hpMax, dead: false,
  };
}
function relicHpMult(relics) {
  return (relics || []).reduce((m, id) => (id === "CORAZON_TITAN" ? m * 1.12 : m), 1);
}
function healTeam(state, frac) {
  const mult = relicHpMult(state.relics);
  state.team.forEach((m) => {
    if (m.dead) return;
    const max = Math.round(m.base.hpMax * mult);
    m.hp = Math.min(max, m.hp + Math.round(m.base.hpMax * frac));
  });
}
function memberStats(m) {
  return { tplId: m.tplId, name: m.name, type: m.type, types: m.types, ability: m.ability, level: m.level,
    hpMax: m.base.hpMax, atkP: m.base.atkP, atkS: m.base.atkS, defP: m.base.defP, defS: m.base.defS, spd: m.base.spd, hp: m.hp };
}
// Construye el equipo A de combate desde el estado (reliquias aplicadas, HP arrastrado).
function buildPlayerUnits(state) {
  const alive = state.team.map((m, idx) => ({ m, idx })).filter((x) => !x.m.dead);
  const A = alive.map((x, i) => {
    const u = E.unitFromStats(memberStats(x.m), "A", i);
    u._memberIdx = x.idx;
    return u;
  });
  E.applyRelics(A, state.relics);
  A.forEach((u, i) => { u.hp = Math.min(u.hpMax, alive[i].m.hp); });
  return A;
}
function publicEnemyStats(u) {
  return { tplId: u.tplId, name: u.name, type: u.type, types: u.types, ability: u.ability, level: u.level,
    hpMax: u.hpMax, atkP: u.atkP, atkS: u.atkS, defP: u.defP, defS: u.defS, spd: u.spd };
}
function battleSeedFor(seed, node) { return E.hashStr("dgnbattle:" + seed + ":" + node) >>> 1; }
const SHOP_RELIC_COST = 60, SHOP_HEAL_COST = 40, SHOP_HEAL_FRAC = 0.5;

// Estado público que consume el cliente según la etapa.
function publicState(row) {
  const s = row.state;
  const diff = E.dungeonDiff(row.difficulty || "NORMAL");
  const out = {
    date: C.todayStr(new Date(row.daily_date)), seed: row.seed, depth: row.depth, totalDepth: E.DUNGEON_DEPTH,
    difficulty: row.difficulty || "NORMAL", diffLabel: diff.label, diffLevel: diff.level,
    status: row.status, stage: s.stage, coins: s.coins, relics: s.relics,
    team: s.team.map((m) => ({ tplId: m.tplId, name: m.name, type: m.type, ability: m.ability, level: m.level,
      hp: m.hp, hpMax: Math.round(m.base.hpMax * relicHpMult(s.relics)), dead: m.dead })),
  };
  if (s.stage === "choosing") out.options = s.options;
  if (s.stage === "combat" && s.pending) {
    // Enviamos stats BASE + reliquias; el cliente aplica las reliquias (igual que
    // el servidor en resolveCombat) para que `mods` y stats coincidan 1:1.
    out.battle = {
      kind: s.pending.kind, battleSeed: s.pending.battleSeed, relics: s.relics,
      team: s.team.filter((m) => !m.dead).map(memberStats),
      enemy: s.pending.enemy,
    };
  }
  if (s.stage === "draft" && s.draft) out.draft = s.draft.map((id) => Object.assign({ id }, E.RELICS[id]));
  if (s.stage === "shop" && s.shop) out.shop = { relics: s.shop.relics.map((id) => Object.assign({ id }, E.RELICS[id])), relicCost: SHOP_RELIC_COST, healCost: SHOP_HEAL_COST };
  if (s.lastResult) out.lastResult = s.lastResult;
  return out;
}

async function loadRow(userId) {
  const r = await db.query("SELECT * FROM dungeon_runs WHERE user_id=$1", [userId]);
  return r.rows[0] || null;
}
async function saveRow(row) {
  await db.query(
    "UPDATE dungeon_runs SET depth=$1, status=$2, state=$3, best_depth=GREATEST(best_depth,$1), updated_at=now() WHERE user_id=$4",
    [row.depth, row.status, JSON.stringify(row.state), row.user_id]
  );
}

// ---------------------------------- API -------------------------------------
// Inicia una run NUEVA en la dificultad elegida (runs ILIMITADAS: reemplaza la
// run activa). teamUnits = unidades del equipo del jugador.
async function startRun(userId, teamUnits, difficulty) {
  const date = C.todayStr();
  if (!teamUnits || !teamUnits.length) throw new Error("empty_team");
  const diffId = E.DUNGEON_DIFFICULTIES[difficulty] ? difficulty : "NORMAL";
  // Mapa DIARIO por dificultad: misma mazmorra todo el día para una dificultad.
  const seed = E.hashStr("dungeon_" + date + "_" + diffId) >>> 1;
  const team = teamUnits.slice(0, 3).map(memberFromUnit);
  const state = { team, relics: [], coins: 0, stage: "choosing", options: E.dungeonNodeOptions(seed, 0), pending: null, draft: null, shop: null, lastResult: null };
  await db.query(
    `INSERT INTO dungeon_runs (user_id, daily_date, seed, depth, status, state, best_depth, difficulty)
     VALUES ($1,$2,$3,0,'active',$4,0,$5)
     ON CONFLICT (user_id) DO UPDATE SET daily_date=$2, seed=$3, depth=0, status='active', state=$4, best_depth=0, difficulty=$5, updated_at=now()`,
    [userId, date, seed, JSON.stringify(state), diffId]
  );
  return publicState(await loadRow(userId));
}

async function getRun(userId) {
  const row = await loadRow(userId);
  if (!row) return null;
  return publicState(row);
}

// Elige una de las opciones de nodo. templates = lote de hoy. El nivel enemigo lo
// fija la DIFICULTAD de la run (no el nivel del jugador).
async function chooseNode(userId, choiceIdx, templates) {
  const row = await loadRow(userId);
  if (!row || row.status !== "active") throw new Error("no_active_run");
  const s = row.state;
  if (s.stage !== "choosing") throw new Error("not_choosing");
  const node = s.options[choiceIdx];
  if (!node) throw new Error("bad_choice");

  if (COMBAT_KINDS.includes(node.type)) {
    const baseLevel = E.dungeonDiff(row.difficulty || "NORMAL").level;
    const enemy = E.dungeonEnemyTeam(row.seed, row.depth, node.type, templates, baseLevel);
    s.pending = { kind: node.type, enemy: enemy.map(publicEnemyStats), battleSeed: battleSeedFor(row.seed, row.depth) };
    s.stage = "combat";
  } else if (node.type === "DESCANSO") {
    healTeam(s, 0.4);
    s.lastResult = { node: "DESCANSO", healed: true };
    advance(row);
  } else if (node.type === "TIENDA") {
    s.shop = { relics: E.dungeonDraft(row.seed, row.depth).slice(0, 2) };
    s.stage = "shop";
  }
  await saveRow(row);
  return publicState(await loadRow(userId));
}

// Avanza al siguiente nodo (sube depth y prepara opciones, o jefe).
function advance(row) {
  const s = row.state;
  row.depth += 1;
  if (row.depth >= E.DUNGEON_DEPTH) { row.status = "cleared"; s.stage = "done"; return; }
  s.options = E.dungeonNodeOptions(row.seed, row.depth);
  s.pending = null; s.draft = null; s.shop = null;
  s.stage = "choosing";
}

// Resuelve el combate del nodo actual con las decisiones del jugador.
async function resolveCombat(userId, decisions) {
  const row = await loadRow(userId);
  if (!row || row.status !== "active") throw new Error("no_active_run");
  const s = row.state;
  if (s.stage !== "combat" || !s.pending) throw new Error("not_in_combat");

  const safe = (Array.isArray(decisions) ? decisions : [])
    .filter((d) => d && Number.isInteger(d.turn) && typeof d.uid === "string" && d.uid[0] === "A")
    .slice(0, 600)
    .map((d) => ({ turn: d.turn, uid: d.uid, action: d.action === "guard" ? "guard" : d.action === "attack" ? "attack" : "ability", target: typeof d.target === "string" ? d.target : undefined, overcharge: !!d.overcharge }));

  const A = buildPlayerUnits(s);
  const B = s.pending.enemy.map((e, i) => E.unitFromStats(e, "B", i));
  const result = E.resolveBattle(A, B, s.pending.battleSeed, safe);
  const win = result.winner === "A";

  // Escribe el HP/muerte de cada unidad de vuelta al estado del equipo.
  A.forEach((u) => { const m = s.team[u._memberIdx]; m.hp = Math.max(0, u.hp); if (u.hp <= 0) m.dead = true; });

  const kind = s.pending.kind;
  let out = { win, kind, turns: result.turns, log: result.log };

  const diff = E.dungeonDiff(row.difficulty || "NORMAL");
  if (win) {
    const eff = E.relicRunEffects(s.relics);
    let coinGain = Math.round((8 + row.depth * 4 + (kind === "ELITE" ? 15 : 0) + (kind === "JEFE" ? 50 : 0)) * eff.coinMult * diff.coinMult);
    s.coins += coinGain;
    if (eff.healAfter) healTeam(s, eff.healAfter);
    out.coins = coinGain;

    if (kind === "JEFE") {
      row.depth += 1; row.status = "cleared"; s.stage = "done"; s.pending = null;
      out.cleared = true;
    } else {
      row.depth += 1;
      s.draft = E.dungeonDraft(row.seed, row.depth - 1);
      s.stage = "draft"; s.pending = null;
    }
  } else {
    row.status = "dead"; s.stage = "done"; s.pending = null;
    out.dead = true;
  }
  s.lastResult = out;

  // Al terminar la run (cleared o dead): registra el mejor del día por dificultad y
  // concede monedas a la cuenta SOLO si superas tu mejor profundidad (anti-farmeo;
  // runs ilimitadas). Repetir sin mejorar no infla el saldo.
  if (row.status !== "active") {
    const date = C.todayStr();
    const sc = await endRunScore(userId, date, row.difficulty || "NORMAL", row.depth, row.status === "cleared");
    if (sc.improved) {
      const reward = Math.round((row.depth * 15 + (row.status === "cleared" ? 100 : 0)) * diff.coinMult) + Math.floor(s.coins * 0.5);
      await db.query("UPDATE users SET coins = coins + $1 WHERE id=$2", [reward, userId]);
      out.accountReward = reward;
    } else { out.accountReward = 0; out.noReward = "no_best"; }
  }
  await saveRow(row);
  return Object.assign({ state: publicState(await loadRow(userId)) }, out);
}

// Elige una reliquia del draft tras superar un nodo.
async function draftRelic(userId, choiceIdx) {
  const row = await loadRow(userId);
  if (!row || row.status !== "active") throw new Error("no_active_run");
  const s = row.state;
  if (s.stage !== "draft" || !s.draft) throw new Error("not_drafting");
  const id = s.draft[choiceIdx];
  if (!id || !E.RELICS[id]) throw new Error("bad_relic");
  s.relics.push(id);
  s.draft = null;
  s.options = E.dungeonNodeOptions(row.seed, row.depth);
  s.stage = "choosing";
  await saveRow(row);
  return publicState(await loadRow(userId));
}
// Saltar el draft (no coger reliquia).
async function skipDraft(userId) {
  const row = await loadRow(userId);
  if (!row || row.status !== "active") throw new Error("no_active_run");
  const s = row.state;
  if (s.stage !== "draft") throw new Error("not_drafting");
  s.draft = null;
  s.options = E.dungeonNodeOptions(row.seed, row.depth);
  s.stage = "choosing";
  await saveRow(row);
  return publicState(await loadRow(userId));
}

// Acción de tienda: buy (índice de reliquia) | heal | leave.
async function shopAction(userId, action, arg) {
  const row = await loadRow(userId);
  if (!row || row.status !== "active") throw new Error("no_active_run");
  const s = row.state;
  if (s.stage !== "shop" || !s.shop) throw new Error("not_in_shop");

  if (action === "buy") {
    const id = s.shop.relics[arg];
    if (!id) throw new Error("bad_item");
    if (s.coins < SHOP_RELIC_COST) throw new Error("insufficient");
    s.coins -= SHOP_RELIC_COST;
    s.relics.push(id);
    s.shop.relics.splice(arg, 1);
  } else if (action === "heal") {
    if (s.coins < SHOP_HEAL_COST) throw new Error("insufficient");
    s.coins -= SHOP_HEAL_COST;
    healTeam(s, SHOP_HEAL_FRAC);
  } else if (action === "leave") {
    advance(row);
  } else {
    throw new Error("bad_action");
  }
  await saveRow(row);
  return publicState(await loadRow(userId));
}

// Registra el mejor del día por (usuario, dificultad). Devuelve si MEJORÓ.
async function endRunScore(userId, date, difficulty, depth, cleared) {
  const prev = await db.query(
    "SELECT best_depth FROM dungeon_scores WHERE daily_date=$1 AND user_id=$2 AND difficulty=$3",
    [date, userId, difficulty]);
  const prevBest = prev.rowCount ? prev.rows[0].best_depth : -1;
  await db.query(
    `INSERT INTO dungeon_scores (daily_date, user_id, difficulty, best_depth, cleared)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (daily_date, user_id, difficulty) DO UPDATE
       SET best_depth = GREATEST(dungeon_scores.best_depth, EXCLUDED.best_depth),
           cleared = dungeon_scores.cleared OR EXCLUDED.cleared`,
    [date, userId, difficulty, depth, cleared]);
  return { improved: depth > prevBest, prevBest };
}

async function ranking(userId, difficulty) {
  const diffId = E.DUNGEON_DIFFICULTIES[difficulty] ? difficulty : "NORMAL";
  const r = await db.query(
    `SELECT u.display_name AS name, d.user_id, d.best_depth, d.cleared
       FROM dungeon_scores d JOIN users u ON u.id = d.user_id
      WHERE d.daily_date = CURRENT_DATE AND d.difficulty = $1
      ORDER BY d.best_depth DESC, d.cleared DESC LIMIT 50`, [diffId]);
  return { difficulty: diffId, rows: r.rows.map((x, i) => ({ pos: i + 1, name: x.name, depth: x.best_depth, cleared: x.cleared, me: x.user_id === userId })) };
}

module.exports = { startRun, getRun, chooseNode, resolveCombat, draftRelic, skipDraft, shopAction, ranking, publicState };
