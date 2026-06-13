// =============================================================================
// trades.js — TRUEQUE de duplicados (#2).
//
// Intercambio P2P de criaturas REPETIDAS (completar el álbum sin pagar). El que
// ofrece "reserva" una instancia DUPLICADA suya y pide otra plantilla a cambio;
// cualquiera que tenga un duplicado de la deseada puede aceptar. El intercambio
// es TRANSACCIONAL: el cambio de propietario de las dos instancias ocurre en una
// sola transacción (BEGIN/COMMIT con bloqueo de la oferta FOR UPDATE), así no hay
// duplicación ni pérdida ante carreras.
//
// Reglas anti-accidente / anti-abuso:
//   • Solo se ofrecen/entregan DUPLICADOS (tienes >=2 de esa plantilla): nunca
//     te quedas sin tu única copia.
//   • Nada bloqueado/favorito. No se comercia poder pagable (README §4): es
//     colección, no ventaja.
//   • Al cambiar de dueño, la instancia sale de cualquier equipo y se limpia
//     favorito/locked (coherencia).
// =============================================================================
const db = require("./db");

// ¿Tiene el usuario al menos `min` instancias de esa plantilla? (para exigir duplicado)
async function countOfTpl(client, userId, tplId) {
  const r = await (client || db).query(
    "SELECT COUNT(*)::int AS n FROM creature_instances WHERE user_id=$1 AND template_id=$2", [userId, tplId]);
  return r.rows[0].n;
}

// Crea una oferta: reserva una instancia DUPLICADA y pide otra plantilla.
async function createOffer(userId, offerInst, wantTpl) {
  if (!offerInst || !wantTpl) return { error: "bad_request" };
  const inst = await db.query(
    "SELECT instance_id, template_id, locked FROM creature_instances WHERE instance_id=$1 AND user_id=$2", [offerInst, userId]);
  if (!inst.rowCount) return { error: "not_found" };
  if (inst.rows[0].locked) return { error: "locked" }; // favorito: protegido
  if (inst.rows[0].template_id === wantTpl) return { error: "same_tpl" };
  if (await countOfTpl(null, userId, inst.rows[0].template_id) < 2) return { error: "not_duplicate" };
  // Límite de ofertas abiertas por usuario (anti-spam).
  const open = await db.query("SELECT COUNT(*)::int AS n FROM trade_offers WHERE from_user=$1 AND status='open'", [userId]);
  if (open.rows[0].n >= 5) return { error: "too_many" };
  try {
    const r = await db.query(
      `INSERT INTO trade_offers (from_user, offer_inst, offer_tpl, want_tpl)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, offerInst, inst.rows[0].template_id, wantTpl]);
    return { id: r.rows[0].id };
  } catch (e) {
    if (/idx_trades_offer_inst|unique/i.test(e.message)) return { error: "already_offered" };
    throw e;
  }
}

async function cancelOffer(userId, offerId) {
  const r = await db.query(
    "UPDATE trade_offers SET status='cancelled', closed_at=now() WHERE id=$1 AND from_user=$2 AND status='open' RETURNING id",
    [offerId, userId]);
  return r.rowCount ? { ok: true } : { error: "not_found_or_closed" };
}

// Mis ofertas abiertas (con detalle de la plantilla ofrecida y deseada).
async function myOffers(userId) {
  const r = await db.query(
    `SELECT o.id, o.offer_tpl, o.want_tpl, o.created_at,
            ot.name AS offer_name, ot.rarity AS offer_rarity, ot.art_seed AS offer_seed, ot.image_url AS offer_img, ot.type AS offer_type, ot.type2 AS offer_type2,
            wt.name AS want_name, wt.rarity AS want_rarity, wt.art_seed AS want_seed, wt.image_url AS want_img, wt.type AS want_type, wt.type2 AS want_type2
       FROM trade_offers o
       JOIN creature_templates ot ON ot.template_id=o.offer_tpl
       JOIN creature_templates wt ON wt.template_id=o.want_tpl
      WHERE o.from_user=$1 AND o.status='open' ORDER BY o.created_at DESC`, [userId]);
  return r.rows.map(rowToOffer);
}

// Mercado: ofertas abiertas de OTROS. Si onlyMine, solo las que YO puedo cumplir
// (tengo un duplicado de la plantilla deseada).
async function listOffers(userId, onlyFulfillable) {
  const r = await db.query(
    `SELECT o.id, o.from_user, u.display_name AS from_name, o.offer_tpl, o.want_tpl, o.created_at,
            ot.name AS offer_name, ot.rarity AS offer_rarity, ot.art_seed AS offer_seed, ot.image_url AS offer_img, ot.type AS offer_type, ot.type2 AS offer_type2,
            wt.name AS want_name, wt.rarity AS want_rarity, wt.art_seed AS want_seed, wt.image_url AS want_img, wt.type AS want_type, wt.type2 AS want_type2,
            (SELECT COUNT(*) FROM creature_instances ci
              WHERE ci.user_id=$1 AND ci.template_id=o.want_tpl AND ci.locked=false) AS my_have
       FROM trade_offers o
       JOIN users u ON u.id=o.from_user
       JOIN creature_templates ot ON ot.template_id=o.offer_tpl
       JOIN creature_templates wt ON wt.template_id=o.want_tpl
      WHERE o.status='open' AND o.from_user<>$1
      ORDER BY o.created_at DESC LIMIT 60`, [userId]);
  let rows = r.rows.map((x) => Object.assign(rowToOffer(x), {
    fromName: x.from_name, canFulfill: Number(x.my_have) >= 2,
  }));
  if (onlyFulfillable) rows = rows.filter((o) => o.canFulfill);
  return rows;
}

function rowToOffer(x) {
  return {
    id: x.id,
    offer: { tpl: x.offer_tpl, name: x.offer_name, rarity: x.offer_rarity, art_seed: x.offer_seed, image_url: x.offer_img, type: x.offer_type, type2: x.offer_type2 },
    want: { tpl: x.want_tpl, name: x.want_name, rarity: x.want_rarity, art_seed: x.want_seed, image_url: x.want_img, type: x.want_type, type2: x.want_type2 },
    createdAt: x.created_at,
  };
}

// Acepta una oferta entregando un duplicado de la plantilla deseada. SWAP atómico.
async function acceptOffer(userId, offerId, payInst) {
  if (!offerId || !payInst) return { error: "bad_request" };
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    // Bloquea la oferta para que dos aceptaciones no compitan.
    const o = await client.query("SELECT * FROM trade_offers WHERE id=$1 FOR UPDATE", [offerId]);
    if (!o.rowCount || o.rows[0].status !== "open") { await client.query("ROLLBACK"); return { error: "not_open" }; }
    const off = o.rows[0];
    if (off.from_user === userId) { await client.query("ROLLBACK"); return { error: "own_offer" }; }
    // La instancia ofrecida sigue siendo del oferente.
    const oi = await client.query(
      "SELECT instance_id, template_id FROM creature_instances WHERE instance_id=$1 AND user_id=$2 FOR UPDATE",
      [off.offer_inst, off.from_user]);
    if (!oi.rowCount) { await client.query("ROLLBACK"); return { error: "offer_gone" }; }
    // La instancia que entrego: mía, de la plantilla deseada, no bloqueada, duplicada.
    const pi = await client.query(
      "SELECT instance_id, template_id, locked FROM creature_instances WHERE instance_id=$1 AND user_id=$2 FOR UPDATE",
      [payInst, userId]);
    if (!pi.rowCount) { await client.query("ROLLBACK"); return { error: "pay_not_found" }; }
    if (pi.rows[0].template_id !== off.want_tpl) { await client.query("ROLLBACK"); return { error: "pay_wrong_tpl" }; }
    if (pi.rows[0].locked) { await client.query("ROLLBACK"); return { error: "pay_locked" }; }
    const dup = await client.query(
      "SELECT COUNT(*)::int AS n FROM creature_instances WHERE user_id=$1 AND template_id=$2", [userId, off.want_tpl]);
    if (dup.rows[0].n < 2) { await client.query("ROLLBACK"); return { error: "pay_not_duplicate" }; }

    // SWAP de propietarios (las dos a la vez) + limpieza de estado.
    await client.query("UPDATE creature_instances SET user_id=$1, favorite=false, locked=false WHERE instance_id=$2", [userId, off.offer_inst]);
    await client.query("UPDATE creature_instances SET user_id=$1, favorite=false, locked=false WHERE instance_id=$2", [off.from_user, payInst]);
    // Saca ambas instancias de cualquier equipo (coherencia de slots/snapshots).
    for (const iid of [off.offer_inst, payInst]) {
      await client.query("UPDATE teams SET slot1=NULL WHERE slot1=$1", [iid]);
      await client.query("UPDATE teams SET slot2=NULL WHERE slot2=$1", [iid]);
      await client.query("UPDATE teams SET slot3=NULL WHERE slot3=$1", [iid]);
    }
    await client.query(
      "UPDATE trade_offers SET status='done', to_user=$1, taken_inst=$2, closed_at=now() WHERE id=$3",
      [userId, payInst, offerId]);
    // Cancela cualquier OTRA oferta abierta que reservara alguna de las dos
    // instancias (ya cambiaron de dueño).
    await client.query("UPDATE trade_offers SET status='cancelled', closed_at=now() WHERE status='open' AND offer_inst = ANY($1::uuid[])", [[off.offer_inst, payInst]]);
    await client.query("COMMIT");
    return { ok: true, received: off.offer_tpl, gave: off.want_tpl };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { createOffer, cancelOffer, myOffers, listOffers, acceptOffer };
