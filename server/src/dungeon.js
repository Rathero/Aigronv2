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
const weekly = require("./missions");
const features = require("./features");

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
    s.pending = { kind: node.type, battleSeed: battleSeedFor(row.seed, row.depth) };
    // ECO: en nodos de combate normal, ~35% de probabilidad de enfrentar el
    // equipo CAÍDO de otro jugador (snapshot real) en vez de enemigos generados.
    let echo = null;
    if (features.on("echoes") && node.type === "COMBATE" && (E.hashStr("echoroll:" + row.seed + ":" + row.depth) % 100) < 35) {
      echo = await pickEcho(userId, row.depth, row.difficulty).catch(() => null);
    }
    if (echo) {
      s.pending.enemy = echo.team;       // snapshot escalado, ya listo para combate
      s.pending.echo = { id: echo.id, owner: echo.owner_name, bounty: echo.coins_bounty };
    } else {
      const enemy = E.dungeonEnemyTeam(row.seed, row.depth, node.type, templates, baseLevel);
      s.pending.enemy = enemy.map(publicEnemyStats);
    }
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
    // ECO vengado: botín extra del equipo caído + aviso de a quién vengaste.
    if (s.pending.echo) {
      coinGain += s.pending.echo.bounty || 0;
      const owner = await avengeEcho(s.pending.echo.id).catch(() => null);
      out.avenged = { owner: s.pending.echo.owner, bounty: s.pending.echo.bounty || 0 };
      if (owner) out.avenged.depth = owner.depth;
    }
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
    // ECO: tu equipo caído se convierte en un encuentro en las runs de OTROS
    // ese día (multijugador asíncrono fantasma). Solo si llegaste a un nodo
    // razonable, para que valga la pena vengarlo.
    if (features.on("echoes") && row.depth >= 2) {
      await createEcho(userId, row, s).catch(() => {});
    }
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
    // Perfil/logros + misión semanal de profundidad.
    if (row.status === "cleared") await db.query("UPDATE users SET dungeons_cleared = dungeons_cleared + 1 WHERE id=$1", [userId]);
    await weekly.bumpWeekly(userId, "w_dungeon", row.depth);
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

// Abandonar/huir de una run ACTIVA: cuenta como muerte (permadeath). Huir de un
// combate no puede ser gratis — si no, se reintentaría cualquier pelea perdida.
// Registra el mejor del día (misma lógica de recompensa que morir en combate).
async function abandonRun(userId) {
  const row = await loadRow(userId);
  if (!row || row.status !== "active") throw new Error("no_active_run");
  const s = row.state;
  row.status = "dead";
  s.stage = "done";
  s.pending = null; s.draft = null; s.shop = null;
  s.lastResult = { fled: true, dead: true };

  const date = C.todayStr();
  const diff = E.dungeonDiff(row.difficulty || "NORMAL");
  const out = { dead: true, fled: true };
  const sc = await endRunScore(userId, date, row.difficulty || "NORMAL", row.depth, false);
  if (sc.improved) {
    const reward = Math.round(row.depth * 15 * diff.coinMult) + Math.floor(s.coins * 0.5);
    await db.query("UPDATE users SET coins = coins + $1 WHERE id=$2", [reward, userId]);
    out.accountReward = reward;
  } else { out.accountReward = 0; out.noReward = "no_best"; }
  await weekly.bumpWeekly(userId, "w_dungeon", row.depth);
  await saveRow(row);
  return Object.assign({ state: publicState(await loadRow(userId)) }, out);
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

// ===================== ECOS DE LA MAZMORRA (fantasmas) =======================
// Guarda el equipo caído como un eco del día (snapshot escalado, listo para
// combate como equipo B). Botín = monedas acumuladas en la run + bonus por nodo.
async function createEcho(userId, row, s) {
  const u = await db.query("SELECT display_name FROM users WHERE id=$1", [userId]);
  const name = (u.rows[0] && u.rows[0].display_name) || "Caído";
  // El fantasma "revive": HP a tope (el equipo murió con hp~0; unitFromStats ya
  // usa hpMax, pero el snapshot lo deja explícito para cualquier consumidor).
  const teamSnap = s.team.map((m) => Object.assign(memberStats(m), { hp: m.base.hpMax }));
  const bounty = Math.round((s.coins || 0) * 0.5) + row.depth * 8;
  await db.query(
    `INSERT INTO dungeon_echoes (daily_date, user_id, owner_name, depth, difficulty, team, coins_bounty)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [C.todayStr(), userId, name, row.depth, row.difficulty || "NORMAL", JSON.stringify(teamSnap), bounty]
  );
}
// Elige un eco de OTRO jugador cercano en profundidad para un encuentro (o null).
// Filtra por DIFICULTAD: un eco de PESADILLA (nv100) en una run FÁCIL sería un
// paredón injusto — los niveles del snapshot son los de su dificultad.
async function pickEcho(userId, depth, difficulty) {
  const r = await db.query(
    `SELECT * FROM dungeon_echoes
      WHERE daily_date=$1 AND user_id<>$2 AND difficulty=$3 AND depth BETWEEN $4 AND $5
      ORDER BY random() LIMIT 1`,
    [C.todayStr(), userId, difficulty || "NORMAL", Math.max(0, depth - 1), depth + 2]
  );
  return r.rows[0] || null;
}
// Marca un eco como vengado (derrotado por otro): +avenged y notifica al dueño.
async function avengeEcho(echoId) {
  const r = await db.query("UPDATE dungeon_echoes SET avenged = avenged + 1 WHERE id=$1 RETURNING user_id, owner_name, depth", [echoId]);
  return r.rows[0] || null;
}

module.exports = { startRun, getRun, chooseNode, resolveCombat, abandonRun, draftRelic, skipDraft, shopAction, ranking, publicState, createEcho, pickEcho, avengeEcho };
