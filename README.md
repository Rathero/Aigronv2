# AIGRONS — Guía del proyecto (handoff para continuar el desarrollo)

> **Si eres una IA/agente que retoma este proyecto: empieza leyendo este README entero
> y `docs/criaturas-imposibles.md`.** Aquí está el contexto, el estado actual, las
> reglas que NO debes romper y un backlog priorizado con criterios de aceptación.

---


## 0. Qué es AIGRONS (contexto de producto)

Juego móvil **casual-coleccionista** de sesiones muy cortas (1-3 min). Cada día una IA
genera un **lote nuevo** de criaturas únicas llamadas **aigrons** (arte pixel + stats +
lore). El jugador:

1. Reclama un aigrón **gratis al día** (rareza aleatoria del lote de hoy).
2. Juega **mini-combates 3v3** automáticos (con una micro-decisión por turno) para ganar más.
3. Los **colecciona**, sube de nivel, fusiona (v2) y libera duplicados.
4. Compite en **ranking diario** (todos comparten el mismo lote → justo) y en **ligas**.

**Tres decisiones de producto que sostienen todo (no las cambies sin motivo):**

- **Contenido por lotes, no bajo demanda.** Un job nocturno crea el catálogo del día →
  coste predecible y bajo, latencia cero, y lote compartido por todos (ranking justo).
- **Combate auto-batalla con 1 decisión por turno.** Jugable con una mano, PvP asíncrono
  contra un *snapshot*, pero con skill suficiente para escalar ligas.
- **Monetización no tóxica.** Pase + cosméticos + tiradas extra con techo diario. El dinero
  acelera la colección, **nunca** compra victorias.

Idioma del juego y del código/comentarios: **español**.

---

## 1. Estado actual (qué funciona HOY)

✅ **Frontend jugable** (`web/index.html`): vanilla JS + canvas, sin build, estética
pixel-art neón. Bucle completo en estado local: tirada diaria con animación de nacimiento,
colección con filtros/detalle/subir nivel/liberar, combate 3v3 animado con habilidades,
ranking (con jugadores ficticios), tienda. Persiste en el navegador.

✅ **Aigrons en pixel art procedurales**: se dibujan en canvas de forma **determinista
desde `art_seed`** (sprite 16×16 espejado, paleta por tipo, adornos por rareza). No requiere
ninguna API de imagen para funcionar.

✅ **Backend** (`server/`): Express + PostgreSQL + JWT. Endpoints del MVP implementados
(auth, daily, colección, equipo, combate, rankings, tienda). Job de generación del lote.

✅ **Motor de combate determinista** (`server/src/combat.js`): dado `(equipos, seed,
decisiones)` el resultado es reproducible. Usado para validar en servidor (anti-trampa).

✅ **Verificado en esta sesión:**
- Cliente y servidor generan **el mismo aigrón** para un mismo id (mismo algoritmo). Ej.:
  `2026-06-06_0000` → `Korlitalo / RELOJ / COMUN / hp609 / atk105 / ROBO_DE_TIEMPO` en ambos.
- Combate determinista: mismo input → mismo resultado y mismo nº de turnos.
- 200 combates simulados sin cuelgues; el combate siempre termina (límite 60 turnos).
- Sintaxis OK en todos los archivos.

✅ **Frontend cableado al backend** (P0 hecho): `web/index.html` hace login al arrancar,
guarda el token y consume la API para daily/colección/equipo/combate/rankings/tienda. La
colección persiste tras recargar (estado en servidor). Verificado en navegador.

✅ **Combate del cliente seeded** (P0 hecho): el cliente usa el **motor compartido**
`web/engine.js` con `mulberry32(seed)` (el mismo que el servidor) y registra las decisiones;
el servidor recalcula y concede recompensas. Animación 1:1 con la validación (self-check
incluido). Sin `Math.random` en el combate.

✅ **PvP asíncrono real**: `/battle/find` empareja contra el `snapshot` de otro jugador de
liga similar (o bot si no hay) y "congela" la oferta para recalcular seguro en `/resolve`.

✅ **Misiones diarias server-side**, **fusión** (`/fusion`, con caché por par), **auth con
verificación de Apple/Google** (seam), y **seam del pipeline de imagen IA** (procedural por
defecto, adaptador OpenAI opcional).

✅ **Tests** (`npm test`): determinismo y terminación del combate, paridad cliente/servidor,
rangos de generación, escalado, ligas. **Endurecido para producción**: helmet, rate limiting,
`/health`, apagado ordenado, cron nocturno en proceso. **Dockerizado** (`Dockerfile` +
`docker-compose.prod.yml`); arranque verificado de extremo a extremo.

⚠️ **Lo que queda como opcional / post-MVP** (no bloquea el despliegue):
- **Arte IA real**: requiere claves (`OPENAI_API_KEY`); por defecto se usa el sprite
  procedural (sin coste). El seam ya está listo (`server/src/ai/`).
- **Validación de recibos de tienda** para compras reales (`/shop/purchase` es un stub
  controlado por `ALLOW_STUB_PURCHASES`).
- **Ligas completas** (reset semanal/ascensos), **salón de la fama**, **cosméticos/pase**.

---

## 2. Estructura del repo

```
aigrons/
├── README.md                       # este documento
├── Dockerfile                      # imagen de producción (API + frontend)
├── docker-compose.prod.yml         # stack de producción (API + PostgreSQL)
├── eslint.config.js                # lint de todo el repo (cd server && npm run lint)
├── .github/workflows/ci.yml        # CI: lint + tests en cada push/PR
├── docs/
│   └── criaturas-imposibles.md     # DISEÑO COMPLETO: fórmulas, prompts IA, esquema, costes, roadmap
├── web/
│   ├── engine.js                   # MOTOR COMPARTIDO (constantes+generación+combate) ⭐ fuente única
│   ├── index.html                  # frontend ONLINE (estructura; el JS/CSS van aparte)
│   ├── app.js                      # toda la lógica del cliente (vanilla JS + canvas)
│   ├── styles.css                  # estilos (pixel-art neón)
│   └── sw.js · manifest.webmanifest · icon.svg   # PWA
└── server/
    ├── db/schema.sql               # esquema PostgreSQL (idempotente)
    ├── db/migrations/              # migraciones numeradas one-shot (ver su README)
    ├── src/
    │   ├── config.js · combat.js · generator.js   # re-exportan web/engine.js (cero duplicación)
    │   ├── db.js                   # pool de PostgreSQL
    │   ├── auth.js                 # JWT + verificación Apple/Google (seam)
    │   ├── cron.js                 # generación nocturna en proceso (node-cron)
    │   ├── fusion.js               # lógica de fusión (transaccional + caché)
    │   ├── ai/imageProvider.js     # seam del pipeline de imagen IA (procedural | openai)
    │   ├── app.js                  # servidor Express + TODOS los endpoints (endurecido)
    │   └── jobs/generateDailyBatch.js   # genera+inserta el lote de un día (usa el seam IA)
    ├── test/engine.test.js         # tests (npm test): determinismo, paridad, rangos, ligas
    ├── scripts/
    │   ├── migrate.js              # aplica db/schema.sql + db/migrations/ pendientes
    │   ├── generate-today.js       # CLI para generar el lote de hoy/una fecha
    │   └── smoke.js                # prueba de humo de integración del bucle completo
    ├── docker-compose.yml          # PostgreSQL + Redis local (desarrollo)
    ├── package.json
    └── .env.example
```

---

## 3. Reglas / invariantes que NO debes romper

Estas son las que hacen que el juego sea coherente. Si tocas algo, mantén estas verdades:

1. **La lógica de generación/combate de cliente y servidor es la misma por construcción:**
   ambos usan `web/engine.js` (el servidor lo re-exporta desde `config.js`/`combat.js`/
   `generator.js`). El mismo `template_id` (`"<fecha>_NNNN"`) produce el mismo aigron en
   cliente y servidor (tipo, rareza, stats, habilidad, nombre, lore, `art_seed`). El orden de
   las llamadas a `rng()` importa: rareza → tipo → tags(2) → habilidad → nombre(3) →
   hp/atk/def/spd(4) → lore(1). Si tocas `engine.js`, vuelve a correr `npm test` (incluye un
   test de paridad cliente/servidor).
2. **El combate es determinista.** No metas `Math.random` sin semilla en `combat.js`. Toda
   aleatoriedad sale de `mulberry32(seed)`. El servidor es la autoridad: recalcula y paga.
   El cliente nunca declara el resultado.
3. **Stats siempre dentro de rango.** Cuando conectes el LLM para stats, valida con *clamp*
   a `RANGES[rarity]` en código antes de guardar. Nunca confíes ciegamente en el LLM.
4. **Monetización no tóxica.** Nada de loot boxes sin techo ni ventajas de combate solo
   pagables. Respeta el techo de 10 tiradas pagas/día.
5. **Seguridad de contenido en la generación IA.** El filtro de visión (§5.4 del doc) es
   obligatorio: descarta arte roto/inseguro. Aplica especial cuidado con contenido que
   pudiera ser inapropiado; el juego es para público general.
6. **Sprites desde `art_seed`/`template_id`.** El cliente ya sabe dibujar cualquier aigron
   a partir de su id/seed. La API devuelve esos campos en cada plantilla; no los quites.
7. **Idioma español** en UI, nombres y textos de cara al usuario.

---

## 4. Arrancar en local

**Requisitos:** Node.js 18+ y Docker (para Postgres).

### Solo frontend (30 s)
Abre `web/index.html` en el navegador (vale en móvil). Estado local, sin backend.

### Backend completo
```bash
cd server
cp .env.example .env            # ajusta JWT_SECRET; baja DAILY_BATCH_SIZE si quieres
docker compose up -d            # PostgreSQL (+ Redis) en local
npm install
npm run migrate                 # crea las tablas (db/schema.sql)
npm run generate                # genera el lote de aigrons de HOY en la BD
npm run dev                     # API en http://localhost:3000 (sirve también el frontend en /)
```

### Smoke test (crear usuario, reclamar, ver colección)
```bash
curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"subject":"ruben-dev","displayName":"Ruben"}'      # -> {token, user}, regala 3 starters

TOKEN=...   # pega el token de la respuesta
curl -s localhost:3000/me                  -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/daily               -H "authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/daily/claim -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/collection          -H "authorization: Bearer $TOKEN"
```

### Tests y lint
```bash
cd server && npm test          # determinismo de combate, paridad cliente/servidor, rangos, ligas
cd server && npm run lint      # ESLint de server/ y web/ (mismo chequeo que la CI)
```

### Despliegue en producción (Docker)
Un solo comando levanta API + PostgreSQL (la API migra el esquema al arrancar y sirve el
frontend en `/`). El contexto de build es la raíz del repo (necesita `server/` y `web/`):
```bash
# define al menos JWT_SECRET; ALLOW_DEV_AUTH=false exige tokens reales de Apple/Google
JWT_SECRET=$(openssl rand -hex 32) ALLOW_DEV_AUTH=false \
  docker compose -f docker-compose.prod.yml up -d --build
curl localhost:3000/health      # {"ok":true,...}
```
Variables clave (ver `server/.env.example`): `JWT_SECRET`, `CORS_ORIGIN`, `ALLOW_DEV_AUTH`,
`DAILY_BATCH_SIZE`, `CRON_GENERATE`/`CRON_TZ`, `AI_IMAGE_PROVIDER` (+`OPENAI_API_KEY`),
`AUTH_GOOGLE_CLIENT_ID`/`AUTH_APPLE_CLIENT_ID`, `ALLOW_STUB_PURCHASES`.
El cron en proceso genera el lote de **mañana** (desactívalo con `DISABLE_CRON=true` si usas
el cron del SO con `scripts/generate-today.js`).

---

## 5. API (resumen)

Todas requieren `Authorization: Bearer <token>` salvo `/auth/login`.

| Método | Ruta | Qué hace |
|--------|------|----------|
| POST | `/auth/login` | Upsert de usuario → `{token, user}` (regala 3 starters al nuevo) |
| GET  | `/me` | Estado del usuario (energía sincronizada) |
| GET  | `/daily` | Lote de hoy + flag `claimed` |
| POST | `/daily/claim` | Reclama el aigrón diario gratis (+racha, +30🪙) |
| GET  | `/collection` | Tus aigrons (stats base y escalados por nivel) |
| POST | `/creature/:id/level-up` | Sube nivel (gasta polvo+monedas; máx 20) |
| POST | `/creature/:id/release` | Libera duplicado → polvo (bloquea si locked/en equipo) |
| POST | `/creature/:id/evo-path` | Elige el **sendero** de la forma evolucionada (OFENSIVO/DEFENSIVO/VELOZ) |
| POST | `/creature/:id/favorite` | Toggle favorito (protege de liberar) |
| GET/PUT | `/team` | Lee / guarda el equipo de 3 (genera `snapshot`) |
| POST | `/battle/find` | Empareja rival (snapshot PvP o bot); body opcional `{captain, stance}` (capitán+estancia, horneados); congela la oferta → `{battleId, seed, opponent, team, pvp}` |
| POST | `/battle/resolve` | Recalcula combate con `{battleId, decisions}` y paga recompensas (gasta 1⚡, oferta de un solo uso) |
| GET  | `/rankings/daily` | Top del día por victorias → `{rows, me}` (tu posición aunque no estés en el top) |
| GET  | `/rankings/league` | Top global por puntos de liga → `{rows, me}` |
| POST | `/shop/roll` | Tirada extra (100🪙, techo 10/día) |
| POST | `/shop/purchase` | Gemas/pase: recibo real (stub con `ALLOW_STUB_PURCHASES`). `energy_refill` se paga con 20💎 (virtual, sin recibo) |
| GET  | `/missions` · POST `/missions/claim` | Misiones diarias server-side y reclamo de recompensa |
| POST | `/fusion` | Fusiona 2 instancias → criatura nueva (caché por par, doc §3.7) |
| POST | `/dungeon/start` · GET `/dungeon` | Mazmorra del día (roguelike): inicia/reanuda y consulta la run |
| POST | `/dungeon/choose` · `/dungeon/battle` · `/dungeon/draft` · `/dungeon/shop` | Avanzar nodo, resolver combate, draftear reliquia, tienda |
| POST | `/dungeon/abandon` | Huir de la run activa = permadeath (cuenta como muerte, registra score) |
| GET  | `/dungeon/ranking` | Ranking diario por profundidad alcanzada |
| GET  | `/profile` · POST `/me/name` | Perfil (stats, semanas de liga, combates recientes) y cambio de nombre |
| GET  | `/recap` | Resumen mensual estilo "Wrapped": descubrimientos del mes, joya del mes, distribución por tipo/rareza y totales (para tarjetas compartibles) |
| GET  | `/battle/:id/replay` | Replay grabado de un combate propio (equipos+log+estado final) |
| GET  | `/hall-of-fame` | Top de la última semana cerrada de ligas |
| GET  | `/achievements` · POST `/achievements/claim` | Logros (progreso desde contadores) y reclamo |
| GET  | `/frames` · PUT `/creature/:id/frame` | Marcos cosméticos desbloqueables (liga/victorias) |
| GET  | `/push/key` · POST `/push/subscribe` · `/push/unsubscribe` | Web Push (recordatorio diario del lote) |
| GET  | `/features` | Flags de las 7 mecánicas (el cliente oculta lo apagado) |
| GET  | `/puzzle` · POST `/puzzle/solve` | Puzzle Diario (combate fijo igual para todos; ranking por mín. turnos) |
| GET  | `/worldboss` · POST `/worldboss/hit` | Jefe Mundial (HP global compartido; golpe cuesta ⚡1) |
| GET  | `/nemesis` · POST `/nemesis/fight` | Némesis (rival IA con counter-pick; sube de tier al perder contra ti) |
| GET  | `/oracle` | Profecía determinista del lote de MAÑANA |
| GET  | `/arena/draft` | 6 candidatos del lote para Arena Sellada (draft en /pvp) |
| GET  | `/guild` · `/guild/list` | Mi constelación (info+miembros+rango) · ranking de constelaciones |
| POST | `/guild/create` · `/guild/join` · `/guild/leave` | Fundar (cuesta monedas) · unirse · salir (cede liderazgo o disuelve) |
| GET  | `/guild/weekly` · POST `/guild/weekly/claim` | Misión semanal de constelación (suma victorias PvP de los miembros) y reclamo |
| GET  | `/guild/wall` · POST `/guild/wall` | Muro/chat de la constelación (últimos 30; rate-limited) |
| GET  | `/trades` | Mercado de trueque (ofertas de otros) + mis ofertas |
| POST | `/trades/create` · `/trades/cancel` · `/trades/accept` | Crear oferta de duplicado · cancelar · aceptar (swap atómico) |
| GET  | `/health` | Healthcheck (usado por Docker / balanceadores) |

**Mecánicas innovadoras** (todas detrás de flags `FEATURE_*`, on por defecto; ver
`.env.example`). Deterministas en el motor (`web/engine.js`: `dailyPuzzle`,
`nemesisTeam/Name`, `oracleProphecy`, `isPrismatic/prismaticShift`) para que cliente y
servidor coincidan sin comunicarse; el servidor revalida los combates.
- **Puzzle Diario**: equipo y enemigos fijos del lote, gana en mínimo de turnos; ranking + compartir estilo Wordle.
- **Ecos en la Mazmorra**: tu equipo caído (≥nodo 2) se guarda como `dungeon_echoes` y aparece (~35%) como encuentro en runs de otros; vengarlo da botín.
- **Jefe Mundial**: `world_boss` con HP global; toda la comunidad pega; top contribuidores.
- **Némesis**: `nemesis` por usuario, counter-pick de tipos, sube de tier (más fuerte) cada vez que la derrotas.
- **Prismáticas**: 1% determinista por instancia, paleta rotada (cosmético, cero ventaja).
- **El Oráculo**: profecía críptica pero verídica del lote de mañana (tipo dominante).
- **Arena Sellada**: draft de 3 de 6 del lote en el PvP en vivo (modo `arena`), sin tu colección.

**PvP en vivo (WebSocket /pvp)**: `queue` admite `code` (duelo privado: solo empareja
con el mismo código, sin ventana de nivel ni bot); `resume` reanuda tras un corte.
Las misiones semanales se reclaman en `/missions/claim` con claves `w_*`.
El lote tiene **eventos** (sábado temático ~40% de un tipo; domingo 2 legendarias);
`/daily` devuelve `event` y la generación se compone por cupos (curva exacta).

**Mazmorra del día (roguelike, semilla compartida):** run de 8 nodos de dificultad creciente
con el equipo del jugador. El **HP se arrastra** entre combates, **permadeath**, y entre nodos
se **draftea** 1 de 3 **reliquias** (modificadores que crean builds: crítico, robo de vida,
espinas, +HP/ATK/DEF, sobrecarga barata, curación, oro…). Nodos: combate, élite, jefe, descanso,
tienda. Enemigos escalan en **rareza y nivel** por profundidad. El servidor es autoritativo
(estado en `dungeon_runs`, recalcula cada combate). Ranking diario "¿hasta dónde llegaste?".

**Formato de `decisions`** (en `/battle/resolve`):
`[{ "turn": 2, "uid": "A0", "action": "ability", "target": "B1", "overcharge": true }, ...]`
- `action`: `"ability"` (defecto) o `"guard"` (la unidad se pone en guardia ese turno).
- `target`: uid del enemigo a apuntar (opcional; un enemigo en guardia intercepta).
- `overcharge`: gasta `coste+2` energía para un efecto ×1.5.
- Compatibilidad: una decisión vieja `{turn, uid}` = lanzar habilidad a objetivo automático.

**Capa estratégica del combate** (todo determinista y revalidado por el servidor):
1. **Capitán + estancia** (decisión previa): el capitán da +15% a sus stats y liderazgo
   (+6% al equipo); la estancia inclina a Agresiva/Neutral/Defensiva (la defensiva arranca
   con +1⚡). Se hornean en los stats al congelar la oferta (`applyCaptainStance`).
2. **Objetivo elegible**: eliges a qué enemigo apuntas (focalizar, explotar tipo).
3. **Guardia**: una unidad protege a sus aliados un turno (intercepta golpes de objetivo
   único, −40% daño). La IA también la usa.
4. **Sobrecarga**: con energía de sobra, una habilidad pega/cura ×1.5.

---

## 6. Modelos mentales clave

- **Plantilla vs instancia.** `creature_templates` = catálogo inmutable del día (compartido).
  `creature_instances` = lo que posee un usuario (nivel, favorito, etc.) referenciando una plantilla.
- **Energía.** Máx 5, +1 cada 30 min. Combate cuesta 1. Se sincroniza en servidor (`/me`,
  `/battle/resolve`) a partir de `energy_updated_at`.
- **Ligas.** Puntos → BRONCE<100, PLATA<250, ORO<450, PLATINO<700, DIAMANTE≥700.
- **Rareza.** Curva objetivo 60/25/12/3. ⚠️ Nota: como la rareza se decide por hash
  independiente por id, la distribución real no es exactamente la curva (en pruebas las
  legendarias salen ~algo por encima del 3% y las épicas algo por debajo del 12%). Es un
  tradeoff a cambio de determinismo. Si necesitas la curva exacta, genera el lote por
  cupos (plan de §5.1 del doc) en vez de tiradas independientes por id.

---

## 7. NEXT STEPS — backlog priorizado (con criterios de aceptación)

Orden recomendado. Cada tarea incluye qué tocar y cómo saber que está hecha.

### ✅ P0 (HECHO) — Conectar el frontend al backend
**Objetivo:** que el juego use la API en vez del estado local.
- Añade en `web/index.html` una capa `api()` (fetch con `Authorization`), login al arrancar
  (guardando el token), y sustituye:
  - `doClaim()` → `POST /daily/claim`
  - carga de colección → `GET /collection`
  - `saveTeam()` → `PUT /team`; lectura → `GET /team`
  - `startBattle()` → `POST /battle/find` (usa el `seed` devuelto)
  - `endBattle()` → `POST /battle/resolve` con `{seed, decisions}`
  - `shopRoll()` → `POST /shop/roll`; tienda monedas/gemas → endpoints correspondientes
  - `renderRanking()` → `GET /rankings/daily` y `/rankings/league`
- El render del sprite NO cambia (sigue usando `template_id`/`art_seed`).
- **Hecho cuando:** puedes jugar el bucle completo con datos del servidor en dos navegadores
  distintos (dos usuarios) y la colección persiste tras recargar.

### ✅ P0 (HECHO) — Portar el combate del cliente al motor seeded
**Objetivo:** que la animación del cliente coincida 1:1 con la validación del servidor.
**Cómo quedó:** cliente y servidor comparten `web/engine.js` (mismo `resolveBattle`); el
cliente registra `decisions` y las manda en `/battle/resolve`. Self-check en el cliente y
test de paridad en `npm test`.
- Reemplaza la aleatoriedad del combate del cliente por `mulberry32(seed)` con el `seed`
  de `/battle/find`, replicando la lógica de `server/src/combat.js` (misma fórmula de daño,
  crítico, habilidades, orden por velocidad, IA del rival con `aiUse`).
- Recoge las decisiones del jugador (qué turno lanza cada habilidad) y mándalas a
  `/battle/resolve`.
- **Hecho cuando:** para un mismo `seed` + decisiones, el ganador y los HP finales que ve
  el cliente coinciden con lo que devuelve el servidor.

### P1 — Pipeline de imagen IA (sustituir el sprite procedural)
**Objetivo:** arte generado por IA por lotes, manteniendo coste bajo y estilo unificado.
- Implementa en `server/src/jobs/generateDailyBatch.js` el flujo de §5 del doc: concepto
  (LLM) → prompt de imagen → imagen → filtro de calidad/seguridad (visión) → stats (LLM,
  con clamp) → subir a CDN → guardar `image_url`/`image_thumb_url`/`quality_score`.
- Abstrae la llamada de imagen tras una interfaz para poder cambiar de proveedor.
- Genera de noche para `batch_date = mañana` (cron, ver §8).
- **Hecho cuando:** un lote nocturno produce N aigrons con imágenes válidas (>60-70% pasan
  el filtro), coste medido por lote, y el cliente puede mostrar `image_url` cuando exista
  (con fallback al sprite procedural si es null).

### ✅ P1 (HECHO) — PvP asíncrono contra jugadores reales
- `/battle/find` elige el `teams.snapshot` de otro usuario de liga similar (`ORDER BY
  abs(league_points-...)`); si no hay, usa bot. Congela la oferta (`battle_offers`) para
  recalcular seguro y de un solo uso en `/battle/resolve`.

### ✅ P2 (HECHO) — Fusión
- `POST /fusion` con las reglas de §3.7 (consume 2 instancias + monedas, rareza
  probabilística, herencia de tipo/habilidad/stats), transaccional y **cacheada por par
  ordenado** de `template_id` (`fusion_cache`).

### Retención y meta (parcial)
- ✅ Misiones diarias y racha **server-side** (`daily_missions`, `/missions`).
- ✅ **Cierre semanal de ligas** (`src/leagues.js`): cada lunes reparte recompensa por
  liga, guarda histórico (`league_weeks`) y comprime puntos hacia el suelo de la liga
  (soft-reset). Idempotente y multi-instancia (advisory lock + `app_meta`). El ranking
  muestra cuenta atrás y recompensa.
- ✅ **PvP siempre jugable**: sin rival humano en ~8s entra un **bot** (IA del motor,
  sin recompensas para el bot); cortes de red tienen **30s de gracia de reconexión**
  (`resume` por WebSocket) en vez de derrota instantánea.
- ✅ Sonido chiptune sintetizado + háptica (toggle en el menú ≡), compartir el aigrón
  del día (Web Share), progreso del lote diario ("X/30 de hoy").
- ✅ **Música adaptativa** (`MUSIC` en `app.js`): banda sonora chiptune procedural
  (bajo+arpegio sobre progresión menor pentatónica, sin assets) que se **intensifica
  en combate** (escena `menu`↔`battle`). Arranca en el primer gesto (autoplay) y tiene
  toggle propio en ≡ ("🎵 Música").
- ✅ **Juiciness de combate** (game feel): screen-shake del escenario, flash + empuje
  del sprite golpeado, **flash dorado en crítico**, chispas de impacto (vía `POC` con
  fallback DOM), números de crítico con punch y **muerte con disolución**. Es puro
  render (`impactFx`/`sparks`/`shake` en `app.js` + `styles.css`); no toca el motor
  determinista y respeta `prefers-reduced-motion`. Cableado en los 4 caminos de
  animación (replay, PvP en vivo, PvE local y mazmorra).
- ✅ **Cinemática de apertura "Génesis"** (`LORE_INTRO`/`showIntro`): cold-open
  narrativo con efecto máquina de escribir que establece el mundo (el Núcleo roto, por
  qué nacen aigrons cada día, el Oráculo) antes del tutorial. Se ve una vez y se reve
  desde ≡ → "📖 Historia".
- ✅ **Códice del mundo** (`CODEX`/`openCodex`): la mitología del Núcleo se revela por
  hitos según descubres aigrons (cliente, desde `S.collection`; sin servidor). Incluye
  mini-bestiario por rareza. Se abre desde ≡ → "📜 Códice" y desde el álbum.
- ✅ **Recap mensual "Wrapped"** (`/recap` + `openRecap`): secuencia de tarjetas
  animadas con tu mes (cazados, joya del mes, álbum, combates) y una **imagen para
  compartir**. Se abre desde ≡ → "✨ Mi resumen" y desde un aviso en Inicio los últimos
  5 días del mes (cuando el álbum va a rotar).
- ✅ **Recordatorio push a las 11:00** (hora de España): a quien tiene push y no ha
  reclamado hoy. `PUSH_REMINDER_CRON` (defecto `0 11 * * *`) con su propia zona
  `PUSH_REMINDER_TZ` (defecto `Europe/Madrid`, independiente de `CRON_TZ`).
- ✅ **Sinergias de equipo (set bonuses)** (`teamSynergy`/`applyTeamSynergy` en
  `engine.js`): bono determinista por composición de tipos, horneado junto a
  capitán/estancia y **revalidado por el servidor** (parità por construcción; el
  cliente solo refleja los stats ya horneados). Monotipo→RESONANCIA (+12% ATK/DEF),
  2 tipos→VÍNCULO (+8% HP), 3 tipos→ESPECTRO (+8% SPD y +1⚡). Visible en el
  constructor de equipo, la preparación y el banner de combate. Con tests.
- ✅ **Arco narrativo mensual** (`seasonStory` en `engine.js`): cada temporada (mes)
  es un capítulo del Núcleo que **avanza mes a mes** (índice monotónico, determinista).
  Se muestra en el álbum y el Códice. Con tests.
- ✅ **Evolución ramificada por sendero** (`EVO_PATHS`/`applyEvoPath`): al evolucionar,
  el jugador elige un perfil permanente por instancia (Ofensivo/Defensivo/Veloz),
  horneado en el servidor y revalidado; **no** rompe la evolución determinista (sigue
  siendo función pura de id+nivel: el sendero es estado del jugador). Con tests.
- ✅ **Constelaciones (gremios)** (`guilds.js`): **pestaña propia del nav** con
  sub-pestañas **Miembros / Misión / Muro**. Ranking por **poder agregado** de los
  miembros (SUM de league_points; sin hooks de escritura nuevos). Fundar (cuesta
  monedas, `GUILD_COST`), unirse (aforo `GUILD_MAX_MEMBERS`), salir (cede liderazgo o
  disuelve). **Misión semanal** que suma las victorias PvP de toda la constelación
  (reusa `weekly_missions.wins`; recompensa por miembro al alcanzar el objetivo).
  **Muro/chat** (texto escapado, rate-limited, últimos 100).
- ✅ **Trueque de duplicados** (`trades.js`): intercambio P2P de criaturas **repetidas**
  para completar el álbum (no se comercia poder pagable, §4). El swap cambia el
  propietario de las dos instancias en **una transacción** (BEGIN/COMMIT + bloqueo
  `FOR UPDATE`); solo duplicados, nada bloqueado, y al cambiar de dueño la instancia
  sale de cualquier equipo. Cubierto por el `smoke` de CI (gremios completos; trueque
  endpoints+guardas — el swap con duplicados reales se valida en revisión).
- Pendiente: ascensos/descensos por percentil y Salón de la Fama (el histórico ya existe).

### P2 — Monetización
- Pase de temporada, packs de gemas, cosméticos, anuncio recompensado, con validación de
  recibos de tienda en `/shop/purchase`. Respeta §4 del doc.

### P3 — Empaquetado a stores y notificaciones
- PWA (manifest + service worker) y/o Capacitor para iOS/Android desde `web/`.
- Push diario "tu aigrón de hoy te espera".

### P3 — Calidad (parcial)
- ✅ CI básica (`.github/workflows/ci.yml`: lint + tests en cada push/PR).
- ✅ Lint (`cd server && npm run lint`, ESLint con config en la raíz).
- ✅ Rate limiting con Redis opcional (define `REDIS_URL`; sin él, memoria local).
- ✅ Endpoints con escrituras atómicas (claim/roll/level-up/resolve: sin carreras).
- ✅ Higiene de datos a escala (`src/maintenance.js`): job diario que poda
  `battle_offers` consumidas, `battles`/`daily_missions`/`*_scores` antiguos y runs
  caducadas (retenciones por env). Caché de 30s del top de rankings. Advisory lock
  en la generación del lote (sin doble generación a medianoche).
- ✅ Tests de integración en CI (job `smoke` con PostgreSQL de servicio).
- ✅ Observabilidad mínima: `GET /admin/stats` (DAU, nuevos, combates, retención
  D1/D7; protegido por `ADMIN_KEY`) y beacon de errores del cliente
  (`POST /client-errors`, rate-limited, al log del servidor).
- ✅ XSS endurecido: los nombres se SANEAN al escribir (auth.sanitizeName +
  migración 001 para datos viejos) y se ESCAPAN al renderizar (esc() en cliente).
- Pendiente: matchmaking distribuido (Redis) para >1 réplica, CDN para
  arte/estáticos, Sentry real + pruebas de carga, i18n.

---

## 8. Generación diaria por cron

```cron
# 03:00 cada día: genera el lote de MAÑANA
0 3 * * *  cd /ruta/aigrons/server && /usr/bin/node scripts/generate-today.js $(date -d tomorrow +\%Y-\%m-\%d) >> /var/log/aigrons-batch.log 2>&1
```
Alternativa: usar la dependencia opcional `node-cron` dentro del proceso del servidor.
En local, `/daily` ya genera el lote de hoy *lazy* si no existe (cómodo para desarrollo).

---

## 9. Glosario rápido

- **Aigron**: la criatura coleccionable. Plantilla (catálogo) + instancia (la que posees).
- **Lote / batch**: conjunto de aigrons de un día (`batch_date`), igual para todos.
- **art_seed**: semilla con la que el cliente dibuja el sprite pixel-art de un aigron.
- **snapshot**: copia inmutable de los stats de un equipo, para PvP asíncrono justo.
- **decisions**: lista de momentos en que el jugador lanza habilidades en un combate.

---

## 10. Dónde mirar para cada cosa

- **Reglas de juego, fórmulas exactas, prompts de IA, esquema, modelo de costes, roadmap:**
  `docs/criaturas-imposibles.md` (es la fuente de verdad del diseño).
- **Constantes de balance y generación:** `server/src/config.js` (+ apéndice A del doc).
- **Cómo se resuelve un combate:** `server/src/combat.js`.
- **Cómo se crea el contenido del día:** `server/src/generator.js` y `jobs/generateDailyBatch.js`.
- **Endpoints y lógica de servidor:** `server/src/app.js`.
