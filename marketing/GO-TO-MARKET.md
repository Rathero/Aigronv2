# AIGRONS — Plan Go-To-Market

> **Pitch:** Cada temporada, la IA genera un álbum de ~180 criaturas que no existían. Reclama una gratis cada día, completa el álbum y compite en un ranking 100% justo. Y cada día nace una criatura única que no volverá a repetirse.

**Fecha:** Junio 2026 · **Presupuesto:** orgánico primero, 200–300 € de paid solo si valida · **Mercados:** ES/LATAM + global (EN)

*Basado en el sistema vigente en código (commit `6c23f01`): temporada mensual de ~180 criaturas, tirada diaria del álbum con ~18 destacadas rotatorias, criatura única diaria, pity, ligas semanales. Nota: README y docs/criaturas-imposibles.md describen aún el sistema antiguo de lotes diarios — conviene actualizarlos.*

---

## 1. Resumen ejecutivo

AIGRONS combina dos motores de retención probados: el **hábito diario** (tirada gratis + destacado rotatorio + criatura única del día + racha) y el **objetivo de medio plazo** (completar el álbum de la temporada antes de que acabe el mes — psicología de álbum Panini). A eso se suman fricción cero (web/PWA, sin descarga), contenido generado por IA (gancho de prensa y TikTok) y ranking justo sin pay-to-win (gancho de Reddit).

La estrategia tiene dos ritmos:

1. **Ritmo diario (viralidad):** convertir la tirada diaria y la criatura única del día en momentos compartibles. La única diaria es el FOMO perfecto y honesto: *si nadie la reclama hoy, no volverá a nacer.*
2. **Ritmo mensual (eventos):** cada cambio de temporada (día 1 de mes) es un beat de marketing gratuito y recurrente: "season premiere" del nuevo álbum, y la última semana del mes, la campaña "completa tu álbum".

**Secuencia:** (1) preparar el juego para viralidad → (2) landing + soft launch ES a mitad de temporada → (3) lanzamiento global EN sincronizado con el estreno de una temporada (día 1) con Product Hunt + Reddit + prensa indie → (4) hábito y retención con contenido automatizado.

---

## 2. Posicionamiento y mensajes

### Mensaje principal
**ES:** «Cada temporada, un álbum de criaturas que no existían. Cada día, una tirada gratis y una criatura única que no volverá a nacer.»
**EN:** "Every season, an album of creatures that never existed. Every day, a free pull — and a unique creature that will never be born again."

### Pilares de mensaje (por orden de fuerza)
1. **Completa el álbum** — ~180 especies nuevas por temporada. El coleccionismo de álbum (Panini, Pokédex) es un driver universal con fecha límite natural: el fin de la temporada.
2. **La única del día** — cada día nace una criatura irrepetible. FOMO honesto, perfecto para contenido diario y para el hábito de volver.
3. **Justo de verdad** — todos juegan con el mismo álbum. El ranking mide habilidad, no cartera. Anti-gacha, anti pay-to-win. (Mensaje clave para Reddit/HN.)
4. **2 minutos, cero fricción** — navegador, una mano, sin tutorial, sin descarga.
5. **IA como creadora, no como gimmick** — la IA diseña el álbum de cada temporada: nombre, lore, stats y arte. "Un diseñador de criaturas infinito."

### Qué NO decir
- No liderar con "juego hecho con IA" en comunidades gamer (hostilidad al AI-art). Liderar con álbum + justicia competitiva; transparencia total sobre la IA en FAQ.
- No prometer "gacha" ni vocabulario de casino. Somos lo contrario.
- No prometer que las criaturas del álbum "desaparecen a medianoche" — eso era el sistema antiguo. Lo efímero ahora es: el destacado del día, la única diaria y el cierre de temporada.

### Taglines candidatos
- ES: «Un álbum imposible cada temporada.» / «La criatura de hoy no volverá a nacer.»
- EN: "An impossible album every season." / "Today's creature will never be born again."

---

## 3. Audiencias

| Segmento | Dónde está | Mensaje gancho |
|---|---|---|
| Jugadores de dailies (Wordle, Connections) | Twitter/X, TikTok, prensa generalista | "Tu tirada diaria + la criatura única de hoy" |
| Coleccionistas casual (Pokémon, TCG, Panini) | TikTok, YouTube Shorts | "Completa el álbum de la temporada: 180 especies que no existían" |
| Indie/web gamers | Reddit (r/WebGames, r/incremental_games), HN, itch.io | "Sin descarga, sin P2W, motor determinista, ranking justo" |
| Curiosos de IA generativa | HN, Twitter/X tech, Product Hunt | "Pipeline que diseña, ilustra y balancea un álbum de 180 criaturas cada mes" |

Primario: 18–40, móvil, ratos muertos. ES/LATAM primero (el juego ya está en español), global después.

---

## 4. Cambios recomendados en el juego (pre-lanzamiento)

Ordenados por impacto en crecimiento. P0 = bloqueante para lanzar.

### P0 — Compartir la tirada diaria y la única del día (el "cuadrado de Wordle" de AIGRONS)
Al reclamar el daily (y especialmente la única o una Legendaria/Prismática), botón "Compartir" con texto+emoji copiable e imagen del sprite:

```
AIGRONS · Temporada junio 🧬
Hoy me ha tocado: ✨GLACIARPE (Épica)
Álbum: 64/180 ▓▓▓▓▓░░░░ 36%
🔥 Racha: 12 días
aigrons.com
```

- La **barra de progreso del álbum** es la pieza clave: comunica el juego entero en una línea y pica a completar.
- Imagen PNG del sprite con marco de rareza para TikTok/IG stories.
- Compartir también al completar hitos del álbum (50%, 100%) y al cazar la única del día.

### P0 — Probar sin registrarse
Cuenta anónima/invitada automática (device-id) con la tirada diaria jugable al instante; pedir Apple/Google solo para guardar progreso/ranking. Cada pantalla de login antes de jugar mata >50% de la conversión.

### P0 — Localización EN
UI + generación de nombres/lore en inglés (cambio de prompt + i18n del cliente). Sin esto no hay Product Hunt ni Reddit global.

### P0 — Resolver el Puzzle Diario
El cliente lo anuncia (flag activo) pero el backend no implementa `/puzzle`. Decidir ya: implementarlo (es el formato share tipo Wordle perfecto y el cliente ya está hecho) o desactivar el flag antes de que llegue tráfico. Recomendado: desactivar para el soft launch, implementar para el lanzamiento global.

### P1 — Álbum público de la temporada (SEO + curiosidad)
Página pública `aigrons.com/season` con el álbum del mes (y archivo de temporadas pasadas) + página propia con OG-image para la única de cada día. Cada criatura compartida es un anuncio; contenido SEO infinito autogenerado con cadencia mensual.

### P1 — Referidos simples
"Invita a un amigo → ambos recibís 1 tirada extra cuando reclame su primer daily." Techo diario para evitar abuso. Encaja con la economía existente.

### P1 — Captura del momento "nacimiento"
La animación de nacimiento es el momento más TikTokeable. Botón "guardar vídeo/GIF" tras la animación (o al menos imagen del sprite con marco de rareza + nombre + lore).

### P2 — Notificación/recordatorio
PWA push (o email opcional): "Tu tirada de hoy te espera — y la única del día no volverá a nacer." Driver nº 1 de retención D1→D7. Variante de fin de temporada: "Quedan 5 días para completar el álbum de junio."

### P2 — Racha visible estilo Duolingo
Ya existe racha; subirla a la home con contador prominente y aviso de "racha en peligro".

### P2 — Teaser automático del destacado de mañana
Publicar cada noche en X/Discord las siluetas o pistas del destacado de mañana → contenido diario gratis y razón para seguir las cuentas.

### Higiene — Actualizar README y doc de diseño
Siguen describiendo lotes diarios de 400. Cualquier periodista o colaborador que los lea recibirá el mensaje equivocado.

---

## 5. Landing page (`/landing`)

Inspirada en las landings actuales de juegos top (Balatro, Hades II): hero a pantalla completa, logo grande, una línea de pitch, CTA único y secciones cortas muy visuales.

### Estructura
1. **Hero:** fondo animado neón-pixel, logo AIGRONS, contador "el destacado de hoy rota en HH:MM:SS", CTA «Jugar gratis ahora». Badge "Álbum nuevo cada temporada · una criatura única cada día".
2. **Criaturas vivas:** sprites pixel-art generados proceduralmente en el canvas de la landing (mismo ADN visual del juego).
3. **Cómo se juega:** 3 pasos (Reclama del álbum → Combate 2 min → Sube en el ranking).
4. **Screenshots reales:** galería con placeholders (`landing/assets/screenshots/`).
5. **Modos:** Criatura Única del Día, Mazmorra, Jefe Mundial, PvP en vivo, Arena Sellada, Némesis.
6. **Manifiesto fair-play:** "Nunca pay-to-win".
7. **FAQ** (transparencia IA incluida) + footer con socials.

Bilingüe ES/EN con selector. SEO + OG tags completos.

### Dominio
Comprar `aigrons.com` (+ `.app` si está libre, ~15–25 €). PWA en `play.aigrons.com`, landing en la raíz.

---

## 6. Estrategia de contenido por canal

Regla general: **el juego genera el contenido solo** — la única diaria da material todos los días y el cambio de temporada da un evento todos los meses. Coste marginal ~0.

### TikTok / YouTube Shorts / IG Reels (canal nº 1)
- **Serie diaria "La única de hoy"** (30–45 s): nacimiento + nombre + lore con voz + "si nadie la reclama hoy, no volverá a nacer". Grabar 7 en una sesión semanal.
- **Mensual "Season premiere":** el día 1, vídeo presentando las 5 legendarias del nuevo álbum.
- **Última semana del mes:** "¿Cuánto te falta del álbum?" + recopilación de las mejores criaturas de la temporada.
- **Formato reacción:** "La IA ha diseñado ESTO para la temporada de julio".
- **Hooks probados:** "Este Pokémon no existe… y solo nace hoy", "Un juego donde pagar no te hace ganar", "El álbum Panini de los monstruos imposibles".
- Cadencia: 1/día ideal, mínimo 4/semana. ES y EN en cuentas separadas o subtitulado dual.

### Twitter/X + Bluesky (automatizable)
- Bot diario a las 00:05: la criatura única del día + el destacado de hoy. 100% automatizado desde el job nocturno (el servidor ya tiene los datos).
- Hilo mensual del estreno de temporada con las legendarias del álbum.
- Retuitear los shares de los jugadores.

### Reddit (lanzamientos puntuales, no spam)
- r/WebGames, r/incremental_games, r/AndroidGaming, r/iosgaming, r/playmygame, r/IndieDev (devlog): post honesto de desarrollador: "He hecho un coleccionable de álbum por temporadas donde nadie puede pagar por ganar — la IA diseña 180 criaturas nuevas cada mes". Responder todos los comentarios el día del post.
- ES: r/es, r/videojuegos, Discords hispanos.
- Anticipar la objeción AI-art: transparencia total (pipeline, filtro de calidad, sprites procedurales/IA desde el día 0).

### Discord (comunidad propia)
- Servidor desde el día 1: #unica-de-hoy (autopost), #presume-tu-legendaria, #album-de-temporada, #ranking, #feedback. Rol "Fundador" permanente para los primeros 100 usuarios (coste 0, lealtad enorme).

### Product Hunt + Hacker News (lanzamiento global EN, día 1 de temporada)
- PH: ángulo "AI designs a 180-creature album every season — fair-ranked daily battles, no downloads". GIFs del nacimiento.
- HN (Show HN): ángulo técnico — motor determinista compartido cliente/servidor, pipeline IA con filtro de visión, combate validado en servidor. Blog post: "How AIGRONS generates a balanced 180-creature album every month".

### Prensa / creadores indie
- Kit de prensa en la landing (logo, GIFs, screenshots, fact sheet). Pitch a medios ES (Vandal, 3DJuegos indie, Nivel Oculto), newsletters indie EN (GameDiscoverCo), YouTubers de juegos raros/IA.
- Ángulo de historia: "el juego que rediseña su álbum entero cada temporada".

### itch.io
- Subir como juego HTML5 jugable/enlazado: tráfico indie gratuito, reviews tempranas y backlinks.

---

## 7. Calendario (8 semanas, alineado con temporadas)

Hoy es 12 de junio: el lanzamiento global se alinea con el estreno de la **temporada de agosto (1 de agosto)**; el soft launch ES corre durante julio.

| Semana | Foco | Acciones clave |
|---|---|---|
| 1–2 (jun) | **Preparar viralidad** | Share de tirada/única con barra de álbum (P0), invitado sin registro (P0), i18n EN (P0), decidir puzzle (P0). Dominio. Cuentas sociales + Discord. Actualizar README/docs. |
| 3 (1 jul) | **Soft launch ES con la temporada de julio** | Landing live. Post en 2–3 comunidades ES + Discords hispanos. 50–100 jugadores. Medir D1, % share, bugs. |
| 4 | **Iterar** | Arreglar fricciones. Álbum público /season (P1). Referidos (P1). Empezar TikTok diario ES. |
| 5–6 | **Preparar global** | Blog técnico. Kit de prensa. TikTok EN. Pulir con datos del soft launch. |
| 7 (1 ago) | **Lanzamiento global = season premiere** | Product Hunt + Show HN + Reddit EN en oleada de 3 días con el álbum de agosto recién estrenado. |
| 8 | **Amplificar y paid test** | Push/recordatorios (P2). Pitch a newsletters/YouTubers con métricas. Test de 200–300 € en TikTok Ads SOLO si D7 ≥ 12% y % share ≥ 15%. |

---

## 8. Presupuesto (200–300 €)

| Partida | Coste | Cuándo |
|---|---|---|
| Dominio aigrons.com (+.app) | 20–30 € | Semana 1 |
| TikTok Ads test (creativo = mejor orgánico) | 150–200 € | Semana 8, solo si retención valida |
| CapCut Pro / herramienta edición (1–2 meses) | 0–25 € | Semana 4 |
| Reserva (boost PH, micro-influencer ES) | 50 € | Flexible |

Hosting (Railway/VPS) y Gemini free tier se asumen cubiertos. **No gastar en ads antes de validar retención: comprar tráfico haci