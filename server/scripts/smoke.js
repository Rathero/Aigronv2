// scripts/smoke.js — Prueba de humo de integración del bucle completo contra una
// API en marcha (por defecto http://localhost:3000). Sale con código != 0 si algo
// falla. Verifica además que el combate del servidor coincide con el motor (engine).
//
//   node scripts/smoke.js [baseUrl]
const E = require("../../web/engine.js");
const BASE = process.argv[2] || process.env.SMOKE_BASE || "http://localhost:3000";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ✅", msg); } else { fail++; console.error("  ❌", msg); } }

async function api(token, path, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = {}; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

async function loginAs(subject) {
  const r = await api(null, "/auth/login", { method: "POST", body: { provider: "dev", subject, displayName: subject } });
  return r.data;
}

(async () => {
  console.log("Smoke test contra", BASE);

  // Salud
  const h = await api(null, "/health");
  ok(h.status === 200 && h.data.ok, "/health responde ok");

  // Login user1 (SIN starters: el primer reclamo da estrella nv5 + 2 crías)
  const u1 = await loginAs("smoke-u1-" + Date.now());
  ok(!!u1.token, "login devuelve token");
  const t1 = u1.token;

  const me = await api(t1, "/me");
  ok(me.status === 200, "/me ok");
  ok(Array.isArray(me.data.missions) && me.data.missions.length === 3, "/me trae 3 misiones");

  const daily = await api(t1, "/daily");
  ok(daily.status === 200 && daily.data.batch.length > 0, "/daily trae lote (" + daily.data.batch.length + ")");
  ok(daily.data.claimed === false, "daily no reclamado aún");

  const claim = await api(t1, "/daily/claim", { method: "POST" });
  ok(claim.status === 200 && claim.data.instance, "/daily/claim crea instancia");
  ok(claim.data.first === true && claim.data.instance.level === 5, "primer reclamo = estrella nv5");
  ok(Array.isArray(claim.data.companions) && claim.data.companions.length === 2, "el primer reclamo trae 2 crías");
  const claim2 = await api(t1, "/daily/claim", { method: "POST" });
  ok(claim2.status === 400, "segundo /daily/claim rechazado");

  let coll = await api(t1, "/collection");
  ok(coll.status === 200 && coll.data.length === 3, "/collection == 3 (estrella + 2 crías)");
  ok(coll.data.filter((c) => c.locked).length === 1, "solo la estrella está protegida");

  // Equipo: estrella + crías (las tiradas de tienda quedan libres para fusionar)
  const slots = coll.data.map((c) => c.instance_id).slice(0, 3);
  const team = await api(t1, "/team", { method: "PUT", body: { slots } });
  ok(team.status === 200 && team.data.slots.length === 3, "PUT /team guarda 3");

  // Combate: find con capitán + estancia DEFENSIVA, decisiones ricas, determinismo.
  const find = await api(t1, "/battle/find", { method: "POST", body: { captain: slots[0], stance: "DEFENSIVA" } });
  ok(find.status === 200 && find.data.battleId && find.data.opponent.length === 3, "/battle/find devuelve rival + battleId");
  ok(find.data.team.every((u) => u.startEnergy === 1), "estancia DEFENSIVA arranca con +1 energía (horneada)");

  const decisions = [
    { turn: 2, uid: "A0", action: "ability", target: "B1", overcharge: true },
    { turn: 2, uid: "A1", action: "guard" },
  ];
  const A = find.data.team.map((s, i) => E.unitFromStats(s, "A", i));
  const B = find.data.opponent.map((s, i) => E.unitFromStats(s, "B", i));
  const expected = E.resolveBattle(A, B, find.data.seed | 0, decisions);
  const resolve = await api(t1, "/battle/resolve", { method: "POST", body: { battleId: find.data.battleId, decisions } });
  ok(resolve.status === 200, "/battle/resolve ok (decisiones ricas)");
  ok((expected.winner === "A") === resolve.data.win, "resultado del servidor == motor con capitán/estancia/guardia/objetivo/sobrecarga");

  const reResolve = await api(t1, "/battle/resolve", { method: "POST", body: { battleId: find.data.battleId, decisions: [] } });
  ok(reResolve.status === 404, "no se puede resolver dos veces la misma oferta (anti-trampa)");

  // Rankings: devuelven { rows, me } (tu posición aunque no estés en el top)
  const rd = await api(t1, "/rankings/daily");
  ok(rd.status === 200 && Array.isArray(rd.data.rows), "/rankings/daily ok");
  const rl = await api(t1, "/rankings/league");
  ok(rl.status === 200 && Array.isArray(rl.data.rows) && rl.data.me && rl.data.me.pos >= 1, "/rankings/league ok (con posición propia)");

  // Misiones: la de reclamar ya está completa -> reclamar recompensa
  const mc = await api(t1, "/missions/claim", { method: "POST", body: { key: "claim" } });
  ok(mc.status === 200 && mc.data.reward === 30, "/missions/claim concede recompensa");
  const mc2 = await api(t1, "/missions/claim", { method: "POST", body: { key: "claim" } });
  ok(mc2.status === 400, "no se reclama dos veces la misma misión");

  // Tienda: dos tiradas (la fusión necesita 2 instancias libres fuera del equipo)
  const roll = await api(t1, "/shop/roll", { method: "POST" });
  ok(roll.status === 200 && roll.data.template, "/shop/roll crea aigrón");
  await api(t1, "/shop/roll", { method: "POST" });

  // Fusión: usa dos instancias NO bloqueadas (la diaria + la de tienda)
  coll = await api(t1, "/collection");
  const freeAll = coll.data.filter((c) => !c.locked && !slots.includes(c.instance_id));
  // Prioriza instancias COMUNes (coste 100) para no depender de la suerte de rareza.
  const commons = freeAll.filter((c) => c.template.rarity === "COMUN").map((c) => c.instance_id);
  const free = (commons.length >= 2 ? commons : freeAll.map((c) => c.instance_id)).slice(0, 2);
  if (free.length === 2) {
    const fus = await api(t1, "/fusion", { method: "POST", body: { a: free[0], b: free[1] } });
    // 200 = fusionada; 400 insufficient = comportamiento válido si la rareza encarece el coste.
    const okFus = (fus.status === 200 && fus.data.instance && fus.data.instance.template.id.startsWith("fusion_")) ||
      (fus.status === 400 && fus.data.error === "insufficient");
    ok(okFus, "/fusion crea criatura fusionada (o rechaza por coste, correcto)");
  } else {
    ok(false, "no había 2 instancias libres para fusionar");
  }

  // PvP: user2 debería poder emparejarse contra el snapshot de user1
  // (sin starters al login: reclama primero su estrella + crías)
  const u2 = await loginAs("smoke-u2-" + Date.now());
  await api(u2.token, "/daily/claim", { method: "POST" });
  const c2 = await api(u2.token, "/collection");
  await api(u2.token, "/team", { method: "PUT", body: { slots: c2.data.slice(0, 3).map((c) => c.instance_id) } });
  const find2 = await api(u2.token, "/battle/find", { method: "POST" });
  ok(find2.status === 200 && find2.data.opponent.length === 3, "user2 /battle/find ok (pvp=" + find2.data.pvp + ")");

  // --- Mazmorra del día (roguelike) ---
  const dgStart = await api(t1, "/dungeon/start", { method: "POST" });
  ok(dgStart.status === 200 && dgStart.data.stage && dgStart.data.team.length >= 1, "/dungeon/start inicia run");
  let st = dgStart.data, guard = 0, battles = 0, detOk = true;
  while (st.status === "active" && guard < 40) {
    guard++;
    if (st.stage === "choosing") {
      let idx = st.options.findIndex((o) => ["COMBATE", "ELITE", "JEFE"].includes(o.type));
      if (idx < 0) idx = 0;
      st = (await api(t1, "/dungeon/choose", { method: "POST", body: { choice: idx } })).data;
    } else if (st.stage === "combat") {
      const b = st.battle;
      const A = b.team.map((s, i) => E.unitFromStats(s, "A", i)); E.applyRelics(A, b.relics); A.forEach((u, i) => (u.hp = Math.min(u.hpMax, b.team[i].hp)));
      const B = b.enemy.map((s, i) => E.unitFromStats(s, "B", i));
      const exp = E.resolveBattle(A, B, b.battleSeed, []);
      const r = await api(t1, "/dungeon/battle", { method: "POST", body: { decisions: [] } });
      battles++;
      if ((exp.winner === "A") !== r.data.win) detOk = false;
      st = r.data.state;
    } else if (st.stage === "draft") {
      st = (await api(t1, "/dungeon/draft", { method: "POST", body: { choice: 0 } })).data;
    } else if (st.stage === "shop") {
      st = (await api(t1, "/dungeon/shop", { method: "POST", body: { action: "leave" } })).data;
    } else break;
  }
  ok(battles > 0, "se jugaron combates de mazmorra (" + battles + ")");
  ok(detOk, "combate de mazmorra: servidor == motor (determinista con reliquias)");
  ok(["cleared", "dead"].includes(st.status), "la run termina (status=" + st.status + ", depth=" + st.depth + ")");
  const dgRank = await api(t1, "/dungeon/ranking?difficulty=NORMAL");
  ok(dgRank.status === 200 && Array.isArray(dgRank.data.rows), "/dungeon/ranking ok");

  console.log(`\nResultado: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Smoke abortó:", e); process.exit(1); });
