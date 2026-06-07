// scripts/migrate.js — aplica db/schema.sql a la base de datos.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
  try {
    await db.query(sql);
    console.log("✅ Esquema aplicado correctamente.");
  } catch (e) {
    console.error("❌ Error aplicando el esquema:", e.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
})();
