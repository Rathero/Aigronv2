// db.js — pool de PostgreSQL. Lee DATABASE_URL del entorno.
const { Pool } = require("pg");

const url = process.env.DATABASE_URL || "postgres://aigrons:aigrons@localhost:5432/aigrons";

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL no está definida en producción. Configúrala (en Railway: ${{Postgres.DATABASE_URL}}).");
}

// SSL: las BD gestionadas (Railway público, Render, etc.) suelen exigirlo. Se
// activa con PGSSL=true o si la URL trae sslmode=require. En red interna de
// Railway (.railway.internal) NO hace falta.
const useSSL = process.env.PGSSL === "true" || /sslmode=require/i.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (e) => console.error("[db] error del pool:", e.message));

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
