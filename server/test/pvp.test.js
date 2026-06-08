// =============================================================================
// pvp.test.js — PvP en vivo (WebSocket). Integración real: levanta un http
// server + attachPvp con deps mockeadas (sin BD), conecta dos clientes ws y
// juega un match completo. Verifica emparejamiento, rondas, resultado y forfeit.
// Sin BD: node --test.
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WS = require("ws");
const E = require("../src/config");
const auth = require("../src/auth");
const { attachPvp } = require("../src/pvp");

// Equipo de prueba (3 unidades deterministas por usuario).
function fakeTeam(userId, team) {
  return [0, 1, 2].map((i) => {
    const t = E.genTemplate("pvp_" + userId + "_" + i);
    const u = E.buildUnit(t, 10, team, i);
    u.instanceId = "inst_" + userId + "_" + i;
    return u;
  });
}
const deps = {
  db: { query: async () => ({ rows: [], rowCount: 0 }) },
  getUser: async (id) => ({ id, display_name: "U" + id, energy: 5, league_points: 100, energy_updated_at: new Date() }),
  syncEnergy: async (u) => u,
  buildTeamUnits: async (userId, team) => fakeTeam(userId, team),
  awardBattleResult: async ({ win }) => ({ coins: win ? 40 : 8, leaguePoints: win ? 112 : 94, league: "PLATA", energy: 4 }),
  publicUnit: (u) => ({ uid: u.uid, tplId: u.tplId, name: u.name, type: u.type, types: u.types, ability: u.ability, level: u.level, hpMax: u.hpMax, atkP: u.atkP, atkS: u.atkS, defP: u.defP, defS: u.defS, spd: u.spd, startEnergy: u.startEnergy || 0 }),
  MATCH_LEVEL_WINDOW: 15,
};

function listen() {
  const server = http.createServer();
  attachPvp(server, deps);
  return new Promise((res) => server.listen(0, () => res({ server, port: server.address().port })));
}
function connect(port, userId) {
  const token = auth.sign({ id: userId });
  return new WS("ws://127.0.0.1:" + port + "/pvp?token=" + token);
}

test("PvP en vivo: dos jugadores -> match, rondas resueltas y resultado coherente", async () => {
  const { server, port } = await listen();
  const a = connect(port, "ua"), b = connect(port, "ub");

  // Driver: al recibir 'hello' entra en cola; en cada 'round' manda plan; resuelve al 'over'.
  let rounds = 0;
  const drive = (ws) => new Promise((resolve) => {
    let mine = null;
    ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.t === "hello") ws.send(JSON.stringify({ t: "queue", stance: "NEUTRAL" }));
      else if (m.t === "match") mine = m;
      else if (m.t === "round") {
        const you = mine.you;
        ws.send(JSON.stringify({ t: "plan", round: m.round, decisions: [0, 1, 2].map((i) => ({ uid: you + i, action: "attack" })) }));
      } else if (m.t === "resolve") { rounds++; }
      else if (m.t === "over") resolve({ over: m, you: mine.you, team: mine.team });
    });
  });

  const [ra, rb] = await Promise.all([drive(a), drive(b)]);
  assert.equal(ra.team.length, 3, "el equipo llega con 3 unidades");
  assert.ok(ra.over.winner === "A" || ra.over.winner === "B");
  assert.equal(ra.over.winner, rb.over.winner, "ambos ven el mismo ganador");
  assert.equal(ra.over.youWon, ra.you === ra.over.winner, "youWon coherente con el rol (A)");
  assert.equal(rb.over.youWon, rb.you === rb.over.winner, "youWon coherente con el rol (B)");
  assert.ok(rounds >= 2, "se resolvieron varias rondas");
  a.close(); b.close();
  await new Promise((r) => server.close(r));
});

test("PvP en vivo: emparejamiento solo entre usuarios distintos", async () => {
  const { server, port } = await listen();
  // Mismo usuario en dos pestañas NO debe emparejarse consigo mismo.
  const a = connect(port, "same"), b = connect(port, "same");
  let matched = false;
  const watch = (ws) => { ws.on("message", (buf) => { const m = JSON.parse(buf.toString()); if (m.t === "hello") ws.send(JSON.stringify({ t: "queue", stance: "NEUTRAL" })); if (m.t === "match") matched = true; }); };
  watch(a); watch(b);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(matched, false, "no se empareja un usuario consigo mismo");
  a.close(); b.close();
  await new Promise((r) => server.close(r));
});

test("PvP en vivo: si un jugador se desconecta, el otro gana por abandono", async () => {
  const { server, port } = await listen();
  const a = connect(port, "ua"), b = connect(port, "ub");
  let aMatch = null, aOver = null, aLeft = false;
  a.on("message", (buf) => { const m = JSON.parse(buf.toString()); if (m.t === "hello") a.send(JSON.stringify({ t: "queue", stance: "NEUTRAL" })); if (m.t === "match") aMatch = m; if (m.t === "opponentLeft") aLeft = true; if (m.t === "over") aOver = m; });
  b.on("message", (buf) => { const m = JSON.parse(buf.toString()); if (m.t === "hello") b.send(JSON.stringify({ t: "queue", stance: "NEUTRAL" })); if (m.t === "match") setTimeout(() => b.close(), 50); });
  await new Promise((r) => { const iv = setInterval(() => { if (aOver) { clearInterval(iv); r(); } }, 30); setTimeout(() => { clearInterval(iv); r(); }, 3000); });
  assert.ok(aMatch, "se creó el match");
  assert.ok(aLeft, "el que queda recibe opponentLeft");
  assert.ok(aOver && aOver.youWon === true, "el que queda gana por abandono");
  a.close();
  await new Promise((r) => server.close(r));
});
