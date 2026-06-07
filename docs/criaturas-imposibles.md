# Criaturas Imposibles — Documento maestro de diseño e implementación

> Documento único y completo para construir el juego de cero. Incluye definición de
> producto, diseño de sistemas con números y fórmulas reales, todos los prompts de IA,
> esquema de base de datos, endpoints, job de generación nocturna, modelo de costes y
> roadmap. Pensado para entregar a desarrollo o implementar tú mismo.

**Versión:** 1.0 · **Plataforma objetivo:** móvil (iOS + Android) · **Idioma del juego:** español

---

## 0. Resumen ejecutivo

**Criaturas Imposibles** es un juego móvil casual-coleccionista de sesiones muy cortas
(1-3 min). Cada día una IA genera un lote nuevo de criaturas únicas (arte + stats + lore)
que nunca se repetirán igual. El jugador reclama una criatura diaria gratis, juega
mini-combates asíncronos de 30-60 s para ganar más, las colecciona y fusiona, y compite en
ligas semanales y en un ranking diario justo (todos comparten el mismo lote del día).

**Las 3 decisiones de producto que sostienen todo:**

1. **El contenido se genera por lotes por adelantado, no bajo demanda.** Un job nocturno
   crea el catálogo del día. Esto hace el coste predecible y bajísimo, da latencia cero al
   jugador y permite que todos compartan el mismo set diario (clave para el ranking justo).
2. **El combate es auto-batalla con una micro-decisión por turno.** Jugable con una mano,
   sin esperas (PvP asíncrono contra un *snapshot* del equipo de otro jugador), pero con
   suficiente skill para que haya escalada de ligas.
3. **Monetización no tóxica.** Pase de temporada + cosméticos + tiradas extra con techo
   diario. El dinero acelera la colección, no compra victorias.

---

## 1. Visión y pilares de diseño

**Fantasía central:** *"Hoy ha nacido una criatura que no había existido nunca, y es mía."*

**Pilares (toda decisión de diseño debe respetar al menos uno):**

- **Efímero y diario.** El lote de hoy desaparece mañana. Crea hábito y FOMO sano.
- **Coleccionar > ganar.** El combate es el medio para coleccionar, no el fin.
- **Pique justo.** La competición se basa en habilidad de montar equipo, no en quién pagó más.
- **Cero fricción.** Abrir, jugar y cerrar en menos de 2 minutos sin tutoriales.

**Público objetivo:** jugadores casuales 18-40 que ya juegan Wordle, juegos de "daily",
gacha ligeros o coleccionables; gente con ratos muertos (transporte, colas, descansos).

---

## 2. Bucle de juego

### 2.1 Sesión típica (lo que ocurre en el metro)

```
ABRIR APP
  └─> ¿Hay tirada diaria sin reclamar?  ──sí──> Reclamar criatura del lote de hoy (rareza aleatoria)
  └─> Jugar 1-2 combates rápidos (30-60 s c/u)  ──> ganar monedas + posibilidad de criatura
  └─> (opcional) Fusionar / mejorar / liberar criaturas
  └─> Mirar ranking diario y de liga
CERRAR
```

### 2.2 Diagrama de estados (cliente)

```
[Home]
  ├── [DailyClaim]  -> animación de "nacimiento" de criatura -> [CreatureDetail] -> [Home]
  ├── [Battle]      -> selección de 3 criaturas -> resolución auto -> recompensa -> [Home]
  ├── [Collection]  -> álbum/grid -> [CreatureDetail] -> [Fusion] -> [Home]
  ├── [Leagues]     -> ranking de liga + ranking diario -> [Home]
  └── [Shop]        -> pase, cosméticos, tiradas extra -> [Home]
```

### 2.3 Economía de tiempo y energía

- **Tirada diaria:** 1 gratis al día (reset 00:00 hora local del jugador).
- **Combates:** consumen "energía" (5 de energía máx, +1 cada 30 min). Esto limita el grind
  sin pagar y crea retorno a lo largo del día. Combate = 1 energía.
- **Tiradas extra:** se compran con monedas (ganadas) o con moneda premium (pagada), con un
  **techo de 10 tiradas pagadas/día** para evitar abuso.

---

## 3. Sistemas de juego

### 3.1 Criatura — modelo de datos

Cada criatura del catálogo es inmutable (plantilla). Cada criatura que posee un jugador es
una instancia que referencia a la plantilla y añade estado (nivel, XP, cosméticos).

```json
// PLANTILLA (generada por el job nocturno, compartida por todos)
{
  "template_id": "2026-06-06_0142",        // fecha del lote + índice
  "batch_date": "2026-06-06",
  "name": "Pulpovolcán",                   // generado por LLM
  "species_tags": ["pulpo", "volcán"],     // rasgos fusionados
  "type": "VOLCAN",                        // tipo elemental (ver 3.2)
  "rarity": "EPICA",                        // ver 3.5
  "base_stats": { "hp": 920, "atk": 140, "def": 70, "spd": 95 },
  "ability_id": "ERUPCION_LENTA",          // ver 3.4
  "lore": "Duerme en fosas marinas hasta que el agua hierve.",
  "image_url": "https://cdn.../2026-06-06_0142.webp",
  "image_thumb_url": "https://cdn.../2026-06-06_0142_thumb.webp",
  "art_seed": 81723123,                    // semilla para reproducibilidad
  "quality_score": 0.91                    // del filtro de calidad
}
```

```json
// INSTANCIA (lo que posee un jugador concreto)
{
  "instance_id": "uuid",
  "user_id": "uuid",
  "template_id": "2026-06-06_0142",
  "level": 1,
  "xp": 0,
  "obtained_at": "2026-06-06T08:14:00Z",
  "favorite": false,
  "cosmetic_frame": null,
  "locked": false                          // protege de liberación accidental
}
```

### 3.2 Tipos elementales y tabla de efectividad

8 tipos. El multiplicador de daño se aplica según atacante → defensor. Diseñado como un
"piedra-papel-tijera" extendido para que no exista un tipo dominante.

| Tipo      | Fuerte contra (×1.5) | Débil contra (×0.75) |
|-----------|----------------------|----------------------|
| VOLCAN    | PLANTA, CRISTAL      | NIEBLA, TORMENTA     |
| NIEBLA    | VOLCAN, TORMENTA     | VACIO, BESTIA        |
| CRISTAL   | TORMENTA, RELOJ      | VOLCAN, BESTIA       |
| RELOJ     | BESTIA, VACIO        | CRISTAL, PLANTA      |
| VACIO     | NIEBLA, CRISTAL      | RELOJ, TORMENTA      |
| BESTIA    | CRISTAL, PLANTA      | NIEBLA, RELOJ        |
| PLANTA    | RELOJ, TORMENTA      | VOLCAN, BESTIA       |
| TORMENTA  | VACIO, VOLCAN        | CRISTAL, PLANTA      |

Multiplicador por defecto (no listado): ×1.0.

### 3.3 Stats y fórmulas

Cuatro stats: **HP, ATK, DEF, SPD**. Rangos base por rareza (la generación de stats debe
caer dentro de estos rangos):

| Rareza      | HP        | ATK     | DEF     | SPD    |
|-------------|-----------|---------|---------|--------|
| COMUN       | 600–800   | 80–110  | 40–60   | 70–90  |
| RARA        | 750–950   | 100–135 | 55–80   | 80–100 |
| EPICA       | 900–1150  | 125–160 | 70–100  | 90–115 |
| LEGENDARIA  | 1100–1400 | 150–200 | 90–130  | 100–130|

**Escalado por nivel** (nivel 1–20):
```
stat_final = round( base_stat * (1 + 0.04 * (level - 1)) )
```
(Nivel 20 ≈ +76% sobre base. Subir nivel cuesta XP, ver 3.9.)

**Fórmula de daño** (por golpe básico):
```
daño = max( 1 , round( ATK_atacante * type_mult * crit_mult * (100 / (100 + DEF_defensor)) ) )

type_mult  = 1.5 / 1.0 / 0.75 según la tabla 3.2
crit_mult  = 1.8 si crítico, si no 1.0
prob_crit  = clamp( 0.05 + (SPD_atacante - SPD_defensor) / 1000 , 0.05 , 0.35 )
```

**Orden de turno:** mayor SPD actúa primero. Empate → desempata `instance_id` (determinista
para que el combate sea reproducible dado el mismo seed).

### 3.4 Habilidades

Cada criatura tiene **1 habilidad** con un coste de energía de combate (distinta de la
energía de la app). La energía de combate empieza en 0 y sube +1 por turno; la habilidad se
puede lanzar cuando hay energía suficiente. **La micro-decisión del jugador cada turno es:
lanzar la habilidad ahora o esperar.**

Catálogo inicial (12 habilidades; la generación asigna una según el tipo/lore):

| ability_id        | Coste | Efecto                                                            |
|-------------------|-------|-------------------------------------------------------------------|
| ERUPCION_LENTA    | 3     | Daño = ATK×2.2 a un objetivo; ignora 50% DEF                       |
| MURO_CRISTAL      | 2     | +60% DEF a sí misma durante 2 turnos                               |
| NIEBLA_DENSA      | 2     | -40% prob. crítico del rival durante 2 turnos                     |
| ROBO_DE_TIEMPO    | 3     | Actúa dos veces este turno                                         |
| COLAPSO_VACIO     | 4     | Daño = ATK×1.5 a TODO el equipo rival                              |
| FRENESI_BESTIA    | 3     | +50% ATK propio hasta fin de combate, -20% DEF propio             |
| RAICES            | 2     | Cura 25% del HP máx propio                                         |
| RAYO              | 3     | Daño = ATK×2.0; +100% prob. crítico en este golpe                 |
| ESCUDO_EQUIPO     | 4     | +30% DEF a todo el equipo propio durante 2 turnos                 |
| MARCA_FATAL       | 2     | El objetivo recibe +30% de daño durante 3 turnos                  |
| REGENERAR         | 3     | Cura 15% HP máx a todo el equipo propio                           |
| SACRIFICIO        | 4     | Daño = ATK×3.5 a un objetivo; la criatura pierde 20% de su HP máx |

### 3.5 Rareza

| Rareza      | % en tirada | Marca visual            | Notas                                  |
|-------------|-------------|-------------------------|----------------------------------------|
| COMUN       | 60%         | marco gris              | stats bajos, sin efectos especiales    |
| RARA        | 25%         | marco azul              | stats medios                           |
| EPICA       | 12%         | marco morado + brillo   | stats altos                            |
| LEGENDARIA  | 3%          | marco dorado animado    | stats máximos + arte premium + nombre en Salón de la Fama |

Las probabilidades se aplican en cada tirada de forma independiente. **Sin "pity" oculto en
el MVP**; si se añade después, documentar claramente (transparencia = pilar de pique justo).

### 3.6 Combate — resolución (pseudocódigo)

Combate 3v3 determinista dado `seed`. El jugador controla cuándo lanzar las habilidades de
sus criaturas; el equipo rival (snapshot) lo controla una IA simple.

```python
def resolve_battle(team_a, team_b, seed, player_decisions):
    rng = Rng(seed)
    units = [u for u in team_a + team_b if u.hp > 0]
    energy = {u.id: 0 for u in units}
    turn = 0
    log = []

    while alive(team_a) and alive(team_b) and turn < 60:
        order = sorted(alive_units(units), key=lambda u: (-u.spd, u.id))
        for u in order:
            if u.hp <= 0:
                continue
            energy[u.id] = min(energy[u.id] + 1, 6)

            # Decisión de habilidad
            if u.team == "A":
                use = player_decisions.get((turn, u.id), False)  # jugador decidió
            else:
                use = ai_should_use_ability(u, energy[u.id])     # IA rival

            target = pick_target(u, enemies_of(u))               # objetivo: menor HP%
            if use and energy[u.id] >= u.ability.cost:
                energy[u.id] -= u.ability.cost
                apply_ability(u, target, log, rng)
            else:
                apply_basic_attack(u, target, log, rng)

            remove_dead(units)
        turn += 1

    return battle_result(team_a, team_b, log)
```

**IA rival** (`ai_should_use_ability`): lanza la habilidad en cuanto tiene energía
suficiente, salvo las de un solo objetivo, que reserva si hay ≥2 enemigos vivos con >50% HP.
Suficiente para que el jugador sienta que su *timing* importa.

**Importante para la sincronía:** como el combate es determinista dado `seed` + decisiones,
el servidor puede recalcularlo para validar el resultado y evitar trampas del cliente.

### 3.7 Fusión (versión 2, no MVP)

Combinar 2 instancias para obtener 1 criatura nueva. La IA genera arte fusionando los
`species_tags` de ambas.

**Reglas:**
- Coste: las 2 criaturas se consumen + N monedas (escala con rareza).
- Rareza resultante: probabilística según la rareza de los padres.

| Padres (mayor + menor) | Prob. de subir un escalón | Prob. mantener mayor | Prob. bajar |
|------------------------|---------------------------|----------------------|-------------|
| COMUN + COMUN          | 20% → RARA                | 70% COMUN            | —           |
| RARA + (≥RARA)         | 25% → EPICA               | 65% RARA             | 10% COMUN   |
| EPICA + (≥EPICA)       | 15% → LEGENDARIA          | 75% EPICA            | 10% RARA    |
| con LEGENDARIA         | —                         | 90% mantiene mayor   | 10% baja    |

- **Herencia de tipo:** 50% tipo del padre A, 50% del padre B.
- **Herencia de habilidad:** hereda la del padre de mayor rareza (empate → aleatorio).
- **Stats:** media de los padres ± variación aleatoria dentro del rango de la rareza final.
- La fusión genera arte **bajo demanda** (única excepción al modelo por lotes), así que se
  cachea por par de `template_id` ordenado para no regenerar combinaciones repetidas.

### 3.8 Colección / álbum

- Vista grid con filtros: por tipo, rareza, fecha de obtención, favoritas.
- **Duplicados:** se permiten; los duplicados se pueden "liberar" por **polvo** (recurso de
  mejora) o fusionar.
- **Progreso de colección:** "Has descubierto 142 de las criaturas del lote de hoy" (motiva
  jugar más ese día). El catálogo histórico completo no es coleccionable al 100% a propósito
  (sería imposible y agobiante); el objetivo es el set diario + tus favoritas.

### 3.9 Economía y recursos

| Recurso          | Cómo se gana                              | Para qué sirve                         |
|------------------|-------------------------------------------|----------------------------------------|
| Monedas          | combates, misiones diarias, ranking       | tiradas extra, subir nivel, fusión     |
| Polvo            | liberar duplicados                        | subir nivel de criaturas               |
| Energía          | regenera +1/30 min (máx 5)                 | jugar combates                         |
| Gemas (premium)  | compra real / recompensas de pase         | pase, cosméticos, tiradas extra        |

**Coste de subir nivel** (polvo + monedas):
```
polvo(level)   = 10 * level
monedas(level) = 50 * level
```

### 3.10 Competitivo

**Ligas semanales** (reset lunes 00:00 UTC):
- Bronce → Plata → Oro → Platino → Diamante.
- Cada combate PvP ganado da puntos de liga; perder resta (menos de lo que da ganar).
- Top % de cada liga sube; bottom % baja. Recompensas de monedas/gemas al cierre.

**Ranking diario (el motor viral):**
- Como el lote de criaturas es el mismo para todos, se rankea: *"con el equipo que montaste
  hoy, ¿cuántos combates ganaste?"*. Reset diario. Genera conversación ("¿te salió la
  legendaria de hoy?") y comparación entre amigos.

**Salón de la Fama:**
- Cada legendaria del día muestra el nombre del **primer jugador** que la consiguió.
- Lista semanal de las criaturas más usadas/ganadoras.

### 3.11 Progresión y retención

- **Misiones diarias** (3): p. ej. "gana 3 combates", "reclama tu criatura diaria", "usa una
  habilidad 5 veces". Recompensa: monedas.
- **Racha diaria:** abrir y reclamar cada día sube una racha con recompensas crecientes
  (refuerza el hábito tipo Wordle).
- **Pase de temporada:** 30 días, niveles gratuitos + premium.


---

## 4. Monetización

Principio: **el dinero acelera la colección, nunca compra victorias garantizadas.**

| Producto              | Tipo            | Precio orientativo | Contenido                                            |
|-----------------------|-----------------|--------------------|------------------------------------------------------|
| Pase de temporada     | una vez/mes     | 4,99–7,99 €        | recompensas cosméticas + tiradas + gemas, 2 vías     |
| Pack de gemas         | consumible      | 0,99–49,99 €       | moneda premium                                       |
| Cosméticos            | una vez         | 0,99–4,99 €        | marcos, fondos de álbum, efectos de "nacimiento"     |
| Tiradas extra         | consumible      | gemas              | criaturas extra del lote del día (techo 10/día pagas)|
| Quitar anuncios       | una vez         | 2,99 €             | (si se usa publicidad con recompensa)                |

**Publicidad (opcional, no intrusiva):** anuncio con recompensa voluntario ("ver anuncio →
+1 tirada" o "+2 energía"). Nunca anuncios forzados que rompan el flujo de <2 min.

**Qué NO hacer:** loot boxes sin techo, ventajas de combate solo-pagables, manipular las
probabilidades de rareza por gasto. Va contra el pilar de "pique justo" y contra la
retención a largo plazo.

---

## 5. Pipeline de contenido IA

Esta es la maquinaria que hace funcionar el juego. **Todo se genera por lotes la noche
anterior** (salvo fusiones, bajo demanda y cacheadas).

### 5.1 Arquitectura de generación por lotes

```
CRON nocturno (p. ej. 03:00 UTC)
  1. Decidir composición del lote del día (p. ej. 400 criaturas con la curva de rareza)
  2. Para cada criatura:
       a. Componer concepto (fusión de rasgos)          -> LLM (barato)
       b. Generar prompt de imagen a partir del concepto -> plantilla + LLM
       c. Generar imagen                                 -> modelo de imagen
       d. Filtro de calidad + seguridad                  -> modelo de visión
       e. Si pasa: generar stats + nombre + lore + habilidad -> LLM (JSON)
       f. Subir imagen a CDN, guardar plantilla en BD
  3. Marcar el lote como "publicado" para batch_date = mañana
  4. Métricas: % aprobado por filtro, coste total, distribución de rareza
```

**Composición del lote (ejemplo para 400 criaturas/día):**
- 240 comunes, 100 raras, 48 épicas, 12 legendarias (curva 60/25/12/3).
- Genera ~20-30% de más para compensar los descartes del filtro de calidad.

### 5.2 Prompt — concepto de criatura (LLM)

Genera el "ADN" conceptual. Modelo: un LLM económico. **Salida estricta en JSON.**

```text
SYSTEM:
Eres un diseñador de criaturas para un juego coleccionable. Inventas criaturas imposibles
fusionando dos conceptos dispares (un animal/objeto + un fenómeno/material). Deben ser
absurdas pero coherentes y visualmente claras. Nada de marcas, personajes con copyright,
ni contenido sensible. Responde SOLO con JSON, sin texto adicional ni markdown.

USER:
Genera UNA criatura. Restricciones:
- tipo elemental: {TYPE}        // uno de: VOLCAN, NIEBLA, CRISTAL, RELOJ, VACIO, BESTIA, PLANTA, TORMENTA
- rareza: {RARITY}              // afecta a lo épico/imponente de la descripción visual
- evita repetir estos conceptos ya usados hoy: {RECENT_TAGS}

Devuelve JSON con este esquema exacto:
{
  "name": "string (1-2 palabras, inventado, en español, evocador)",
  "species_tags": ["string", "string"],   // los 2 conceptos fusionados
  "visual_description": "string (1 frase concreta describiendo su aspecto físico)",
  "lore": "string (1 frase de trasfondo, tono entre épico y gracioso)",
  "palette": "string (2-3 colores dominantes)"
}
```

### 5.3 Prompt — generación de imagen

Se construye con plantilla fija + la `visual_description` y `palette` del paso anterior. La
plantilla impone un **estilo visual unificado** (crítico para que la colección no parezca un
cajón de sastre).

```text
{visual_description}, {palette} color palette, single creature centered, full body,
clean studio background with soft gradient, video-game collectible monster art,
semi-stylized 3D render look, soft rim lighting, high detail, no text, no watermark,
no humans, square composition, character concept art
```

**Parámetros recomendados:**
- Resolución: 1024×1024 (luego se genera thumbnail 256×256).
- `seed`: aleatorio guardado en `art_seed` (reproducibilidad).
- Modelo barato para comunes/raras; modelo premium para legendarias.

**Plantilla específica de LEGENDARIA** (añadir al final del prompt):
```text
..., epic legendary creature, dramatic volumetric lighting, ornate details,
golden accents, awe-inspiring, premium collectible card art
```

### 5.4 Prompt — filtro de calidad y seguridad (modelo de visión)

Cada imagen generada pasa por un modelo de visión que la puntúa y la aprueba o descarta.
Esto evita que la colección tenga arte roto (la causa nº1 de que un juego de IA parezca cutre).

```text
SYSTEM:
Eres un controlador de calidad de arte para un juego. Evalúas una imagen de criatura.
Responde SOLO JSON.

USER (con imagen adjunta):
Evalúa esta imagen de criatura coleccionable. Devuelve JSON:
{
  "is_single_clear_creature": true/false,   // una sola criatura, reconocible
  "has_artifacts": true/false,              // miembros derretidos, deformidades raras, ruido
  "has_text_or_watermark": true/false,
  "is_safe": true/false,                    // sin contenido sexual, violento o sensible
  "matches_style": true/false,              // coherente con arte de monstruo coleccionable
  "quality_score": 0.0-1.0,                 // calidad global
  "reject_reason": "string o null"
}
```

**Regla de aceptación:**
```
aceptar = is_single_clear_creature AND NOT has_artifacts AND NOT has_text_or_watermark
          AND is_safe AND matches_style AND quality_score >= 0.7
```
(Legendarias: umbral más alto, `quality_score >= 0.85`.)

### 5.5 Prompt — stats, habilidad y validación final (LLM, JSON)

Una vez aprobada la imagen, se generan los datos de juego. Para mantener el balance, los
stats se generan **dentro de los rangos de la tabla 3.3** y se validan en código.

```text
SYSTEM:
Eres el diseñador de balance de un juego de combate por equipos. Asignas stats y una
habilidad a una criatura. Respeta ESTRICTAMENTE los rangos dados. Responde SOLO JSON.

USER:
Criatura: {name} ({species_tags}), tipo {TYPE}, rareza {RARITY}.
Rangos permitidos para {RARITY}: HP {HP_MIN}-{HP_MAX}, ATK {ATK_MIN}-{ATK_MAX},
DEF {DEF_MIN}-{DEF_MAX}, SPD {SPD_MIN}-{SPD_MAX}.
Habilidades disponibles (elige la más temática): {ABILITY_LIST}

Devuelve JSON:
{
  "base_stats": { "hp": int, "atk": int, "def": int, "spd": int },
  "ability_id": "string (de la lista)"
}
```

> El código DEBE validar que los stats caen en rango y, si no, recortarlos (clamp) antes de
> guardar. Nunca confíes ciegamente en la salida del LLM para el balance.

### 5.6 Generación de fusiones (bajo demanda, v2)

Mismo flujo que 5.2–5.3 pero el concepto se construye a partir de los `species_tags` de
ambos padres. Prompt de concepto:

```text
USER:
Fusiona estas dos criaturas en una sola coherente:
A: {name_A} ({tags_A})
B: {name_B} ({tags_B})
Tipo resultante: {RESULT_TYPE}. Rareza resultante: {RESULT_RARITY}.
Devuelve el mismo esquema JSON de concepto que antes.
```
El arte resultante se cachea con clave `fusion:{min(id_A,id_B)}:{max(id_A,id_B)}` para no
regenerar la misma combinación dos veces.


---

## 6. Plan técnico

### 6.1 Arquitectura general

```
┌─────────────┐      HTTPS/REST      ┌──────────────────┐
│  App móvil   │ ───────────────────> │   API backend     │
│ (Flutter o   │ <─────────────────── │  (REST + Auth)    │
│  React Native)│                     └─────────┬────────┘
└─────────────┘                                │
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                            │                           │
              ┌─────▼─────┐              ┌───────▼───────┐           ┌────────▼────────┐
              │ PostgreSQL │              │  CDN / Object  │          │  Worker / Cron   │
              │  (datos)   │              │ storage (arte) │          │ (job nocturno IA)│
              └────────────┘              └────────────────┘          └────────┬────────┘
                                                                                │
                                                              ┌─────────────────┼─────────────────┐
                                                         ┌────▼────┐      ┌──────▼──────┐    ┌──────▼──────┐
                                                         │ LLM API │      │ Imagen API  │    │ Visión API  │
                                                         └─────────┘      └─────────────┘    └─────────────┘
```

### 6.2 Stack recomendado

| Capa            | Recomendación                | Por qué                                            |
|-----------------|------------------------------|----------------------------------------------------|
| Cliente móvil   | **Flutter** (o React Native) | un solo código iOS+Android, buen rendimiento UI    |
| Backend/API     | **Node.js (NestJS)** o Python (FastAPI) | rápido de montar, buen soporte de colas   |
| Base de datos   | **PostgreSQL**               | relacional, transacciones, JSONB para flexibilidad |
| Caché/colas     | **Redis**                    | energía, rate limiting, cola del job nocturno      |
| Almacén de arte | **S3 / R2 + CDN**            | servir imágenes barato y rápido                    |
| Auth            | **Apple/Google sign-in + JWT** | fricción mínima en móvil                          |
| Job IA          | **Worker + cron** (mismo lenguaje backend) | aislado del tráfico de usuarios     |

### 6.3 Esquema de base de datos (PostgreSQL)

```sql
-- Usuarios
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  auth_provider TEXT NOT NULL,            -- 'apple' | 'google'
  auth_subject  TEXT NOT NULL UNIQUE,
  coins         INT  NOT NULL DEFAULT 0,
  gems          INT  NOT NULL DEFAULT 0,
  dust          INT  NOT NULL DEFAULT 0,
  energy        INT  NOT NULL DEFAULT 5,
  energy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  league        TEXT NOT NULL DEFAULT 'BRONCE',
  league_points INT  NOT NULL DEFAULT 0,
  daily_streak  INT  NOT NULL DEFAULT 0,
  last_claim_date DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plantillas de criatura (catálogo generado por el job)
CREATE TABLE creature_templates (
  template_id   TEXT PRIMARY KEY,         -- '2026-06-06_0142'
  batch_date    DATE NOT NULL,
  name          TEXT NOT NULL,
  species_tags  TEXT[] NOT NULL,
  type          TEXT NOT NULL,            -- VOLCAN, NIEBLA, ...
  rarity        TEXT NOT NULL,            -- COMUN, RARA, EPICA, LEGENDARIA
  base_hp  INT NOT NULL, base_atk INT NOT NULL,
  base_def INT NOT NULL, base_spd INT NOT NULL,
  ability_id    TEXT NOT NULL,
  lore          TEXT,
  image_url     TEXT NOT NULL,
  image_thumb_url TEXT NOT NULL,
  art_seed      BIGINT,
  quality_score REAL,
  is_fusion     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_templates_batch ON creature_templates(batch_date);

-- Instancias que posee cada usuario
CREATE TABLE creature_instances (
  instance_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  template_id   TEXT NOT NULL REFERENCES creature_templates(template_id),
  level         INT  NOT NULL DEFAULT 1,
  xp            INT  NOT NULL DEFAULT 0,
  favorite      BOOLEAN NOT NULL DEFAULT false,
  locked        BOOLEAN NOT NULL DEFAULT false,
  cosmetic_frame TEXT,
  obtained_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_instances_user ON creature_instances(user_id);

-- Equipos guardados (para PvP asíncrono: se "congela" el equipo)
CREATE TABLE teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  slot1         UUID REFERENCES creature_instances(instance_id),
  slot2         UUID REFERENCES creature_instances(instance_id),
  slot3         UUID REFERENCES creature_instances(instance_id),
  snapshot      JSONB,                    -- copia inmutable de stats para PvP justo
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Combates (registro y validación)
CREATE TABLE battles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id   UUID NOT NULL REFERENCES users(id),
  defender_id   UUID REFERENCES users(id),     -- null si es PvE
  seed          BIGINT NOT NULL,
  result        TEXT NOT NULL,                 -- 'WIN' | 'LOSS'
  daily_date    DATE NOT NULL,                 -- para ranking diario
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_battles_daily ON battles(daily_date, attacker_id);

-- Ranking diario agregado (materializado por job o trigger)
CREATE TABLE daily_scores (
  daily_date    DATE NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id),
  wins          INT NOT NULL DEFAULT 0,
  PRIMARY KEY (daily_date, user_id)
);
```

### 6.4 API / endpoints

```
POST   /auth/login                 -> { token, user }
GET    /me                         -> estado del usuario (monedas, energía, liga, racha)

GET    /daily                      -> info del lote de hoy + si ya reclamó
POST   /daily/claim                -> reclama la criatura diaria gratis -> { instance }

GET    /collection                 -> instancias del usuario (paginado, filtros)
GET    /creature/:instance_id      -> detalle
POST   /creature/:id/level-up      -> sube nivel (gasta polvo+monedas)
POST   /creature/:id/release       -> libera duplicado -> polvo
POST   /creature/:id/favorite      -> toggle favorito/lock

GET    /team                       -> equipo actual
PUT    /team                       -> guarda 3 slots (regenera snapshot)

POST   /battle/find                -> devuelve un oponente (snapshot) + seed
POST   /battle/resolve             -> { battle_id, decisions } -> valida y aplica recompensa
GET    /rankings/daily             -> top del día + posición del usuario
GET    /rankings/league            -> ranking de liga

POST   /shop/roll                  -> tirada extra (gasta monedas/gemas, respeta techo)
POST   /shop/purchase              -> compra (validación de recibo de tienda)

POST   /fusion                     -> (v2) fusiona 2 instancias -> nueva criatura
```

**Antitrampa:** el cliente envía sus `decisions` (turno + qué habilidad), el servidor
**recalcula el combate** con el `seed` (determinista) y solo entonces concede recompensas.
El cliente nunca reporta "he ganado".

### 6.5 Job nocturno de generación (pseudocódigo)

```python
def generate_daily_batch(target_date):
    plan = {"COMUN": 240, "RARA": 100, "EPICA": 48, "LEGENDARIA": 12}
    recent_tags = []
    created = 0

    for rarity, count in plan.items():
        made = 0
        attempts = 0
        while made < count and attempts < count * 2:   # margen para descartes
            attempts += 1
            ctype = random.choice(TYPES)

            concept = llm_concept(ctype, rarity, recent_tags[-30:])   # 5.2
            img_prompt = build_image_prompt(concept, rarity)          # 5.3
            seed = random.randint(0, 2**31)
            image = image_api(img_prompt, seed=seed,
                              model=PREMIUM if rarity=="LEGENDARIA" else CHEAP)

            qc = vision_filter(image)                                 # 5.4
            if not accepted(qc, rarity):
                continue

            stats = llm_stats(concept, ctype, rarity, RANGES[rarity], ABILITIES)  # 5.5
            stats = clamp_to_ranges(stats, RANGES[rarity])            # validación dura

            url, thumb = upload_to_cdn(image, target_date, created)
            save_template(target_date, concept, ctype, rarity, stats, url, thumb, seed, qc)

            recent_tags += concept["species_tags"]
            made += 1
            created += 1

    publish_batch(target_date)
    log_metrics(target_date, created, cost_accumulated)
```

### 6.6 Cliente móvil — notas

- **Precarga:** al abrir, descargar solo thumbnails del lote + la criatura reclamada en alta.
- **Animación de "nacimiento":** efecto de revelado al reclamar (clave para el subidón).
- **Combate:** UI de 3 botones (uno por criatura) que se iluminan cuando su habilidad está
  cargada; el resto es automático y animado. Saltable/acelerable.
- **Offline-friendly:** la colección se cachea localmente; los combates requieren conexión
  (validación servidor).

### 6.7 PvP asíncrono — cómo funciona sin esperas

1. Cada vez que el jugador edita su equipo, se guarda un **snapshot** inmutable (stats
   congelados) en `teams.snapshot`.
2. `POST /battle/find` selecciona un oponente de liga similar (o un bot si no hay), devuelve
   su snapshot + un `seed`.
3. El jugador juega el combate localmente (animado) tomando sus decisiones de habilidad.
4. `POST /battle/resolve` envía las decisiones; el servidor recalcula y concede recompensas.
5. El defensor no participa en vivo: su snapshot luchó "solo" con IA. Nunca hay espera.

### 6.8 Modelo de costes (contenido IA)

Rango de mercado actual de generación de imágenes: aprox. **0,01–0,06 $/imagen** según
modelo y calidad; las Batch APIs pueden reducirlo ~50%. (Ver fuentes citadas en el chat.)

**Estimación con 400 criaturas válidas/día y ~30% de descartes (≈520 generaciones):**

| Partida                       | Cálculo                          | Coste/día aprox. |
|-------------------------------|----------------------------------|------------------|
| Imágenes comunes/raras (~505) | 505 × 0,015 $ (modelo barato)    | ~7,6 $           |
| Imágenes legendarias (~15)    | 15 × 0,05 $ (modelo premium)     | ~0,75 $          |
| LLM concepto + stats (~520×2) | tokens, modelo económico         | ~1–2 $           |
| Filtro de visión (~520)       | llamada de visión barata         | ~1–2 $           |
| **Total contenido**           |                                  | **~11–13 $/día** |

≈ **330–400 $/mes** de contenido, que sirve a **todos** los jugadores (mismo catálogo).
Si escalas a millones de usuarios, el coste de contenido NO crece (es fijo por lote); lo que
crece es infraestructura (BD, CDN, cómputo de combates), que es barata y escalable.

> Optimización: empieza con lotes más pequeños (p. ej. 150/día) en el MVP y sube según
> retención. Usa Batch API para las imágenes no urgentes (el job es nocturno: encaja perfecto).


---

## 7. MVP y roadmap

### 7.1 Alcance del MVP (objetivo: validar el bucle en 6-8 semanas)

**Incluir:**
- Login (Apple/Google).
- Job nocturno generando un lote pequeño (≈150 criaturas/día) con filtro de calidad.
- Tirada diaria gratis + animación de nacimiento.
- Colección/álbum con filtros básicos.
- Combate auto 3v3 con 1 decisión por turno (PvP asíncrono con snapshots + bots de relleno).
- Energía + monedas + tiradas extra con monedas.
- Ranking diario simple + racha diaria.

**Dejar para después:**
- Fusión, ligas completas, salón de la fama, monetización real, cosméticos, pase, anuncios.

**Pregunta que valida el MVP:** *¿la gente vuelve al día siguiente solo por ver qué criaturas
salen hoy?* (Métrica clave: retención D1/D7.)

### 7.2 Roadmap por fases

| Fase | Semanas | Entregable |
|------|---------|------------|
| 0. Prototipo del bucle de IA | 1-2 | Script que genera 1 lote completo (concepto→imagen→filtro→stats) y lo guarda. Validar calidad visual y coste real. |
| 1. Backend + BD | 2-3 | Auth, esquema, endpoints de daily/collection/battle, job nocturno en cron. |
| 2. Cliente MVP | 3-5 | Home, daily claim, álbum, combate, ranking diario. |
| 3. Soft launch | 6-8 | Lanzamiento limitado (1 país), medir retención y coste por usuario. |
| 4. Retención | post-MVP | Fusión + ligas + salón de la fama. |
| 5. Monetización | post-MVP | Pase, cosméticos, tiradas con gemas, anuncios opcionales. |
| 6. Viralidad | post-MVP | Compartir criatura/ranking, retos de amigos. |

### 7.3 Primer paso concreto recomendado

Antes de tocar el cliente, construye **solo el script de generación (Fase 0)** y genera 200
criaturas. Mira el resultado con ojo crítico: ¿se ven bien?, ¿hay variedad?, ¿el filtro
descarta lo malo?, ¿cuánto costó? Esa carpeta de 200 imágenes te dirá en una tarde si el
juego es viable, antes de invertir en todo lo demás.

---

## 8. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Calidad visual inconsistente | La colección parece cutre | Filtro de visión obligatorio + estilo unificado en el prompt + umbral alto en legendarias |
| Criaturas que "se sienten iguales" | Aburrimiento | Inyectar variedad de tags y tipos; penalizar repetición reciente; revisar paleta |
| Coste de IA se dispara | Margen negativo | Lotes pequeños al inicio, Batch API nocturna, modelo barato salvo legendarias |
| Trampas en combate | Rankings inválidos | Combate determinista validado en servidor; el cliente nunca declara victoria |
| Contenido inseguro/ofensivo generado | Riesgo de marca/tienda | Filtro de seguridad en el prompt de visión + lista negra de conceptos en el LLM |
| Saturación del mercado de coleccionables IA | Poca diferenciación | El diferenciador es el **pique competitivo diario**, no solo el arte |
| Dependencia de un proveedor de IA | Cuello de botella | Abstraer la llamada de imagen tras una interfaz; poder cambiar de modelo sin tocar el juego |
| Equilibrio de combate roto | Frustración | Stats generados dentro de rangos + clamp en código + telemetría de win-rate por tipo |

---

## 9. Métricas a seguir (KPIs)

**Retención (lo más importante):**
- D1, D7, D30 retention. Objetivo MVP: D1 > 35%, D7 > 15%.
- Sesiones por día por usuario; duración media de sesión (objetivo: 1-3 min).

**Engagement del bucle:**
- % de usuarios que reclaman la tirada diaria.
- Combates por sesión.
- Tamaño medio de colección.

**Competitivo:**
- % que entra en el ranking diario / liga.
- Distribución de win-rate por tipo (para detectar desequilibrios).

**Contenido IA:**
- % aprobado por el filtro de calidad (objetivo > 60-70%).
- Coste de contenido por día y por usuario activo.

**Negocio (post-monetización):**
- Conversión a pago, ARPDAU, % que ve anuncios con recompensa.

---

## Apéndice A — Constantes de balance (resumen para configurar)

```yaml
energia_max: 5
energia_regen_min: 30
coste_combate_energia: 1
tirada_diaria_gratis: 1
techo_tiradas_pagas_dia: 10

rareza_probabilidad: { COMUN: 0.60, RARA: 0.25, EPICA: 0.12, LEGENDARIA: 0.03 }

nivel_max: 20
escalado_por_nivel: 0.04          # +4% stats por nivel
coste_nivel_polvo: "10 * level"
coste_nivel_monedas: "50 * level"

combate:
  crit_mult: 1.8
  prob_crit_base: 0.05
  prob_crit_max: 0.35
  type_mult: { fuerte: 1.5, neutro: 1.0, debil: 0.75 }
  energia_combate_max: 6
  turnos_max: 60

lote_diario:
  total_mvp: 150
  total_produccion: 400
  margen_descartes: 0.30
  umbral_calidad: 0.70
  umbral_calidad_legendaria: 0.85
```

## Apéndice B — Lista de comprobación de implementación

- [ ] Fase 0: script de generación completo y revisión manual de 200 criaturas
- [ ] Medir coste real por lote y ajustar tamaño
- [ ] Esquema de BD desplegado
- [ ] Auth Apple/Google + JWT
- [ ] Endpoints daily / collection / team / battle / rankings
- [ ] Combate determinista + validación en servidor
- [ ] Job nocturno en cron + métricas
- [ ] CDN para arte + thumbnails
- [ ] Cliente: home, daily claim, álbum, combate, ranking
- [ ] Telemetría de retención y win-rate
- [ ] Soft launch en 1 país
