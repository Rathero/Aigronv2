// =============================================================================
// balance.test.js — Tests de BALANCE del combate. Garantizan que nadie se
// frustre al lanzar la app: no hay estrategias degeneradas (turtleo infinito,
// stun-lock perpetuo, escudos/curas que hacen inmortal), ningún tipo domina,
// las mecánicas nuevas (veneno/aturdir/escudo/drenar) están acotadas, y los
// combates SIEMPRE terminan. Sin BD: node --test.
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../../web/engine.js");

// ----------------------------- helpers --------------------------------------
function teamFrom(ids, team, level = 10) {
  return ids.map((id, i) => E.buildUnit(E.genTemplate(String(id)), level, team, i));
}
// Decisiones programadas: cada turno, cada unidad de A hace `action` (objetivo auto).
function allAction(team, action, target) {
  const d = [];
  for (let t = 1; t <= E.TURNS_MAX; t++) for (const u of team) d.push({ turn: t, uid: u.uid, action, target });
  return d;
}
// Corre un combate (reconstruye equipos -> mutación contenida). B siempre IA.
function battle(idsA, idsB, action, seed, level = 10) {
  const A = teamFrom(idsA, "A", level);
  const B = teamFrom(idsB, "B", level);
  const dec = action ? allAction(A, action) : [];
  return E.resolveBattle(A, B, seed >>> 0, dec);
}
// Equipo mono-tipo con stats IDÉNTICOS (aísla la variable TIPO).
function monoStats(type, ability) {
  return { tplId: "m", name: type, type, types: [type], ability, level: 10,
    hpMax: 1000, atkP: 140, atkS: 140, defP: 80, defS: 80, spd: 100, startEnergy: 0 };
}
function monoTeam(type, team, ability) {
  return [0, 1, 2].map((i) => E.unitFromStats(monoStats(type, ability), team, i));
}

// ============================ 1. TERMINACIÓN ================================
// Ningún combate puede colgarse ni petar. 600 emparejamientos aleatorios.
test("balance: todo combate termina (<=TURNS_MAX) con ganador, sin excepción", () => {
  const actions = [null, "ability", "guard", "attack"];
  for (let s = 0; s < 600; s++) {
    const idsA = [s * 3 + 1, s * 3 + 2, s * 3 + 3];
    const idsB = [s * 3 + 101, s * 3 + 102, s * 3 + 103];
    const act = actions[s % actions.length];
    const r = battle(idsA, idsB, act, 1000 + s);
    assert.ok(r.turns >= 1 && r.turns <= E.TURNS_MAX, `turnos fuera de rango: ${r.turns}`);
    assert.ok(r.winner === "A" || r.winner === "B", `ganador inválido: ${r.winner}`);
    assert.ok(r.hpA >= 0 && r.hpB >= 0 && Number.isFinite(r.hpA) && Number.isFinite(r.hpB));
  }
});

// A nivel máximo (100) y en mismatches extremos de nivel, el combate sigue
// terminando bien (sin overflow/NaN/cuelgue).
test("balance: combates a nivel alto y dispares terminan limpio", () => {
  const cases = [[100, 100], [1, 100], [100, 1], [50, 50], [25, 75]];
  for (let s = 0; s < cases.length * 20; s++) {
    const [la, lb] = cases[s % cases.length];
    const A = teamFrom([s + 1, s + 2, s + 3], "A", la);
    const B = teamFrom([s + 51, s + 52, s + 53], "B", lb);
    const r = E.resolveBattle(A, B, 12000 + s, allAction(A, "ability"));
    assert.ok(r.turns >= 1 && r.turns <= E.TURNS_MAX);
    assert.ok((r.winner === "A" || r.winner === "B") && Number.isFinite(r.hpA) && Number.isFinite(r.hpB));
  }
});

// El sustain extremo NO es inmortal: un equipo defensivo/curador enfrenta a uno
// agresivo y el combate termina igualmente (no se eterniza hasta el cap por bug).
test("balance: sustain máximo vs agresión -> el combate termina y decide", () => {
  // PLANTA/HONGO/MAREA = curas/regen/drenaje/escudos. VOLCAN/BESTIA = puro daño.
  const sustain = teamFrom([7, 19, 13], "A"); // HONGO/PLANTA-ish por id determinista
  const r = E.resolveBattle(
    teamFrom([7, 19, 13], "A"),
    teamFrom([2, 5, 9], "B"),
    424242,
    allAction(sustain, "ability")
  );
  assert.ok(r.turns <= E.TURNS_MAX);
  assert.ok(r.winner === "A" || r.winner === "B");
});

// ===================== 2. ESTRATEGIA PASIVA CASTIGADA =======================
// Turtlear (solo guardia) no puede ganar: no hace daño -> pierde casi siempre.
test("balance: equipo SOLO-guardia pierde (no se gana turtleando)", () => {
  let aWins = 0, n = 120;
  for (let s = 0; s < n; s++) {
    const r = battle([s + 1, s + 2, s + 3], [s + 41, s + 42, s + 43], "guard", 7000 + s);
    if (r.winner === "A") aWins++;
  }
  const wr = aWins / n;
  assert.ok(wr < 0.06, `guardia-pura gana demasiado: ${(wr * 100).toFixed(1)}%`);
});

// ===================== 3. USAR HABILIDADES IMPORTA ==========================
// Jugar con habilidades rinde MÁS que solo pegar básico, pero ninguna es auto-win.
test("balance: habilidades > básico, y ambas viables (ni 0% ni 100%)", () => {
  let abilWins = 0, basicWins = 0, n = 160;
  for (let s = 0; s < n; s++) {
    const idsA = [s * 2 + 1, s * 2 + 5, s * 2 + 9];
    const idsB = [s * 2 + 201, s * 2 + 205, s * 2 + 209];
    if (battle(idsA, idsB, "ability", 9000 + s).winner === "A") abilWins++;
    if (battle(idsA, idsB, null, 9000 + s).winner === "A") basicWins++;
  }
  const wAbil = abilWins / n, wBasic = basicWins / n;
  assert.ok(wAbil > wBasic, `habilidades (${wAbil.toFixed(2)}) no superan a básico (${wBasic.toFixed(2)})`);
  assert.ok(wAbil > 0.05 && wAbil < 0.95, `habilidades degeneradas: ${wAbil.toFixed(2)}`);
  assert.ok(wBasic > 0.02, `básico inviable: ${wBasic.toFixed(2)}`);
});

// ===================== 4. NINGÚN TIPO DOMINA ================================
// Round-robin mono-tipo con stats IDÉNTICOS y MISMA habilidad (TAJO): la única
// variable es la efectividad de tipo. El anillo es simétrico -> winrate ~50%.
test("balance: ningún tipo domina (round-robin equitativo)", () => {
  const wins = {}, games = {};
  E.TYPES.forEach((t) => { wins[t] = 0; games[t] = 0; });
  let seed = 50000;
  for (const ti of E.TYPES) {
    for (const tj of E.TYPES) {
      if (ti === tj) continue;
      // ti como A (script) vs tj como B (IA), y la dirección inversa: cancela el sesgo de lado.
      for (const [ta, tb] of [[ti, tj], [tj, ti]]) {
        const A = monoTeam(ta, "A", "TAJO"), B = monoTeam(tb, "B", "TAJO");
        const r = E.resolveBattle(A, B, seed++, allAction(A, "ability"));
        games[ta]++; games[tb]++;
        if (r.winner === "A") wins[ta]++; else wins[tb]++;
      }
    }
  }
  for (const t of E.TYPES) {
    const wr = wins[t] / games[t];
    assert.ok(wr >= 0.3 && wr <= 0.7, `tipo ${t} desbalanceado: winrate ${(wr * 100).toFixed(1)}%`);
  }
});

// Efectividad de tipo: anillo simétrico, sin inmunidades, multiplicadores acotados.
test("balance: efectividad de tipo simétrica y acotada (sin inmunidad, sin OP)", () => {
  for (const t of E.TYPES) {
    assert.equal(E.STRONG[t].length, 2, `${t} debe ser fuerte vs exactamente 2`);
    assert.ok(!E.STRONG[t].includes(t), `${t} no puede ser fuerte contra sí mismo`);
    const weakTo = E.TYPES.filter((s) => E.STRONG[s].includes(t)).length;
    assert.equal(weakTo, 2, `${t} debe ser débil ante exactamente 2 (tiene ${weakTo})`);
  }
  // typeMult ∈ {0.75, 1, 1.5}; dual (producto) ∈ [0.5625, 2.25]. Nunca 0 (inmunidad) ni >2.5.
  for (const a of E.TYPES) {
    for (const d1 of E.TYPES) {
      for (const d2 of E.TYPES) {
        const m = E.typeEff(a, [d1, d2]);
        assert.ok(m > 0, `inmunidad detectada ${a} vs ${d1}/${d2}`);
        assert.ok(m >= 0.5 && m <= 2.5, `multiplicador fuera de rango: ${a} vs ${d1}/${d2} = ${m}`);
      }
    }
  }
});

// ===================== 5. STATS POR RAREZA MONÓTONAS =======================
test("balance: stats crecen (o igual) con la rareza, sin solapes invertidos", () => {
  const order = ["COMUN", "RARA", "EPICA", "LEGENDARIA"];
  const keys = ["hp", "atkP", "atkS", "defP", "defS", "spd"];
  for (const k of keys) {
    for (let i = 1; i < order.length; i++) {
      const lo = E.RANGES[order[i - 1]][k], hi = E.RANGES[order[i]][k];
      assert.ok(hi[0] >= lo[0], `${k}: min ${order[i]} < ${order[i - 1]}`);
      assert.ok(hi[1] >= lo[1], `${k}: max ${order[i]} < ${order[i - 1]}`);
    }
  }
});

// ===================== 6. MECÁNICAS NUEVAS ACOTADAS ========================
// VENENO/QUEMADURA: daño por turno NO letal por sí solo (<= 30% vida en 3 turnos).
test("balance: DoT acotado — el veneno no mata por sí solo a vida llena", () => {
  for (const ab of ["VENENO", "QUEMADURA"]) {
    const A = E.ABILITIES[ab];
    const u = E.unitFromStats(monoStats("TOXICO", ab), "A", 0);
    const hp0 = u.hp;
    let total = 0;
    for (let i = 0; i < A.turns; i++) total += E.tickStatus(u).poison;
    assert.ok(u.hp > 0, `${ab} mató a vida llena (degenerado)`);
    assert.ok(total <= hp0 * 0.31, `${ab} pega de más: ${total}/${hp0}`);
    assert.equal(u.poisonTurns, 0, `${ab} no se consumió`);
  }
});

// ATURDIR/ESCARCHA: la economía de energía impide el stun-lock perpetuo.
// Un aturdidor 1v1 no deja al rival aturdido más de ~1/3 de sus turnos.
test("balance: el aturdimiento NO encadena (rival actúa la mayoría de turnos)", () => {
  for (const ab of ["ATURDIR", "ESCARCHA"]) {
    const A = [E.unitFromStats(monoStats("RELOJ", ab), "A", 0)];
    A[0].hpMax = A[0].hp = 6000; // tanque: el combate dura para medir
    const B = [E.unitFromStats(monoStats("BESTIA", "TAJO"), "B", 0)];
    B[0].hpMax = B[0].hp = 6000;
    const r = E.resolveBattle(A, B, 31337, allAction(A, "ability"));
    const bTurns = r.log.filter((l) => l.uid === "B0").length;
    const bStunned = r.log.filter((l) => l.uid === "B0" && l.stunned).length;
    assert.ok(bTurns > 5, `combate demasiado corto para medir (${bTurns})`);
    assert.ok(bStunned / bTurns <= 0.4, `${ab} hace stun-lock: ${bStunned}/${bTurns} turnos aturdido`);
  }
});

// ESCUDO: barrera repetida NO hace inmortal frente a un atacante fuerte; muere y
// el combate se decide (no se eterniza por escudos que superan el daño).
test("balance: el escudo no hace inmortal frente a daño fuerte", () => {
  const shield = E.unitFromStats(
    { tplId: "s", name: "muro", type: "CRISTAL", types: ["CRISTAL"], ability: "BARRERA",
      hpMax: 800, defP: 40, defS: 40, atkP: 60, atkS: 60, spd: 60, startEnergy: 0, level: 10 }, "A", 0);
  const hitter = E.unitFromStats(
    { tplId: "h", name: "ariete", type: "VOLCAN", types: ["VOLCAN"], ability: "TAJO",
      hpMax: 800, defP: 40, defS: 40, atkP: 260, atkS: 260, spd: 120, startEnergy: 0, level: 10 }, "B", 0);
  const r = E.resolveBattle([shield], [hitter], 777, allAction([shield], "ability"));
  assert.equal(r.winner, "B", "el escudo se volvió inmortal");
  assert.ok(r.turns < E.TURNS_MAX, "el escudo eternizó el combate (no murió)");
});

// DRENAR / CURAS: la vida nunca supera el máximo (sin sobrecuración explotable).
test("balance: drenar/curar nunca exceden la vida máxima", () => {
  // Drenaje con el lanzador casi a tope.
  const att = E.unitFromStats(monoStats("BESTIA", "DRENAJE"), "A", 0);
  att.energy = 6; att.hp = att.hpMax - 1;
  const foes = [E.unitFromStats(monoStats("PLANTA", "TAJO"), "B", 0)];
  E.performAction(() => 0.99, att, { type: "ability" }, [att], foes);
  assert.ok(att.hp <= att.hpMax, `drenaje sobrecuró: ${att.hp}/${att.hpMax}`);
  // Cura propia a tope.
  const heal = E.unitFromStats(monoStats("PLANTA", "CURA_MENOR"), "A", 0);
  heal.energy = 6; heal.hp = heal.hpMax;
  E.performAction(() => 0.99, heal, { type: "ability" }, [heal], [E.unitFromStats(monoStats("VOLCAN", "TAJO"), "B", 0)]);
  assert.equal(heal.hp, heal.hpMax, "cura superó el máximo");
});

// ===================== 7. SOBRECARGA ACOTADA ================================
test("balance: sobrecarga = x1.5 exacto y exige +2 energía (no es gratis)", () => {
  const mk = () => E.unitFromStats(monoStats("VOLCAN", "TAJO"), "A", 0); // TAJO: dmg, sin crit
  const tgtStats = () => monoStats("HONGO", "TAJO"); // neutral VOLCAN->HONGO
  const noCrit = () => 0.99;
  // Base (sin sobrecarga).
  const a1 = mk(); a1.energy = 3;
  const r1 = E.performAction(noCrit, a1, { type: "ability" }, [a1], [E.unitFromStats(tgtStats(), "B", 0)]);
  // Sobrecargada.
  const a2 = mk(); a2.energy = 5;
  const r2 = E.performAction(noCrit, a2, { type: "ability", overcharge: true }, [a2], [E.unitFromStats(tgtStats(), "B", 0)]);
  assert.equal(r2.overcharge, true, "no aplicó sobrecarga con energía suficiente");
  const ratio = r2.hits[0].dmg / r1.hits[0].dmg;
  assert.ok(Math.abs(ratio - 1.5) < 0.03, `sobrecarga no es x1.5: ${ratio.toFixed(3)}`);
  // Sin energía para el extra: NO sobrecarga aunque se pida.
  const a3 = mk(); a3.energy = 4; // cost 3 + extra 2 = 5 > 4
  const r3 = E.performAction(noCrit, a3, { type: "ability", overcharge: true }, [a3], [E.unitFromStats(tgtStats(), "B", 0)]);
  assert.equal(r3.overcharge, false, "sobrecargó sin energía suficiente");
});

// ===================== 8. CAPITÁN / ESTANCIA ACOTADOS ======================
test("balance: capitán/estancia dan ventaja acotada y con contrapartida", () => {
  const base = teamFrom([11, 22, 33], "A");
  const baseCap = base[0].atkP, baseHp = base[0].hpMax, baseDef = base[0].defP;
  // Agresiva + capitán: tope = 1.15(estancia)*1.06(liderazgo)*1.15(capitán) ≈ 1.40.
  const aggro = teamFrom([11, 22, 33], "A");
  E.applyCaptainStance(aggro, aggro[0].uid, "AGRESIVA");
  assert.ok(aggro[0].atkP <= Math.round(baseCap * 1.41), `capitán infla ATK de más: ${aggro[0].atkP} vs base ${baseCap}`);
  assert.ok(aggro[0].hpMax <= Math.round(baseHp * 1.16), "capitán infla HP de más");
  // Defensiva: sube defensa pero BAJA ataque (contrapartida real) en no-capitanes.
  const def = teamFrom([11, 22, 33], "A");
  E.applyCaptainStance(def, def[0].uid, "DEFENSIVA");
  assert.ok(def[1].defP > baseDef, "defensiva no sube defensa");
  assert.ok(def[1].atkP < base[1].atkP, "defensiva no penaliza ataque");
});

// ===================== 8b. ARQUETIPOS DE TIPO BALANCEADOS ==================
// Cada tipo cambia la FORMA de sus stats, pero con el MISMO presupuesto total:
// hp+atk+defP+defS+spd = 5.00. Así ningún tipo es estrictamente superior.
test("balance: arquetipos por tipo con presupuesto igual (5.00) y acotados", () => {
  for (const t of E.TYPES) {
    const p = E.TYPE_STATS[t];
    assert.ok(p, `falta perfil de stats para ${t}`);
    const sum = p.hp + p.atk + p.defP + p.defS + p.spd;
    assert.ok(Math.abs(sum - 5.0) < 0.001, `${t}: presupuesto ${sum.toFixed(3)} != 5.00`);
    for (const [k, v] of Object.entries(p)) {
      assert.ok(v >= 0.7 && v <= 1.35, `${t}.${k}=${v} fuera de [0.7,1.35]`);
    }
  }
});

// El bias se aplica de verdad en la generación y respeta el arquetipo (la forma
// relativa entre dos tipos opuestos se invierte como se espera).
test("balance: el bias diferencia tipos en la generación", () => {
  const flat = () => ({ hp: 1000, atkP: 140, atkS: 140, defP: 80, defS: 80, spd: 100 });
  const pluma = E.applyTypeBias(flat(), "PLUMA");   // veloz/frágil
  const metal = E.applyTypeBias(flat(), "METAL");   // lento/blindado
  assert.ok(pluma.spd > metal.spd, "PLUMA debería ser más rápido que METAL");
  assert.ok(metal.defP > pluma.defP, "METAL debería tener más defensa física que PLUMA");
  assert.ok(metal.hp > pluma.hp, "METAL debería tener más HP que PLUMA");
});

// ===================== 9. DETERMINISMO CON MECÁNICAS NUEVAS =================
test("balance: combate determinista (mismas entradas -> mismo resultado)", () => {
  const run = () => {
    const A = monoTeam("TOXICO", "A", "VENENO"), B = monoTeam("METAL", "B", "EGIDA");
    return E.resolveBattle(A, B, 246810, allAction(A, "ability"));
  };
  const r1 = run(), r2 = run();
  assert.deepEqual(
    { w: r1.winner, t: r1.turns, a: r1.hpA, b: r1.hpB },
    { w: r2.winner, t: r2.turns, a: r2.hpA, b: r2.hpB }
  );
});
