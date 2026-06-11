// =============================================================================
// engine.test.js — Tests del motor compartido (determinismo, terminación,
// rangos de generación, escalado, ligas) y de la PARIDAD cliente/servidor.
// Sin dependencias externas: node --test. No requiere base de datos.
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");

const E = require("../../web/engine.js");
const serverCombat = require("../src/combat.js");
const serverGen = require("../src/generator.js");

// Construye dos equipos de 3 a partir de ids deterministas.
function teamFrom(ids, team, level) {
  return ids.map((id, i) => E.buildUnit(E.genTemplate(id), level, team, i));
}
function freshTeams(seedTag, level) {
  const A = teamFrom([`A_${seedTag}_0`, `A_${seedTag}_1`, `A_${seedTag}_2`], "A", level);
  const B = teamFrom([`B_${seedTag}_0`, `B_${seedTag}_1`, `B_${seedTag}_2`], "B", level);
  return { A, B };
}

test("combate determinista: mismo seed+decisiones -> mismo resultado", () => {
  for (let s = 0; s < 50; s++) {
    const decisions = [{ turn: 2, uid: "A0" }, { turn: 3, uid: "A1" }];
    const t1 = freshTeams(s, 5);
    const t2 = freshTeams(s, 5);
    const r1 = E.resolveBattle(t1.A, t1.B, s, decisions);
    const r2 = E.resolveBattle(t2.A, t2.B, s, decisions);
    assert.equal(r1.winner, r2.winner, `winner seed=${s}`);
    assert.equal(r1.turns, r2.turns, `turns seed=${s}`);
    assert.equal(r1.hpA, r2.hpA);
    assert.equal(r1.hpB, r2.hpB);
  }
});

test("combate siempre termina (<= 60 turnos) y hay ganador", () => {
  for (let s = 0; s < 300; s++) {
    const { A, B } = freshTeams(s * 7 + 1, 1 + (s % 20));
    const r = E.resolveBattle(A, B, s, []);
    assert.ok(r.turns <= 60, `turns=${r.turns} seed=${s}`);
    assert.ok(r.winner === "A" || r.winner === "B");
  }
});

test("paridad cliente/servidor: engine.resolveBattle === server combat.resolveBattle", () => {
  for (let s = 0; s < 50; s++) {
    const decisions = [{ turn: 1, uid: "A0" }, { turn: 4, uid: "A2" }];
    const e = freshTeams(s, 6);
    const sv = freshTeams(s, 6);
    const re = E.resolveBattle(e.A, e.B, s, decisions);
    const rs = serverCombat.resolveBattle(sv.A, sv.B, s, decisions);
    assert.deepEqual(
      { w: re.winner, t: re.turns, a: re.hpA, b: re.hpB },
      { w: rs.winner, t: rs.turns, a: rs.hpA, b: rs.hpB },
      `paridad seed=${s}`
    );
  }
});

test("paridad de generación: engine.genTemplate === server generator", () => {
  for (let i = 0; i < 100; i++) {
    const id = "2026-06-06_" + String(i).padStart(4, "0");
    assert.deepEqual(serverGen.genTemplate(id), E.genTemplate(id), `gen id=${id}`);
  }
});

test("stats generados dentro de rango por rareza (con arquetipo de tipo)", () => {
  const multOf = (p, k) => (k === "atkP" || k === "atkS" ? p.atk : p[k]);
  for (let i = 0; i < 1000; i++) {
    const t = E.genTemplate("rng_" + i);
    const rg = E.RANGES[t.rarity];
    const p = E.TYPE_STATS[t.type];
    const s = t.base_stats;
    ["hp", "atkP", "atkS", "defP", "defS", "spd"].forEach((k) => {
      const m = multOf(p, k);
      const lo = Math.round(rg[k][0] * m) - 1, hi = Math.round(rg[k][1] * m) + 1;
      assert.ok(s[k] >= lo && s[k] <= hi, `${k} ${s[k]} fuera de [${lo},${hi}] ${t.type}/${t.rarity}`);
    });
    assert.ok(E.RARITIES.includes(t.rarity));
    assert.ok(E.TYPES.includes(t.type));
    assert.ok(E.ABILITIES[t.ability], `ability ${t.ability}`);
  }
});

test("escalado por nivel: +4% por nivel", () => {
  assert.equal(E.scaled(100, 1), 100);
  assert.equal(E.scaled(100, 20), Math.round(100 * (1 + 0.04 * 19))); // 176
  assert.equal(E.scaled(1000, 10), Math.round(1000 * 1.36));
});

test("nivel máximo = 100 (escala x4.96 a tope)", () => {
  assert.equal(E.LEVEL_MAX, 100);
  assert.equal(E.scaled(1000, 100), Math.round(1000 * (1 + 0.04 * 99))); // 4960
});

test("coste de subida: curva suave sub-lineal y monótona", () => {
  assert.deepEqual(E.levelCost(1), { dust: 12, coins: 60 });
  // Monótona no decreciente.
  for (let l = 2; l <= 100; l++) {
    const a = E.levelCost(l - 1), b = E.levelCost(l);
    assert.ok(b.dust >= a.dust && b.coins >= a.coins, `coste baja en nivel ${l}`);
  }
  // Sub-lineal: Nv100 cuesta ~10x el Nv1 (raíz), no 100x como el lineal viejo.
  const c100 = E.levelCost(100);
  assert.ok(c100.dust <= 130 && c100.coins <= 650, `Nv100 demasiado caro: ${JSON.stringify(c100)}`);
  assert.ok(c100.dust < 15 * E.levelCost(1).dust, "no es sub-lineal");
});

test("umbrales de liga", () => {
  assert.equal(E.computeLeague(0), "BRONCE");
  assert.equal(E.computeLeague(99), "BRONCE");
  assert.equal(E.computeLeague(100), "PLATA");
  assert.equal(E.computeLeague(250), "ORO");
  assert.equal(E.computeLeague(450), "PLATINO");
  assert.equal(E.computeLeague(700), "DIAMANTE");
});

test("20 tipos en anillo: cada uno fuerte vs los 2 siguientes, débil vs los 2 anteriores", () => {
  assert.equal(E.TYPES.length, 20, "20 tipos");
  E.TYPES.forEach((t, i) => {
    const next1 = E.TYPES[(i + 1) % 20], next2 = E.TYPES[(i + 2) % 20];
    const prev1 = E.TYPES[(i + 19) % 20], prev2 = E.TYPES[(i + 18) % 20];
    assert.equal(E.typeMult(t, next1), 1.5);
    assert.equal(E.typeMult(t, next2), 1.5);
    assert.equal(E.typeMult(t, prev1), 0.75);
    assert.equal(E.typeMult(t, prev2), 0.75);
  });
});

test("efectividad dual (typeEff): producto contra ambos tipos del defensor", () => {
  const a = E.TYPES[0]; // fuerte vs TYPES[1] y TYPES[2]
  assert.equal(E.typeEff(a, [E.TYPES[1]]), 1.5);
  assert.equal(E.typeEff(a, [E.TYPES[1], E.TYPES[2]]), 1.5 * 1.5); // doblemente débil
  assert.equal(E.typeEff(a, [E.TYPES[1], E.TYPES[18]]), 1.5 * 0.75); // fuerte vs uno, débil vs otro
  assert.equal(E.typeEff(a, [E.TYPES[5]]), 1.0); // neutro
});

test("generación: las criaturas tienen 1 o 2 tipos y aparecen ambos casos", () => {
  let singles = 0, duals = 0;
  for (let i = 0; i < 500; i++) {
    const t = E.genTemplate("typ_" + i);
    assert.ok(t.types.length === 1 || t.types.length === 2, "1 o 2 tipos");
    assert.ok(E.TYPES.includes(t.types[0]));
    if (t.types.length === 2) { assert.notEqual(t.types[0], t.types[1], "tipos distintos"); duals++; } else singles++;
  }
  assert.ok(singles > 0 && duals > 0, `mezcla de simples (${singles}) y dobles (${duals})`);
});

// --------------------------- mecánicas estratégicas -------------------------
// VOLCAN = tipo físico -> sus golpes usan atkP vs defP.
const dmgTpl = { id: "t_dmg", name: "Tpl", type: "VOLCAN", ability: "ERUPCION_LENTA", base_stats: { hp: 1000, atkP: 150, atkS: 150, defP: 80, defS: 80, spd: 100 } };
const tgtTpl = { id: "t_tgt", name: "Obj", type: "VOLCAN", ability: "RAICES", base_stats: { hp: 1000, atkP: 100, atkS: 100, defP: 80, defS: 80, spd: 90 } };

test("guardia reduce el daño recibido (~60%)", () => {
  const noCrit = () => 0.999; // nunca crítico
  const att = E.buildUnit(dmgTpl, 5, "A", 0);
  const t1 = E.buildUnit(tgtTpl, 5, "B", 0);
  const t2 = E.buildUnit(tgtTpl, 5, "B", 1); t2.guarding = true;
  const d1 = E.dealDamage(noCrit, att, t1, 1, {});
  const d2 = E.dealDamage(noCrit, att, t2, 1, {});
  assert.ok(d2.dmg < d1.dmg, "el guardia recibe menos");
  assert.equal(d2.guarded, true);
  assert.ok(Math.abs(d2.dmg - Math.round(d1.dmg * 0.6)) <= 1, "≈60% del daño");
});

test("resolveTarget: un enemigo en guardia intercepta el golpe", () => {
  const foes = [E.buildUnit(tgtTpl, 5, "B", 0), E.buildUnit(tgtTpl, 5, "B", 1), E.buildUnit(tgtTpl, 5, "B", 2)];
  foes[2].guarding = true;
  assert.equal(E.resolveTarget("B0", foes).uid, "B2", "redirige al guardia aunque se apunte a otro");
  foes[2].guarding = false;
  assert.equal(E.resolveTarget("B1", foes).uid, "B1", "sin guardia respeta el objetivo elegido");
});

test("sobrecarga aumenta el efecto de la habilidad (×1.5)", () => {
  const noCrit = () => 0.999;
  const mk = (energy) => { const u = E.buildUnit(dmgTpl, 5, "A", 0); u.energy = energy; return u; };
  const foe1 = [E.buildUnit(tgtTpl, 5, "B", 0)];
  const foe2 = [E.buildUnit(tgtTpl, 5, "B", 0)];
  const normal = E.performAction(noCrit, mk(3), { type: "ability" }, [], foe1);
  const over = E.performAction(noCrit, mk(5), { type: "ability", overcharge: true }, [], foe2);
  assert.equal(over.overcharge, true);
  assert.ok(over.hits[0].dmg > normal.hits[0].dmg, "sobrecarga pega más");
  assert.ok(Math.abs(over.hits[0].dmg - Math.round(normal.hits[0].dmg * 1.5)) <= 2, "≈×1.5");
});

test("capitán + estancia hornean modificadores deterministas", () => {
  const mkTeam = () => [E.buildUnit(dmgTpl, 5, "A", 0), E.buildUnit(tgtTpl, 5, "A", 1), E.buildUnit(tgtTpl, 5, "A", 2)];
  const baseAtk = E.buildUnit(dmgTpl, 5, "A", 0).atkP;

  const agg = mkTeam(); E.applyCaptainStance(agg, "A0", "AGRESIVA");
  assert.ok(agg[0].atkP > baseAtk, "capitán+agresiva sube ATK del capitán");
  assert.equal(agg[0].startEnergy, 0);

  const def = mkTeam(); E.applyCaptainStance(def, "A1", "DEFENSIVA");
  assert.equal(def[0].startEnergy, 1, "defensiva arranca con energía");
  assert.equal(def[0].energy, 1);
  assert.ok(def[1].atkP > E.buildUnit(tgtTpl, 5, "A", 1).atkP * 0.9, "capitán recibe bono personal");

  // Determinista: dos aplicaciones idénticas dan lo mismo.
  const x = mkTeam(); E.applyCaptainStance(x, "A0", "AGRESIVA");
  const y = mkTeam(); E.applyCaptainStance(y, "A0", "AGRESIVA");
  assert.deepEqual(x.map((u) => [u.atkP, u.atkS, u.defP, u.defS, u.hpMax, u.spd]), y.map((u) => [u.atkP, u.atkS, u.defP, u.defS, u.hpMax, u.spd]));
});

test("combate determinista con decisiones ricas (objetivo+guardia+sobrecarga)", () => {
  const dec = [
    { turn: 2, uid: "A0", action: "ability", target: "B1", overcharge: true },
    { turn: 2, uid: "A1", action: "guard" },
    { turn: 3, uid: "A2", action: "ability", target: "B0" },
  ];
  const r1 = E.resolveBattle(freshTeams(99, 6).A, freshTeams(99, 6).B, 99, dec);
  const r2 = E.resolveBattle(freshTeams(99, 6).A, freshTeams(99, 6).B, 99, dec);
  assert.deepEqual({ w: r1.winner, t: r1.turns, a: r1.hpA, b: r1.hpB }, { w: r2.winner, t: r2.turns, a: r2.hpA, b: r2.hpB });
});

test("ataque básico focalizado (acción 'attack') pega al objetivo elegido", () => {
  const att = E.buildUnit(dmgTpl, 5, "A", 0);
  const foes = [E.buildUnit(tgtTpl, 5, "B", 0), E.buildUnit(tgtTpl, 5, "B", 1), E.buildUnit(tgtTpl, 5, "B", 2)];
  const a = E.performAction(() => 0.99, att, { type: "basic", target: "B1" }, [att], foes);
  assert.equal(a.hits[0].tgt.uid, "B1", "el básico focalizado golpea a B1");
  // determinismo de resolveBattle con decisiones 'attack'
  const dec = [{ turn: 1, uid: "A0", action: "attack", target: "B2" }, { turn: 2, uid: "A1", action: "attack", target: "B0" }];
  const r1 = E.resolveBattle(freshTeams(7, 6).A, freshTeams(7, 6).B, 7, dec);
  const r2 = E.resolveBattle(freshTeams(7, 6).A, freshTeams(7, 6).B, 7, dec);
  assert.deepEqual({ w: r1.winner, t: r1.turns, b: r1.hpB }, { w: r2.winner, t: r2.turns, b: r2.hpB });
});

test("escudo absorbe daño antes del HP", () => {
  const noCrit = () => 0.999;
  const att = E.buildUnit(dmgTpl, 5, "A", 0);
  const tgt = E.buildUnit(tgtTpl, 5, "B", 0); tgt.shield = 100000; const hp0 = tgt.hp;
  const h = E.dealDamage(noCrit, att, tgt, 1, {});
  assert.equal(tgt.hp, hp0, "HP intacto mientras hay escudo");
  assert.ok(tgt.shield < 100000, "el escudo baja");
  assert.equal(h.shielded, true);
});

test("veneno (dot): tickStatus daña cada turno y decrece", () => {
  const u = E.buildUnit(tgtTpl, 5, "A", 0); u.poisonTurns = 2; u.poisonAmt = 0.1; const hp0 = u.hp;
  const s1 = E.tickStatus(u); assert.ok(s1.poison > 0); assert.ok(u.hp < hp0); assert.equal(u.poisonTurns, 1);
  E.tickStatus(u); assert.equal(u.poisonTurns, 0);
  assert.equal(E.tickStatus(u).poison, 0, "sin veneno restante no hace daño");
});

test("aturdir (stun): tickStatus marca stunned y decrece", () => {
  const u = E.buildUnit(tgtTpl, 5, "A", 0); u.stunTurns = 1;
  const s = E.tickStatus(u); assert.equal(s.stunned, true); assert.equal(u.stunTurns, 0);
  assert.equal(E.tickStatus(u).stunned, false);
});

test("drenar: el lanzador se cura parte del daño hecho", () => {
  const drainTpl = { id: "t_dr", name: "Dr", type: "VOLCAN", ability: "DRENAJE", base_stats: dmgTpl.base_stats };
  const att = E.buildUnit(drainTpl, 5, "A", 0); att.energy = 5; att.hp = 200;
  const foes = [E.buildUnit(tgtTpl, 5, "B", 0)];
  const a = E.performAction(() => 0.999, att, { type: "ability" }, [att], foes);
  assert.ok(a.hits.length > 0 && a.hits[0].dmg > 0, "hace daño");
  assert.ok(att.hp > 200, "el lanzador se curó con el drenaje");
});

// ------------------------------ PvP en vivo ---------------------------------
// stepTurn ronda-a-ronda (autoritativo del servidor) == resolveBattle batch.
test("PvP: stepTurn acumulado == resolveBattle batch (mismas decisiones)", () => {
  const ids = ["p1", "p2", "p3"], idsB = ["q1", "q2", "q3"];
  const mk = (team) => { const d = []; for (let t = 1; t <= 8; t++) for (let i = 0; i < 3; i++) d.push({ turn: t, uid: team + i, action: "ability" }); return d; };
  const dec = [...mk("A"), ...mk("B")];
  const batch = E.resolveBattle(teamFrom(ids, "A", 10), teamFrom(idsB, "B", 10), 777, dec);
  const A2 = teamFrom(ids, "A", 10), B2 = teamFrom(idsB, "B", 10);
  const rng = E.mulberry32(777 >>> 0), dmap = new Map(dec.map((d) => [d.turn + ":" + d.uid, d]));
  let turn = 0;
  while (turn < 60) { turn++; const r = E.stepTurn(A2, B2, rng, dmap, turn); if (r.done) break; }
  const sum = (t) => t.filter((u) => u.hp > 0).reduce((s, u) => s + u.hp, 0);
  assert.equal(batch.turns, turn, "mismo nº de turnos");
  assert.equal(batch.hpA, sum(A2), "mismo HP A");
  assert.equal(batch.hpB, sum(B2), "mismo HP B");
});

// Con decisiones de AMBOS equipos: determinista y las decisiones de B importan
// (no se usa aiIntent).
test("PvP: decisiones de ambos equipos -> determinista e influyen", () => {
  const run = (bAction) => {
    const A = teamFrom(["x1", "x2", "x3"], "A", 10), B = teamFrom(["y1", "y2", "y3"], "B", 10);
    const d = [];
    for (let t = 1; t <= 12; t++) { for (let i = 0; i < 3; i++) d.push({ turn: t, uid: "A" + i, action: "attack" }); for (let i = 0; i < 3; i++) d.push({ turn: t, uid: "B" + i, action: bAction }); }
    return E.resolveBattle(A, B, 1234, d);
  };
  const a = run("attack"), b = run("attack");
  assert.equal(a.winner, b.winner); assert.equal(a.hpA, b.hpA); assert.equal(a.hpB, b.hpB);
  const g = run("guard");
  assert.ok(a.hpA !== g.hpA || a.hpB !== g.hpB || a.turns !== g.turns, "cambiar la decisión de B cambia el resultado");
});

// ------------------------------ roguelike ----------------------------------
test("applyRelics hornea stats y rellena mods", () => {
  const team = () => [E.buildUnit(dmgTpl, 5, "A", 0), E.buildUnit(tgtTpl, 5, "A", 1)];
  const base = E.buildUnit(dmgTpl, 5, "A", 0);
  const t = team();
  E.applyRelics(t, ["CORAZON_TITAN", "TOTEM_FURIA", "BATERIA", "COLMILLO_VAMPIRICO", "CRISTAL_AFILADO"]);
  assert.ok(t[0].hpMax > base.hpMax, "CORAZON sube HP");
  assert.ok(t[0].atkP > base.atkP, "FURIA sube ATK");
  assert.equal(t[0].startEnergy, 1, "BATERIA da +1 energía");
  assert.equal(t[0].energy, 1);
  assert.ok(t[0].mods.lifesteal > 0, "VAMPIRISMO setea lifesteal");
  assert.ok(t[0].mods.critBonus > 0, "CRISTAL setea critBonus");
});

test("reliquias en combate: lifesteal cura y thorns refleja", () => {
  const noCrit = () => 0.999;
  // lifesteal: el atacante se cura al pegar
  const att = E.buildUnit(dmgTpl, 5, "A", 0); att.mods = { lifesteal: 0.5 }; att.hp = 100;
  const tgt = E.buildUnit(tgtTpl, 5, "B", 0);
  E.dealDamage(noCrit, att, tgt, 1, {});
  assert.ok(att.hp > 100, "lifesteal cura al atacante");
  // thorns: el atacante recibe daño reflejado
  const att2 = E.buildUnit(dmgTpl, 5, "A", 0); att2.hp = att2.hpMax;
  const tgt2 = E.buildUnit(tgtTpl, 5, "B", 0); tgt2.mods = { thorns: 0.5 };
  E.dealDamage(noCrit, att2, tgt2, 1, {});
  assert.ok(att2.hp < att2.hpMax, "thorns daña al atacante");
});

test("generación de mazmorra determinista", () => {
  const seed = E.hashStr("dungeon_2026-06-06");
  const o1 = E.dungeonNodeOptions(seed, 0), o2 = E.dungeonNodeOptions(seed, 0);
  assert.deepEqual(o1, o2, "opciones deterministas");
  assert.deepEqual(E.dungeonNodeOptions(seed, E.DUNGEON_DEPTH - 1), [{ type: "JEFE" }], "último nodo = JEFE");
  const d = E.dungeonDraft(seed, 2);
  assert.equal(d.length, 3, "draft de 3");
  assert.equal(new Set(d).size, 3, "draft sin repetidos");
  d.forEach((id) => assert.ok(E.RELICS[id], "reliquia válida " + id));
  const e1 = E.dungeonEnemyTeam(seed, 3, "ELITE", E.dailyBatch("2026-06-06", 30), 5);
  assert.equal(e1.length, 3, "equipo enemigo de 3");
});

test("dificultades de mazmorra: 5 niveles fijos crecientes + recompensa", () => {
  const ids = ["FACIL", "NORMAL", "DIFICIL", "EXPERTO", "PESADILLA"];
  const levels = ids.map((id) => E.DUNGEON_DIFFICULTIES[id].level);
  const mults = ids.map((id) => E.DUNGEON_DIFFICULTIES[id].coinMult);
  assert.deepEqual(levels, [10, 30, 50, 75, 100], "niveles base fijos");
  for (let i = 1; i < 5; i++) { assert.ok(levels[i] > levels[i - 1], "nivel crece"); assert.ok(mults[i] > mults[i - 1], "recompensa crece"); }
  assert.equal(E.dungeonDiff("desconocida").label, E.DUNGEON_DIFFICULTIES.NORMAL.label, "fallback NORMAL");
});

test("nivel enemigo lo fija la DIFICULTAD, no el jugador", () => {
  const seed = E.hashStr("dungeon_2026-06-06_NORMAL");
  const tpls = E.dailyBatch("2026-06-06", 40);
  const lvls = (base) => E.dungeonEnemyTeam(seed, 3, "COMBATE", tpls, base).map((u) => u.level);
  // Mismo (seed, depth, base) -> mismos niveles (determinista, sin depender del jugador).
  assert.deepEqual(lvls(10), lvls(10), "determinista por nivel de dificultad");
  // Mayor nivel de dificultad -> enemigos de mayor nivel.
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(avg(lvls(E.DUNGEON_DIFFICULTIES.PESADILLA.level)) > avg(lvls(E.DUNGEON_DIFFICULTIES.FACIL.level)), "Pesadilla > Fácil");
});

test("las decisiones del jugador influyen en el combate (timing importa)", () => {
  // Con un equipo fijo, lanzar habilidades en distintos turnos puede cambiar
  // el nº de turnos o el HP final en al menos un seed (no es no-op).
  let anyDiff = false;
  for (let s = 0; s < 80 && !anyDiff; s++) {
    const noDec = E.resolveBattle(freshTeams(s, 8).A, freshTeams(s, 8).B, s, []);
    const withDec = E.resolveBattle(
      freshTeams(s, 8).A, freshTeams(s, 8).B, s,
      [{ turn: 3, uid: "A0" }, { turn: 3, uid: "A1" }, { turn: 4, uid: "A2" }]
    );
    if (noDec.turns !== withDec.turns || noDec.hpB !== withDec.hpB || noDec.winner !== withDec.winner) anyDiff = true;
  }
  assert.ok(anyDiff, "las decisiones deberían afectar el resultado en algún seed");
});

// ===================== MECÁNICAS INNOVADORAS (deterministas) =================
test("prismáticas: ~1% determinista y estable", () => {
  let n = 0;
  for (let i = 0; i < 2000; i++) if (E.isPrismatic("inst_" + i)) n++;
  assert.ok(n >= 5 && n <= 45, `prismáticas fuera de rango razonable: ${n}/2000`);
  assert.equal(E.isPrismatic("inst_7"), E.isPrismatic("inst_7"), "estable para el mismo id");
  // El shift no rompe el formato hex y cambia el color.
  const c = E.prismaticShift("#34f5e4", "inst_7");
  assert.match(c, /^#[0-9a-f]{6}$/i);
});

test("puzzle diario: determinista e idéntico para todos", () => {
  const tpls = E.dailyBatch("2026-06-10", 20);
  const a = E.dailyPuzzle("2026-06-10", tpls);
  const b = E.dailyPuzzle("2026-06-10", tpls);
  assert.deepEqual(a, b, "mismo día -> mismo puzzle");
  assert.equal(a.team.length, 3); assert.equal(a.enemy.length, 3);
  assert.ok(a.level >= 8 && a.level <= 13, "nivel en rango");
  const c = E.dailyPuzzle("2026-06-11", tpls);
  assert.notEqual(a.seed, c.seed, "otro día -> otro puzzle");
});

test("némesis: counter-pick determinista y nombre estable", () => {
  const tpls = E.dailyBatch("2026-06-10", 30);
  const t1 = E.nemesisTeam("user-x", "2026-W24", ["HIELO"], tpls);
  const t2 = E.nemesisTeam("user-x", "2026-W24", ["HIELO"], tpls);
  assert.equal(t1.length, 3);
  assert.deepEqual(t1.map((x) => x.id), t2.map((x) => x.id), "determinista");
  const nm = E.nemesisName("user-x");
  assert.match(nm, /^[A-Za-z]+$/, "nombre sin 'undefined'");
  assert.equal(nm, E.nemesisName("user-x"), "estable");
});

test("oráculo: profecía determinista con pista verídica", () => {
  const tpls = E.dailyBatch("2026-06-11", 20);
  const o1 = E.oracleProphecy("2026-06-11", tpls);
  const o2 = E.oracleProphecy("2026-06-11", tpls);
  assert.equal(o1.text, o2.text, "determinista");
  assert.ok(o1.text.length > 10 && o1.hint && o1.hint.domType, "tiene texto y pista");
});

test("mazmorra: la dificultad es una RAMPA (empieza ~25% y supera el nivel en el jefe)", () => {
  const base = 10; // FÁCIL
  const start = E.dungeonLevelAt(base, 0, "COMBATE");
  const boss = E.dungeonLevelAt(base, E.DUNGEON_DEPTH - 1, "JEFE");
  assert.ok(start <= 4, `el primer nodo debe ser asequible (nv${start})`);
  assert.ok(boss > base, `el jefe debe superar el nivel de referencia (nv${boss} > ${base})`);
  // Monotónica: cada nodo >= el anterior.
  for (let d = 1; d < E.DUNGEON_DEPTH; d++) {
    assert.ok(E.dungeonLevelAt(base, d, "COMBATE") >= E.dungeonLevelAt(base, d - 1, "COMBATE"), "rampa monotónica");
  }
  // dungeonEnemyTeam usa la rampa (±1 de variación).
  const tpls = E.dailyBatch("2026-06-11", 12);
  const lvl0 = E.dungeonEnemyTeam(7, 0, "COMBATE", tpls, base).map((u) => u.level);
  assert.ok(Math.max(...lvl0) <= start + 1, "nodo 0 cerca del nivel de arranque");
});

test("temporada: clave mensual, etiqueta y composición por cupos", () => {
  assert.equal(E.seasonKey("2026-06-11"), "2026-06-01", "clave = día 1 del mes");
  assert.equal(E.seasonKey("2026-12-31"), "2026-12-01");
  assert.equal(E.seasonLabel("2026-06-11"), "junio 2026");
  const a = E.composeSeason("2026-06-01", 180);
  const b = E.composeSeason("2026-06-01", 180);
  assert.equal(a.length, 180, "tamaño exacto del álbum");
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id), "determinista");
  // Curva de rareza: hay de las cuatro y el orden común>rara>épica>legendaria.
  const by = {}; a.forEach((t) => (by[t.rarity] = (by[t.rarity] || 0) + 1));
  assert.ok(by.LEGENDARIA >= 2 && by.EPICA >= 2 && by.RARA >= 2 && by.COMUN > 0, "todas las rarezas presentes");
  assert.ok(by.COMUN > by.RARA && by.RARA > by.EPICA, "curva descendente");
  // ids únicos
  assert.equal(new Set(a.map((t) => t.id)).size, 180, "sin duplicados");
});

test("destacado diario: subconjunto determinista del álbum, rota por fecha", () => {
  const pool = E.composeSeason("2026-06-01", 180);
  const h1 = E.dailyHighlights("2026-06-10", pool, 18);
  const h2 = E.dailyHighlights("2026-06-10", pool, 18);
  assert.equal(h1.length, 18);
  assert.deepEqual(h1.map((t) => t.id), h2.map((t) => t.id), "mismo día -> mismo destacado");
  const h3 = E.dailyHighlights("2026-06-11", pool, 18);
  assert.notDeepEqual(h1.map((t) => t.id), h3.map((t) => t.id), "otro día -> otro destacado");
  // Todos los destacados pertenecen al álbum.
  const ids = new Set(pool.map((t) => t.id));
  assert.ok(h1.every((t) => ids.has(t.id)), "subconjunto del álbum");
  // Domingo legendario (2026-06-07 es domingo): >=2 legendarias en el destacado.
  const dom = E.dailyHighlights("2026-06-07", pool, 18);
  assert.ok(dom.filter((t) => t.rarity === "LEGENDARIA").length >= 2, "domingo legendario garantiza >=2");
  // Sábado temático (2026-06-06 es sábado): sesga hacia el tipo del evento.
  const ev = E.dailyEvent("2026-06-06");
  assert.equal(ev.kind, "type");
  const sat = E.dailyHighlights("2026-06-06", pool, 18);
  const typed = sat.filter((t) => (t.types || [t.type]).includes(ev.type)).length;
  const baseShare = pool.filter((t) => (t.types || [t.type]).includes(ev.type)).length / pool.length * 18;
  assert.ok(typed >= baseShare, "sábado sesga hacia su tipo");
});

test("criatura única del día: id determinista y plantilla válida", () => {
  assert.equal(E.dailyUniqueId("2026-06-11"), "uniq_2026-06-11");
  const u = E.dailyUnique("2026-06-11");
  assert.equal(u.id, "uniq_2026-06-11");
  assert.deepEqual(u, E.genTemplate("uniq_2026-06-11"), "= genTemplate del id único");
});

test("IV por instancia: deterministas, dentro de ±6%, potencial 0..100", () => {
  const a = E.ivFor("inst-aaaa");
  const b = E.ivFor("inst-aaaa");
  assert.deepEqual(a, b, "mismo id -> mismos IV");
  assert.notDeepEqual(E.ivFor("inst-aaaa").mult, E.ivFor("inst-bbbb").mult, "ids distintos -> IV distintos");
  for (const k in a.mult) assert.ok(a.mult[k] >= 0.94 - 1e-9 && a.mult[k] <= 1.06 + 1e-9, `${k} en rango`);
  assert.ok(a.potential >= 0 && a.potential <= 100, "potencial 0..100");
  assert.equal(E.ivFor(null), null, "sin id -> null");
  // applyIV: redondea, mínimo 1, no muta el original.
  const base = { hp: 100, atkP: 50, atkS: 50, defP: 40, defS: 40, spd: 30 };
  const out = E.applyIV(base, "inst-cccc");
  assert.notEqual(out, base);
  assert.equal(base.hp, 100, "no muta el original");
  for (const k in out) assert.ok(out[k] >= 1, "stat >= 1");
  assert.deepEqual(E.applyIV(base, null), base, "sin id -> sin cambios");
});

test("shiny áurea: más rara que la prismática y determinista", () => {
  let aurea = 0, prism = 0;
  for (let i = 0; i < 20000; i++) {
    const id = "shiny-test-" + i;
    if (E.isShiny(id)) aurea++;
    if (E.isPrismatic(id)) prism++;
    // variantOf: áurea manda sobre prismática.
    if (E.isShiny(id)) assert.equal(E.variantOf(id), "aurea");
  }
  assert.ok(aurea > 0 && prism > 0, "ambas aparecen en la muestra");
  assert.ok(aurea < prism, `áurea (${aurea}) debe ser más rara que prismática (${prism})`);
  // ~0,25% y ~1% (tolerancia amplia por muestreo).
  assert.ok(aurea / 20000 < 0.01, "áurea ~0,25%");
  assert.equal(E.variantOf("shiny-test-0"), E.variantOf("shiny-test-0"), "determinista");
});

test("evolución: plan determinista 0/1/2 etapas con umbrales en rango", () => {
  let n0 = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < 2000; i++) {
    const id = "evo-test-" + i;
    const plan = E.evolutionPlan(id);
    assert.deepEqual(plan, E.evolutionPlan(id), "determinista");
    if (plan.length === 0) n0++;
    if (plan.length === 1) n1++;
    if (plan.length === 2) n2++;
    if (plan[0]) assert.ok(plan[0].at >= 12 && plan[0].at <= 18, "1ª evolución nv12-18");
    if (plan[1]) {
      assert.ok(plan[1].at >= 30 && plan[1].at <= 40, "2ª evolución nv30-40");
      assert.ok(plan[1].at > plan[0].at, "la 2ª llega después de la 1ª");
    }
  }
  // ~45/35/20 con tolerancia de muestreo.
  assert.ok(n0 > n1 && n1 > n2 && n2 > 100, `distribución razonable (${n0}/${n1}/${n2})`);
  // evoStageAt/evoNext coherentes con el plan.
  const id2 = Array.from({ length: 500 }, (_, i) => "evo-test-" + i).find((x) => E.evolutionPlan(x).length === 2);
  const plan = E.evolutionPlan(id2);
  assert.equal(E.evoStageAt(id2, plan[0].at - 1), 0);
  assert.equal(E.evoStageAt(id2, plan[0].at), 1);
  assert.equal(E.evoStageAt(id2, plan[1].at), 2);
  assert.deepEqual(E.evoNext(id2, 1), plan[0]);
  assert.deepEqual(E.evoNext(id2, plan[0].at), plan[1]);
  assert.equal(E.evoNext(id2, plan[1].at), null);
});

test("evolución: buildUnit aplica el salto de stats y el nombre evolucionado", () => {
  const id = Array.from({ length: 500 }, (_, i) => "evo-test-" + i).find((x) => E.evolutionPlan(x).length >= 1);
  const at = E.evolutionPlan(id)[0].at;
  const t = E.genTemplate(id);
  const before = E.buildUnit(t, at - 1, "A", 0);
  const after = E.buildUnit(t, at, "A", 0);
  assert.equal(before.evoStage, 0);
  assert.equal(after.evoStage, 1);
  assert.equal(before.name, t.name, "antes del umbral: nombre base");
  assert.equal(after.name, E.evoName(t.name, id, 1), "tras el umbral: nombre evolucionado");
  assert.notEqual(after.name, t.name);
  // Salto FUERTE: el HP al evolucionar supera con mucho el escalado normal de +1 nivel.
  const normalNext = Math.round(E.scaled(t.base_stats.hp, at));
  assert.ok(after.hpMax > normalNext * 1.25, `salto de evolución (${after.hpMax} > ${normalNext}×1.25)`);
  // Plantilla sin evolución: nada cambia a ningún nivel.
  const flat = Array.from({ length: 500 }, (_, i) => "evo-test-" + i).find((x) => E.evolutionPlan(x).length === 0);
  assert.equal(E.buildUnit(E.genTemplate(flat), 50, "A", 0).evoStage, 0);
  // Sprite y arte de variante: ids/semillas deterministas.
  assert.equal(E.evoArtSeed(id, 1), E.evoArtSeed(id, 1));
  assert.notEqual(E.evoArtSeed(id, 1), E.evoArtSeed(id, 2));
  assert.equal(E.variantArtId(id, "evo1"), id + "__evo1");
});

test("lore: artículos concuerdan con tags femeninos (sin 'del niebla')", () => {
  // Recorre muchas plantillas y comprueba que no aparecen concordancias rotas.
  for (let i = 0; i < 300; i++) {
    const t = E.genTemplate("lore_" + i);
    assert.ok(!/\bdel (niebla|tormenta|ceniza|mantis|anguila|polilla)\b/.test(t.lore), `lore roto: ${t.lore}`);
    assert.ok(!/\bel (niebla|tormenta|ceniza|mantis|anguila|polilla)\b/.test(t.lore), `lore roto: ${t.lore}`);
  }
});
