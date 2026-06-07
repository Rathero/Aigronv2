// db.js — pool de PostgreSQL. Lee DATABASE_URL del entorno (.env).
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://aigrons:aigrons@localhost:5432/aigrons",
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
