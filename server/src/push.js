// =============================================================================
// push.js — Notificaciones Web Push (recordatorio del lote diario).
//
// - Dependencia OPCIONAL `web-push`: si no está instalada, todo queda inactivo
//   sin romper nada (initPush devuelve null y los endpoints responden 501).
// - Claves VAPID: de env (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) o se AUTOGENERAN
//   una vez y se persisten en app_meta (cero configuración para empezar).
// - Recordatorio diario (cron, PUSH_REMINDER_CRON, defecto 17:00): "tu aigrón
//   te espera" a quien tiene suscripción y NO ha reclamado hoy. Las
//   suscripciones caducadas (404/410) se podan automáticamente.
// =============================================================================
const C = require("./config");

let webpush = null;
try { webpush = require("web-push"); } catch (e) { /* opcional */ }

let _keys = null;

async function initPush(db) {
  if (!webpush) { console.log("[push] web-push no instalado; notificaciones desactivadas"); return null; }
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    _keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const r = await db.query("SELECT value FROM app_meta WHERE key='vapid_keys'");
    if (r.rowCount) _keys = JSON.parse(r.rows[0].value);
    else {
      _keys = webpush.generateVAPIDKeys();
      await db.query(
        "INSERT INTO app_meta (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify(_keys)]
      );
      console.log("[push] claves VAPID generadas y persistidas en app_meta");
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@aigrons.app", _keys.publicKey, _keys.privateKey);
  return _keys;
}

const publicKey = () => (_keys ? _keys.publicKey : null);
const enabled = () => !!(webpush && _keys);

// Envía a un usuario (todas sus suscripciones); poda las caducadas.
async function sendTo(db, userId, payload) {
  if (!enabled()) return 0;
  const subs = await db.query("SELECT endpoint, sub FROM push_subs WHERE user_id=$1", [userId]);
  let sent = 0;
  for (const row of subs.rows) {
    try { await webpush.sendNotification(row.sub, JSON.stringify(payload)); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query("DELETE FROM push_subs WHERE user_id=$1 AND endpoint=$2", [userId, row.endpoint]).catch(() => {});
      }
    }
  }
  return sent;
}

// Recordatorio diario: a quien tiene push y aún no reclamó el lote de hoy.
async function sendDailyReminders(db) {
  if (!enabled()) return 0;
  const r = await db.query(
    `SELECT DISTINCT u.id FROM users u JOIN push_subs p ON p.user_id = u.id
      WHERE u.last_claim_date IS NULL OR u.last_claim_date <> $1`,
    [C.todayStr()]
  );
  let total = 0;
  for (const row of r.rows) {
    total += await sendTo(db, row.id, {
      title: "🥚 Tu aigrón de hoy te espera",
      body: "Ha nacido un lote nuevo. Reclama tu criatura gratis antes de medianoche.",
      tag: "daily-claim",
    });
  }
  if (total) console.log(`[push] recordatorio diario enviado a ${total} suscripciones`);
  return total;
}

function startPushCron(db) {
  if (!enabled() || process.env.DISABLE_CRON === "true") return null;
  let cron;
  try { cron = require("node-cron"); } catch (e) { return null; }
  const expr = process.env.PUSH_REMINDER_CRON || "0 17 * * *";
  if (!cron.validate(expr)) return null;
  const tz = process.env.CRON_TZ || "UTC";
  const task = cron.schedule(expr, () => sendDailyReminders(db).catch((e) => console.error("[push]", e.message)), { timezone: tz });
  console.log(`[push] recordatorio diario activo: "${expr}" (${tz})`);
  return task;
}

module.exports = { initPush, publicKey, enabled, sendTo, sendDailyReminders, startPushCron };
