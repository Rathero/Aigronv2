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
