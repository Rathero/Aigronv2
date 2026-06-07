# Desplegar AIGRONS en producción

El juego es **una sola imagen Docker** que sirve la API **y** el frontend. Migra el
esquema al arrancar y trae cron de generación nocturna. Recomendado para empezar: un
PaaS (Railway / Render / Fly.io) con PostgreSQL gestionado.

---

## Opción A — Railway (la más rápida)

### 1. Sube el repo a GitHub
```bash
git add -A && git commit -m "deploy" && git push
```

### 2. Crea el proyecto en Railway
- railway.app → **New Project → Deploy from GitHub repo** → elige el repo.
- Railway detecta el `Dockerfile` de la raíz y construye la imagen (contexto = raíz).

### 3. Añade PostgreSQL
- En el proyecto: **New → Database → PostgreSQL**. Railway crea la variable `DATABASE_URL`.

### 4. Variables de entorno (servicio de la app)
| Variable | Valor |
|----------|-------|
| `DATABASE_URL` | referencia a la del plugin Postgres (`${{Postgres.DATABASE_URL}}`) |
| `JWT_SECRET` | **secreto fuerte** (`openssl rand -hex 32`) — OBLIGATORIO |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | tu dominio (o `*` al principio) |
| `ALLOW_DEV_AUTH` | `true` (login por dispositivo; ver Avisos) |
| `GEMINI_API_KEY` | tu key **nueva** de aistudio.google.com/apikey |
| `DAILY_BATCH_SIZE` | `40` (pequeño para la cuota gratis de Gemini) |
| `GEN_DELAY_MS` | `3000` (espacia las llamadas a Gemini) |
| `AI_VISION_FILTER` | `off` |
| `CRON_TZ` | tu zona, p. ej. `Europe/Madrid` |

> `PORT` lo inyecta Railway automáticamente; la app lo lee. No lo fijes a mano.

### 5. Persiste el arte generado
- Servicio de la app → **Volumes** → monta un volumen en **`/app/web/art`**.
  Así el arte IA (lote diario + fusiones) sobrevive a los redeploys.

### 6. Genera el primer lote (truco para que el arranque no se atasque)
Con Gemini, generar 40 imágenes tarda minutos. Para no bloquear el primer `/daily`:
- **Despliega primero con `AI_IMAGE_PROVIDER=procedural`** (lote instantáneo con sprites).
- Cuando esté en vivo, cambia a Gemini quitando esa variable (el default ya es gemini) y:
  - el **cron** pintará el lote de mañana con IA automáticamente, y/o
  - repinta el de hoy con `node scripts/backfill-art.js` (ver §Comandos).

### 7. Dominio
- Railway da un subdominio con HTTPS. Para uno propio: **Settings → Domains → Custom Domain**.
- Pon `CORS_ORIGIN` con ese dominio.

¡Listo! Comparte la URL. La gente entra, reclama su aigrón diario y juega.

---

## Opción B — VPS propio (Docker Compose)

En un servidor con Docker:
```bash
git clone <repo> && cd <repo>
JWT_SECRET=$(openssl rand -hex 32) \
GEMINI_API_KEY=tu_key \
DAILY_BATCH_SIZE=40 GEN_DELAY_MS=3000 \
CORS_ORIGIN=https://tudominio.com \
docker compose -f docker-compose.prod.yml up -d --build
```
Esto levanta app + Postgres (con volúmenes persistentes para datos y arte). Pon delante
un **reverse proxy con TLS** (Caddy es de 2 líneas):
```
tudominio.com {
  reverse_proxy localhost:3000
}
```

---

## Comandos útiles (en el contenedor / servidor)
```bash
node scripts/generate-today.js 2025-01-31 40   # generar el lote de una fecha
node scripts/backfill-art.js                    # pintar con IA el lote de hoy (sin regenerar)
node scripts/repaint-fusions.js                 # repintar fusiones sin arte
node scripts/smoke.js https://tudominio.com     # prueba de humo contra producción
```

---

## ⚠️ Avisos importantes para producción

- **Login por dispositivo (dev):** frictionless pero **sin recuperación de cuenta ni
  multi-dispositivo** y menos seguro. Vale para soft-launch. Para público amplio, integra
  **Apple/Google** (el seam ya está en `auth.js`: pon `ALLOW_DEV_AUTH=false` y
  `AUTH_GOOGLE_CLIENT_ID`/`AUTH_APPLE_CLIENT_ID`, y manda el `idToken` desde el cliente).
- **Cuota de Gemini (capa gratuita):** límites por minuto/día. Mantén `DAILY_BATCH_SIZE`
  bajo y `GEN_DELAY_MS` alto. A escala, activa facturación en Google o reduce el lote.
- **Arte e instancias múltiples:** el arte se guarda en disco local (`/app/web/art`). Con
  **una** instancia + volumen va bien. Para escalar horizontalmente, mueve el arte a
  **S3/R2 + CDN** (el seam de `ai/imageProvider.js` lo permite).
- **Backups:** activa copias de seguridad del PostgreSQL.
- **Rota tu `GEMINI_API_KEY`** (la anterior quedó expuesta).
- **`JWT_SECRET` fuerte y secreto.** Si cambia, se invalidan las sesiones.
