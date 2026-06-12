# AIGRONS — Fichas de App Store y Google Play (ASO)

Basado en el análisis de: DIGIMON UP (pre-registro con hitos), Meowdoku (sitio-guía SEO), Royal Kingdom (pulido casual), Brawl Stars Store (webstore D2C) y Stumble Guys (hub de comunidad). Lo aplicable a AIGRONS está integrado abajo y en la sección 7.

Los assets de imagen se generan con `store-assets/generate_assets.py` (ver sección 6).

---

## 1. App Store (iOS)

| Campo | Límite | ES | EN |
|---|---|---|---|
| Nombre | 30 | `AIGRONS: Álbum de Criaturas` | `AIGRONS: Creature Album` |
| Subtítulo | 30 | `Cada día nace una única` | `A new creature every day` |
| Categoría | — | Juegos > Rol (secundaria: Casual) | Games > Role-Playing (sec: Casual) |

**Texto promocional (170, editable sin review — rotarlo cada temporada):**
- ES: `¡Temporada nueva! Acaba de nacer un álbum de 180 criaturas que no existían. Reclama tu tirada gratis diaria y caza la única de hoy antes de medianoche.`
- EN: `New season! An album of 180 creatures that never existed was just born. Claim your free daily pull and catch today's unique before midnight.`

**Keywords (100 caracteres, sin espacios, sin repetir palabras del nombre/subtítulo):**
- ES: `coleccionar,monstruos,pixel,mascotas,batalla,pvp,diario,casual,rpg,coleccionista,raras,legendaria`
- EN: `collect,monsters,pixel,pets,battle,pvp,daily,casual,rpg,collector,rare,legendary,season,fair`

**Descripción (hasta 4000 — no indexa para búsqueda en iOS, se escribe para convertir):**
Usar la descripción de Google Play (sección 2), idéntica.

---

## 2. Google Play (Android)

| Campo | Límite | ES | EN |
|---|---|---|---|
| Título | 30 | `AIGRONS: Álbum de Criaturas` | `AIGRONS: Creature Album` |
| Descripción corta | 80 | `Cada día nace una criatura única. Completa el álbum de la temporada. Gratis.` | `A unique creature is born every day. Complete the season album. Free.` |
| Categoría | — | Rol (tags: Casual, Coleccionismo, Por turnos) | Role Playing (tags: Casual, Collection, Turn-based) |

**Descripción completa (ES):**

```
🧬 ESTA NOCHE HAN NACIDO CRIATURAS QUE NO EXISTÍAN

Cada temporada, una IA creadora diseña un álbum de ~180 criaturas imposibles:
pulpo + volcán = Pulpovolcán. Cada una con su nombre, su historia y su
habilidad. Nunca se repiten. Y cada día nace además UNA criatura única:
si nadie la reclama hoy, nadie volverá a verla jamás.

✨ TU RITUAL DE 2 MINUTOS
• Reclama tu tirada gratis diaria del álbum de la temporada
• Caza la única del día antes de medianoche
• Combate en batallas 3v3 con una sola decisión por turno
• Sube en el ranking y completa el álbum antes de fin de mes

⚔️ COMBATE FÁCIL DE APRENDER, DIFÍCIL DE DOMINAR
Batallas automáticas de 2 minutos con una micro-decisión por turno: cuándo
soltar la habilidad de cada criatura. 20 tipos elementales, ventajas,
críticos y composición de equipo. Se juega con una mano.

📖 EL ÁLBUM DE LA TEMPORADA
180 especies nuevas cada mes. Comunes con carisma, raras, épicas y esas
legendarias que solo verán unos pocos. Cuando la temporada acaba, el álbum
se cierra para siempre — lo que hayas encontrado es tuyo para siempre.

🏆 NUNCA PAY-TO-WIN (Y VA EN SERIO)
• Todos juegan con el mismo álbum
• El ranking mide habilidad, no cartera
• Sin loot boxes sin techo, sin ventajas de pago en combate
• Combate validado en servidor: nadie hace trampas

🎮 SEIS FORMAS DE PERDERTE
• La Única del Día — cázala o despídete para siempre
• Mazmorra roguelike — reliquias, permadeath y los ecos de otros jugadores
• Jefe Mundial — una raid global con vida compartida
• PvP en vivo — otro humano, diez segundos por turno
• Arena Sellada — draft puro, tu colección no importa
• Némesis — un rival IA que aprende de ti y vuelve a por ti

🤖 HECHO CON IA, CON ORGULLO Y TRANSPARENCIA
Nuestra IA imagina cada criatura (nombre, historia, arte). Las reglas y el
balance los controla el motor del juego. Un filtro de calidad descarta
cualquier resultado defectuoso. Contenido infinito, juego justo.

📲 Juega en 10 segundos: sin esperas, partidas cortas, progreso diario.
Tu primera criatura ya ha nacido. Solo le falta conocerte.
```

**Descripción completa (EN):** misma estructura traducida (mantener: hook inicial en mayúsculas, bullets con emoji, bloque fair-play, bloque transparencia IA, cierre "Your first creature has already been born. It just hasn't met you yet.").

**Notas ASO Google Play:** el título y la descripción SÍ indexan. Densidad objetivo en la descripción: "criaturas" (8-10×), "álbum" (5×), "coleccionar/colección" (4×), "batalla/combate" (5×), "pixel" (2×) — ya cumplido arriba sin sonar a spam.

---

## 3. Capturas de pantalla (orden y textos)

Las 2 primeras capturas deciden la conversión (son las visibles sin scroll). Orden:

| # | Concepto | Texto ES | Texto EN |
|---|---|---|---|
| 1 | Altar de la única | `HOY HA NACIDO ALGO QUE NO VOLVERÁ A NACER` | `BORN TODAY. GONE AT MIDNIGHT.` |
| 2 | Tirada diaria | `UNA TIRADA GRATIS CADA DÍA` | `A FREE PULL EVERY DAY` |
| 3 | Combate 3v3 | `COMBATES DE 2 MINUTOS` | `2-MINUTE BATTLES` |
| 4 | Álbum/códice | `COMPLETA EL ÁLBUM DE LA TEMPORADA` | `COMPLETE THE SEASON ALBUM` |
| 5 | Fair play | `NUNCA PAY-TO-WIN` | `NEVER PAY-TO-WIN` |

Especificaciones: 1080×1920 (9:16). iOS exige 6,9" (1320×2868) y acepta 6,5" (1284×2778) — exportar también esos tamaños reescalando el lienzo. Cuando haya capturas reales del juego, sustituir el mock central manteniendo marco y titular.

---

## 4. Icono

- Concepto: **una sola criatura legendaria centrada** sobre degradado oscuro neón (morado→magenta), borde grueso dorado estilo marco de rareza. Sin texto (el nombre ya está en la ficha). Legible a 48px.
- Tamaños: 1024×1024 (iOS, sin alfa ni esquinas redondeadas), 512×512 (Play).
- A/B en Play Store (Experimentos de ficha): criatura legendaria vs. huevo eclosionando con resplandor. Medir CTR 7 días.

## 5. Vídeo preview (cuando haya build grabable)

15–20 s, vertical, sin voz (se ve en mute): 0-3 s nacimiento de una criatura → 3-8 s combate con números de daño → 8-13 s álbum llenándose → 13-17 s ranking subiendo → cierre logo + "Gratis. Cada día.". Google Play: YouTube 16:9 también válido.

---

## 6. Assets generados (script reproducible)

`store-assets/generate_assets.py` genera en `store-assets/out/`:

| Asset | Tamaño | Uso |
|---|---|---|
| `icon_1024.png` / `icon_512.png` | 1024² / 512² | App Store / Google Play |
| `feature_graphic_1024x500.png` | 1024×500 | Google Play (cabecera de ficha) |
| `screenshot_{es,en}_1..5.png` | 1080×1920 | Ambas stores |
| `og_image_1200x630.png` | 1200×630 | Landing/redes (era el asset que faltaba) |
| `promo_key_art_1920x1080.png` | 1920×1080 | Prensa, YouTube, banners |

Estilo: el mismo ADN del juego (sprites 16×16 procedurales con contorno, paleta neón sobre fondo #070710, auroras, logo pixel). Regenerables con `python3 generate_assets.py`.

**Mejora con IA (siguiente paso):** el pipeline de arte del juego (Gemini) puede generar versiones "hero" de las criaturas para el icono y el key art. Prompts listos:

- *Icono:* `Single legendary pixel-art creature portrait, 16-bit style, centered, octopus-volcano hybrid with glowing lava crown, dark purple-to-magenta radial gradient background, thick golden frame border, neon rim light, no text, app icon composition, crisp pixels, high contrast`
- *Key art:* `Epic pixel-art key art, a mysterious glowing egg hatching surrounded by 6 diverse pixel creatures (crystal fish, shadow clock, sprout, storm bird, volcano octopus, rune golem), dark night sky with neon aurora (cyan, magenta, gold), 16-bit JRPG style, dramatic lighting, wide composition, space for logo at top center`
- *Feature graphic:* `Pixel-art banner, parade of unique creatures walking toward a glowing album book, neon palette on near-black, 16-bit style, wide 1024x500 composition, empty left third for logo text`
- Regla: generar a 2048+, reducir con nearest-neighbor para mantener píxel nítido. Pasar siempre el filtro de visión del pipeline (igual que el arte del juego).

---

## 7. Lecciones de las referencias aplicadas

| Referencia | Qué hacen bien | Aplicación a AIGRONS |
|---|---|---|
| DIGIMON UP | Pre-registro con hitos públicos (100k→500k→1M) que regalan contenido | Campaña de pre-registro en Play/App Store: 1k registros → criatura fundadora exclusiva; 5k → 10 tiradas; 10k → legendaria de lanzamiento. Banner de hitos en la landing |
| DIGIMON UP | Ficha técnica clara (género, precio, plataformas, fecha) | Añadir bloque "Especificaciones" al kit de prensa y a la landing (FAQ) |
| Meowdoku | Sitio-guía SEO (niveles, cómo jugar, FAQ) que captura búsquedas | El álbum público `/season` + página por criatura ya planificados cubren esto; añadir `/como-jugar` con las 4 reglas del combate |
| Royal Kingdom | Ficha pulida orientada 100% a conversión casual | Capturas con titular grande y un solo mensaje por captura (sección 3) |
| Brawl Stars Store | Webstore D2C con +10% de bonus para saltarse la comisión de stores | Post-lanzamiento: vender pase/gemas vía web (el juego ya ES web) con +10% de bonus — margen completo sin comisión del 30% |
| Stumble Guys | Hub: noticias, consejos, FAQ enorme, programa de creadores | Roadmap web: /news con el patch de cada temporada; programa de creadores cuando haya masa crítica |

---

## 8. Checklist de publicación

- [ ] Cuenta Apple Developer (99 €/año) y Google Play Console (25 € una vez)
- [ ] Empaquetado Capacitor (ya previsto post-MVP) con login real Apple/Google
- [ ] Ficha ES + EN cargadas (textos de este doc, verificar límites con `verify_limits.py` del script)
- [ ] Icono A y B subidos; experimento de ficha en Play activado
- [ ] Capturas 1080×1920 + tamaños iOS 6,9"/6,5"
- [ ] Clasificación de contenido (PEGI 3/Everyone; sin compras hasta activar IAP reales)
- [ ] Política de privacidad pública (URL en la landing)
- [ ] Pre-registro activado con hitos anunciados en redes y landing
```
