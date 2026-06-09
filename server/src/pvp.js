// =============================================================================
// pvp.js — PvP EN VIVO (humano vs humano, por turnos en tiempo real) sobre
// WebSocket. El servidor es AUTORITATIVO: empareja por nivel (cola pública),
// pide a cada jugador su plan de ronda (ventana de 10s), resuelve UN turno con
// el motor compartido (E.stepTurn) y manda el LOG a ambos clientes, que solo lo
// ANIMAN (cero divergencia). Estado de match en memoria (1 réplica de Railway).
//
//   attachPvp(httpServer, deps) -> engancha un WebSocketServer en path /pvp.
//   deps = { db, getUser, syncEnergy, buildTeamUnits, awardBattleResult,
//            publicUnit, MATCH_LEVEL_WINDOW }
// Auth: ?token=<jwt> (mismo JWT de sesión).
// =============================================================================
const { WebSocketServer } = require("ws");
const urlMod = require("url");
const auth = require("./auth");
const E = require("./config"); // motor compartido

const PLAN_MS = 10000;   // ventana de planificación por ronda
const GRACE_MS = 1500;   // margen tras el deadline antes de resolver con defaults
const STANCES_OK = ["NEUTRAL", "AGRESIVA", "DEFENSIVA"];

function attachPvp(server, deps) {
  const { getUser, syncEnergy, buildTeamUnits, awardBattleResult, publicUnit, MATCH_LEVEL_WINDOW } = deps;
  const wss = new WebSocketServer({ server, path: "/pvp" });

  let queue = [];           // [{ userId, ws, captain, stance, level, name }]
  const matches = new Map(); // id -> match
  let seq = 1;

  const send = (ws, obj) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} };
  const bcast = (match, obj) => { send(match.players.A.ws, obj); send(match.players.B.ws, obj); };
  const teamHp = (team) => team.filter((u) => u.hp > 0).reduce((s, u) => s + u.hp, 0);

  wss.on("connection", (ws, req) => {
    const q = urlMod.parse(req.url, true).query;
    const userId = auth.verifyToken(q.token);
    if (!userId) { send(ws, { t: "error", msg: "auth" }); ws.close(); return; }
    ws.userId = userId; ws.match = null; ws.role = null;
    ws.on("message", (buf) => { handleMessage(ws, buf).catch(() => {}); });
    ws.on("close", () => handleClose(ws));
    ws.on("error", () => {});
    send(ws, { t: "hello" });
  });

  async function handleMessage(ws, buf) {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.t === "queue") return enqueue(ws, m);
    if (m.t === "leave") return leaveQueue(ws);
    if (m.t === "plan") return onPlan(ws, m);
  }

  async function enqueue(ws, m) {
    if (ws.match || queue.find((x) => x.ws === ws)) return; // ya en cola o partida
    const u = await syncEnergy(await getUser(ws.userId));
    if (!u) return send(ws, { t: "error", msg: "user" });
    if (u.energy < 1) return send(ws, { t: "error", msg: "no_energy" });
    const team = await buildTeamUnits(ws.userId, "A");
    if (!team.length) return send(ws, { t: "error", msg: "empty_team" });
    const level = Math.round(team.reduce((s, x) => s + (x.level || 1), 0) / team.length);
    const entry = { userId: ws.userId, ws, captain: m.captain, stance: m.stance, level, name: u.display_name };
    // Rival compatible: usuario distinto y nivel dentro de la ventana.
    const idx = queue.findIndex((x) => x.userId !== ws.userId && Math.abs(x.level - level) <= MATCH_LEVEL_WINDOW);
    if (idx >= 0) { const other = queue.splice(idx, 1)[0]; return startMatch(other, entry); }
    queue.push(entry);
    send(ws, { t: "queued" });
  }

  function leaveQueue(ws) { queue = queue.filter((x) => x.ws !== ws); if (!ws.match) send(ws, { t: "left" }); }

  async function startMatch(pA, pB) {
    const teamA = await buildTeamUnits(pA.userId, "A");
    const teamB = await buildTeamUnits(pB.userId, "B");
    if (!teamA.length || !teamB.length) {
      send(pA.ws, { t: "error", msg: "team" }); send(pB.ws, { t: "error", msg: "team" }); return;
    }
    const capUid = (team, instId) => (team.find((u) => u.instanceId === instId) || {}).uid || null;
    E.applyCaptainStance(teamA, capUid(teamA, pA.captain), STANCES_OK.includes(pA.stance) ? pA.stance : "NEUTRAL");
    E.applyCaptainStance(teamB, capUid(teamB, pB.captain), STANCES_OK.includes(pB.stance) ? pB.stance : "NEUTRAL");
    const seed = Math.floor(Math.random() * 0x7fffffff) >>> 0;
    const id = "m" + (seq++);
    const pub = { A: teamA.map(publicUnit), B: teamB.map(publicUnit) };
    const match = {
      id, rng: E.mulberry32(seed), round: 0, over: false,
      players: { A: pA, B: pB }, teams: { A: teamA, B: teamB }, pub,
      pending: { A: null, B: null }, timer: null,
    };
    pA.ws.match = id; pA.ws.role = "A";
    pB.ws.match = id; pB.ws.role = "B";
    matches.set(id, match);
    send(pA.ws, { t: "match", matchId: id, you: "A", team: pub.A, opponent: pub.B, oppName: pB.name });
    send(pB.ws, { t: "match", matchId: id, you: "B", team: pub.B, opponent: pub.A, oppName: pA.name });
    startRound(match);
  }

  function startRound(match) {
    match.round++;
    match.pending = { A: null, B: null };
    const deadline = Date.now() + PLAN_MS;
    bcast(match, { t: "round", round: match.round, deadline });
    if (match.timer) clearTimeout(match.timer);
    match.timer = setTimeout(() => resolveRound(match), PLAN_MS + GRACE_MS);
  }

  function sanitize(decisions, role) {
    if (!Array.isArray(decisions)) return [];
    return decisions
      .filter((d) => d && typeof d.uid === "string" && d.uid[0] === role)
      .slice(0, 3)
      .map((d) => ({
        uid: d.uid,
        action: d.action === "guard" ? "guard" : d.action === "attack" ? "attack" : "ability",
        target: typeof d.target === "string" ? d.target : undefined,
        overcharge: !!d.overcharge,
      }));
  }
  const defaults = (team) => team.filter((u) => u.hp > 0).map((u) => ({ uid: u.uid, action: "attack" }));

  function onPlan(ws, m) {
    const match = ws.match && matches.get(ws.match);
    if (!match || match.over || m.round !== match.round) return;
    match.pending[ws.role] = sanitize(m.decisions, ws.role);
    if (match.pending.A && match.pending.B) resolveRound(match);
  }

  function resolveRound(match) {
    if (match.over) return;
    if (match.timer) { clearTimeout(match.timer); match.timer = null; }
    const round = match.round;
    const aDec = match.pending.A || defaults(match.teams.A);
    const bDec = match.pending.B || defaults(match.teams.B);
    match.pending = { A: null, B: null };
    const all = [...aDec, ...bDec].map((d) => ({ ...d, turn: round }));
    const dmap = new Map(all.map((d) => [round + ":" + d.uid, d]));
    const r = E.stepTurn(match.teams.A, match.teams.B, match.rng, dmap, round);
    const snap = (team) => team.map((u) => ({ uid: u.uid, hp: u.hp, shield: u.shield || 0, poisonTurns: u.poisonTurns || 0, stunTurns: u.stunTurns || 0, energy: u.energy || 0 }));
    bcast(match, { t: "resolve", round, log: r.log, hpA: teamHp(match.teams.A), hpB: teamHp(match.teams.B), state: { A: snap(match.teams.A), B: snap(match.teams.B) } });
    if (r.done) return endMatch(match);
    startRound(match);
  }

  async function endMatch(match, opts) {
    opts = opts || {};
    if (match.over) return; match.over = true;
    if (match.timer) { clearTimeout(match.timer); match.timer = null; }
    matches.delete(match.id);
    const aliveA = match.teams.A.some((u) => u.hp > 0), aliveB = match.teams.B.some((u) => u.hp > 0);
    const winner = opts.winner || (aliveA && (!aliveB || teamHp(match.teams.A) >= teamHp(match.teams.B)) ? "A" : "B");
    for (const role of ["A", "B"]) {
      const p = match.players[role];
      const foe = match.players[role === "A" ? "B" : "A"];
      try {
        const u = await syncEnergy(await getUser(p.userId));
        if (u) {
          const a = await awardBattleResult({ user: u, win: winner === role, abilitiesUsed: 0, defenderId: foe.userId, seed: 0 });
          send(p.ws, { t: "over", winner, youWon: winner === role, leaguePoints: a.leaguePoints, league: a.league, energy: a.energy, reason: opts.reason || "" });
        }
      } catch (e) {}
      if (p.ws) { p.ws.match = null; p.ws.role = null; }
    }
  }

  function handleClose(ws) {
    leaveQueue(ws);
    const match = ws.match && matches.get(ws.match);
    if (match && !match.over) {
      const otherRole = ws.role === "A" ? "B" : "A";
      send(match.players[otherRole].ws, { t: "opponentLeft" });
      endMatch(match, { winner: otherRole, reason: "opponent_left" });
    }
  }

  return wss;
}

module.exports = { attachPvp };
