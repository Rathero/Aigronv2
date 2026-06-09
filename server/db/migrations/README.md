# Migraciones numeradas

Convención: `NNN_descripcion.sql` (p. ej. `001_backfill_avg_level.sql`).

- Se aplican **una sola vez**, en orden alfabético, cada una dentro de su
  transacción. El registro vive en la tabla `schema_migrations`.
- `npm run migrate` aplica primero `db/schema.sql` (idempotente) y después
  las migraciones pendientes de esta carpeta.
- Úsalas para cambios que NO se pueden expresar de forma idempotente en
  `schema.sql` (backfills costosos, transformaciones de datos, renombrados).
  Para columnas/tablas/índices nuevos sigue bastando `schema.sql` con
  `IF NOT EXISTS`.
