// =============================================================================
// engine.js — MOTOR COMPARTIDO Y DETERMINISTA de AIGRONS.
//
// Fuente ÚNICA de verdad para la lógica de juego: constantes, generación de
// plantillas y combate. Se usa en TRES sitios y debe ser idéntico en todos:
//   - El navegador (web/index.html lo carga con <script> -> window.ENGINE).
//   - El servidor (server/src/{config,combat,generator}.js lo re-exportan).
//   - Los tests (node --test los carga con require()).
//
// Al ser un solo archivo, el invariante del README ("la lógica del cliente y
// server/src/config.js deben ser idénticas") se cumple POR CONSTRUCCIÓN: no hay
// copias que mantener sincronizadas. El test de paridad lo verifica igualmente.
//
// El combate es determinista dado (equipoA, equipoB, seed, decisiones): toda la
// aleatoriedad sale de mulberry32(seed). El servidor recalcula para conceder
// recompensas (anti-trampa): el cliente nunca declara "he ganado".
// =============================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  else root.ENGINE = api; // navegador -> window.ENGINE
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // --------------------------- Tipos y efectividad ---------------------------
  // 20 tipos. Las criaturas pueden tener 1 o 2 (ver genTemplate).
  const TYPES = [
    "VOLCAN", "NIEBLA", "CRISTAL", "RELOJ", "VACIO", "BESTIA", "PLANTA", "TORMENTA",
    "METAL", "HUESO", "SOMBRA", "LUMEN", "HIELO", "MAREA", "ARENA", "TOXICO",
    "ECO", "RUNA", "PLUMA", "HONGO",
  ];

  // Efectividad en ANILLO: cada tipo es fuerte (×1.5) contra los 2 siguientes y
  // débil (×0.75) contra los 2 anteriores. Balanceado: nadie domina.
  const STRONG = {};
  TYPES.forEach((t, i) => { STRONG[t] = [TYPES[(i + 1) % TYPES.length], TYPES[(i + 2) % TYPES.length]]; });

  function typeMult(att, def) {
    if (STRONG[att] && STRONG[att].includes(def)) return 1.5;
    if (STRONG[def] && STRONG[def].includes(att)) return 0.75;
    return 1.0;
  }
  // Efectividad del tipo del atacante contra un defensor de 1 o 2 tipos: producto
  // de la efectividad contra cada tipo del defensor (estilo Pokémon dual).
  function typeEff(attType, defTypes) {
    const arr = Array.isArray(defTypes) ? defTypes : [defTypes];
    return arr.reduce((m, dt) => m * typeMult(attType, dt), 1);
  }
  // Tipos de una unidad/plantilla como array [primario, (secundario)].
  function typesOf(x) { return x.types && x.types.length ? x.types : [x.type]; }

  const RARITIES = ["COMUN", "RARA", "EPICA", "LEGENDARIA"];
  const RARITY_PROB = [0.6, 0.25, 0.12, 0.03];

  // Clase de cada tipo: decide si sus golpes son FÍSICOS (atkP vs defP) o
  // ESPECIALES (atkS vs defS). 4 físicos / 4 especiales.
  const TYPE_CLASS = {
    // Físicos (10)
    VOLCAN: "P", BESTIA: "P", PLANTA: "P", CRISTAL: "P", METAL: "P",
    HUESO: "P", HIELO: "P", ARENA: "P", PLUMA: "P", HONGO: "P",
    // Especiales (10)
    NIEBLA: "S", RELOJ: "S", VACIO: "S", TORMENTA: "S", SOMBRA: "S",
    LUMEN: "S", MAREA: "S", TOXICO: "S", ECO: "S", RUNA: "S",
  };
  const isPhysical = (type) => TYPE_CLASS[type] !== "S";

  // 6 stats: HP, ATK Físico, ATK Especial, DEF Física, DEF Especial, SPD.
  const RANGES = {
    COMUN: { hp: [600, 800], atkP: [80, 110], atkS: [80, 110], defP: [40, 60], defS: [40, 60], spd: [70, 90] },
    RARA: { hp: [750, 950], atkP: [100, 135], atkS: [100, 135], defP: [55, 80], defS: [55, 80], spd: [80, 100] },
    EPICA: { hp: [900, 1150], atkP: [125, 160], atkS: [125, 160], defP: [70, 100], defS: [70, 100], spd: [90, 115] },
    LEGENDARIA: { hp: [1100, 1400], atkP: [150, 200], atkS: [150, 200], defP: [90, 130], defS: [90, 130], spd: [100, 130] },
  };

  // Arquetipo por TIPO: multiplicadores que dan FORMA distinta a cada tipo sin
  // romper el balance. Presupuesto fijo: hp+atk+defP+defS+spd = 5.00 en TODOS
  // (suben unos stats a costa de otros). `atk` se aplica al ataque relevante
  // (atkP en físicos, atkS en especiales) y al otro por coherencia visual.
  const TYPE_STATS = {
    // --- Físicos ---
    VOLCAN:   { hp: 1.05, atk: 1.20, defP: 0.95, defS: 0.85, spd: 0.95 }, // pegador
    BESTIA:   { hp: 1.20, atk: 1.10, defP: 1.00, defS: 0.90, spd: 0.80 }, // bruiser corpulento
    PLANTA:   { hp: 1.20, atk: 0.85, defP: 1.05, defS: 1.05, spd: 0.85 }, // tanque de sustain
    CRISTAL:  { hp: 1.00, atk: 0.85, defP: 1.25, defS: 1.10, spd: 0.80 }, // muro físico
    METAL:    { hp: 1.10, atk: 0.90, defP: 1.25, defS: 1.00, spd: 0.75 }, // blindaje lento
    HUESO:    { hp: 0.95, atk: 1.20, defP: 0.95, defS: 0.85, spd: 1.05 }, // atacante frágil
    HIELO:    { hp: 1.05, atk: 0.90, defP: 1.05, defS: 1.15, spd: 0.85 }, // control resistente
    ARENA:    { hp: 1.15, atk: 0.90, defP: 1.10, defS: 1.00, spd: 0.85 }, // aguante terroso
    PLUMA:    { hp: 0.85, atk: 1.05, defP: 0.90, defS: 0.90, spd: 1.30 }, // veloz de cristal
    HONGO:    { hp: 1.20, atk: 0.85, defP: 1.00, defS: 1.10, spd: 0.85 }, // regenerador
    // --- Especiales ---
    NIEBLA:   { hp: 0.90, atk: 1.10, defP: 0.85, defS: 0.95, spd: 1.20 }, // evasivo
    RELOJ:    { hp: 0.95, atk: 1.05, defP: 0.85, defS: 0.90, spd: 1.25 }, // tempo veloz
    VACIO:    { hp: 0.90, atk: 1.25, defP: 0.85, defS: 0.95, spd: 1.05 }, // nuker de cristal
    TORMENTA: { hp: 0.90, atk: 1.20, defP: 0.85, defS: 0.95, spd: 1.10 }, // nuker veloz
    SOMBRA:   { hp: 0.90, atk: 1.15, defP: 0.90, defS: 0.90, spd: 1.15 }, // asesino
    LUMEN:    { hp: 1.15, atk: 0.90, defP: 1.00, defS: 1.10, spd: 0.85 }, // soporte resistente
    MAREA:    { hp: 1.15, atk: 0.95, defP: 1.00, defS: 1.05, spd: 0.85 }, // sustain marino
    TOXICO:   { hp: 1.10, atk: 1.05, defP: 0.95, defS: 1.00, spd: 0.90 }, // desgaste
    ECO:      { hp: 0.90, atk: 1.25, defP: 0.85, defS: 0.95, spd: 1.05 }, // nuker resonante
    RUNA:     { hp: 1.05, atk: 0.85, defP: 1.05, defS: 1.25, spd: 0.80 }, // muro especial
  };
  // Aplica el arquetipo del tipo a un bloque de 6 stats (in place) y lo devuelve.
  function applyTypeBias(base, type) {
    const p = TYPE_STATS[type];
    if (!p) return base;
    base.hp = Math.round(base.hp * p.hp);
    base.atkP = Math.max(1, Math.round(base.atkP * p.atk));
    base.atkS = Math.max(1, Math.round(base.atkS * p.atk));
    base.defP = Math.max(1, Math.round(base.defP * p.defP));
    base.defS = Math.max(1, Math.round(base.defS * p.defS));
    base.spd = Math.max(1, Math.round(base.spd * p.spd));
    return base;
  }

  // --------------------------------- Habilidades -----------------------------
  const ABILITIES = {
    ERUPCION_LENTA: { name: "Erupción", cost: 3, kind: "dmg", mult: 2.2, ignoreDef: 0.5 },
    MURO_CRISTAL: { name: "Muro", cost: 2, kind: "buffDef", amt: 0.6, turns: 2, self: true },
    NIEBLA_DENSA: { name: "Niebla", cost: 2, kind: "critDown", amt: 0.4, turns: 2 },
    ROBO_DE_TIEMPO: { name: "Doble Acto", cost: 3, kind: "double" },
    COLAPSO_VACIO: { name: "Colapso", cost: 4, kind: "aoe", mult: 1.5 },
    FRENESI_BESTIA: { name: "Frenesí", cost: 3, kind: "buffAtk", amt: 0.5, defDown: 0.2, self: true },
    RAICES: { name: "Raíces", cost: 2, kind: "heal", amt: 0.25, self: true },
    RAYO: { name: "Rayo", cost: 3, kind: "dmg", mult: 2.0, crit: true },
    ESCUDO_EQUIPO: { name: "Escudo", cost: 4, kind: "buffDef", amt: 0.3, turns: 2, team: true },
    MARCA_FATAL: { name: "Marca", cost: 2, kind: "mark", amt: 0.3, turns: 3 },
    REGENERAR: { name: "Regenerar", cost: 3, kind: "healTeam", amt: 0.15 },
    SACRIFICIO: { name: "Sacrificio", cost: 4, kind: "dmg", mult: 3.5, selfHp: 0.2 },
    // --- Habilidades nuevas (reusan efectos del motor) ---
    TAJO: { name: "Tajo", cost: 3, kind: "dmg", mult: 2.5 },
    LLAMARADA: { name: "Llamarada", cost: 3, kind: "dmg", mult: 1.9, crit: true },
    AVALANCHA: { name: "Avalancha", cost: 3, kind: "aoe", mult: 1.2 },
    CURA_MENOR: { name: "Cura", cost: 2, kind: "heal", amt: 0.18, self: true },
    ALIENTO: { name: "Aliento", cost: 4, kind: "healTeam", amt: 0.2 },
    CORAZA: { name: "Coraza", cost: 2, kind: "buffDef", amt: 0.45, turns: 3, self: true },
    CEGUERA: { name: "Ceguera", cost: 2, kind: "critDown", amt: 0.5, turns: 3 },
    // --- Mecánicas nuevas: DoT, aturdir, escudo, drenar ---
    VENENO: { name: "Veneno", cost: 2, kind: "dot", amt: 0.08, turns: 3 },
    QUEMADURA: { name: "Quemadura", cost: 3, kind: "dot", amt: 0.1, turns: 3 },
    ATURDIR: { name: "Aturdir", cost: 3, kind: "stun", turns: 1 },
    ESCARCHA: { name: "Escarcha", cost: 4, kind: "stun", turns: 1 },
    BARRERA: { name: "Barrera", cost: 2, kind: "shield", amt: 0.3, self: true },
    EGIDA: { name: "Égida", cost: 4, kind: "shield", amt: 0.2, team: true },
    DRENAJE: { name: "Drenaje", cost: 3, kind: "drain", mult: 1.6, drain: 0.5 },
    MORDISCO: { name: "Mordisco", cost: 2, kind: "drain", mult: 1.4, drain: 0.6 },
  };
  // 3-4 habilidades por tipo; genTemplate elige una al azar del pool.
  const ABILITY_BY_TYPE = {
    VOLCAN: ["ERUPCION_LENTA", "LLAMARADA", "QUEMADURA", "TAJO"],
    NIEBLA: ["NIEBLA_DENSA", "CEGUERA", "VENENO", "MARCA_FATAL"],
    CRISTAL: ["MURO_CRISTAL", "BARRERA", "CORAZA", "RAYO"],
    RELOJ: ["ROBO_DE_TIEMPO", "ATURDIR", "MARCA_FATAL", "CEGUERA"],
    VACIO: ["COLAPSO_VACIO", "SACRIFICIO", "DRENAJE", "AVALANCHA"],
    BESTIA: ["FRENESI_BESTIA", "MORDISCO", "TAJO", "SACRIFICIO"],
    PLANTA: ["RAICES", "REGENERAR", "VENENO", "CURA_MENOR"],
    TORMENTA: ["RAYO", "AVALANCHA", "ATURDIR", "LLAMARADA"],
    METAL: ["MURO_CRISTAL", "BARRERA", "CORAZA", "TAJO"],
    HUESO: ["SACRIFICIO", "VENENO", "MORDISCO", "MARCA_FATAL"],
    SOMBRA: ["MARCA_FATAL", "VENENO", "DRENAJE", "ATURDIR"],
    LUMEN: ["RAYO", "EGIDA", "REGENERAR", "LLAMARADA"],
    HIELO: ["ESCARCHA", "MURO_CRISTAL", "CEGUERA", "CORAZA"],
    MAREA: ["REGENERAR", "COLAPSO_VACIO", "ALIENTO", "DRENAJE"],
    ARENA: ["FRENESI_BESTIA", "BARRERA", "TAJO", "QUEMADURA"],
    TOXICO: ["VENENO", "QUEMADURA", "MARCA_FATAL", "DRENAJE"],
    ECO: ["ROBO_DE_TIEMPO", "ATURDIR", "AVALANCHA", "RAYO"],
    RUNA: ["ESCUDO_EQUIPO", "EGIDA", "REGENERAR", "BARRERA"],
    PLUMA: ["ROBO_DE_TIEMPO", "RAICES", "CURA_MENOR", "RAYO"],
    HONGO: ["VENENO", "RAICES", "DRENAJE", "REGENERAR"],
  };

  // --------------------------------- Economía --------------------------------
  const ENERGY_MAX = 5;
  const ENERGY_REGEN_MS = 30 * 60 * 1000;
  const COMBAT_ENERGY_MAX = 6;
  const TURNS_MAX = 60;
  const RELEASE_DUST = { COMUN: 5, RARA: 12, EPICA: 30, LEGENDARIA: 80 };
  // Coste de subir de nivel: curva SUB-LINEAL (raíz) -> ramp suave hasta nivel 100
  // (ej. Nv1: 12✨/60🪙, Nv20: 54/268, Nv50: 85/424, Nv100: 120/600) en vez del
  // antiguo lineal que explotaba (Nv100 = 1000✨/5000🪙).
  const levelCost = (level) => ({ dust: Math.round(12 * Math.sqrt(level)), coins: Math.round(60 * Math.sqrt(level)) });
  const LEVEL_MAX = 100;

  // Ligas
  function computeLeague(lp) {
    return lp >= 700 ? "DIAMANTE" : lp >= 450 ? "PLATINO" : lp >= 250 ? "ORO" : lp >= 100 ? "PLATA" : "BRONCE";
  }

  // ----------------------------- RNG determinista ----------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ----------------------- Nombres / lore (placeholder LLM) ------------------
  // En producción con pipeline IA, name/lore/tags vienen del LLM (ver doc §5.2).
  const PRE = ["Pul", "Gly", "Vor", "Mok", "Zit", "Bru", "Nev", "Tor", "Qua", "Fim", "Lux", "Dra", "Syl", "Geb", "Kor", "Wix"];
  const MID = ["po", "ga", "vo", "mi", "tha", "ru", "ne", "zo", "li", "ka", "mu", "si", "be", "do"];
  const SUF = ["grón", "tarl", "mux", "fél", "gorn", "vix", "talo", "nubo", "crán", "loko", "mir", "zar"];
  const ANIMAL = ["pulpo", "topo", "murciélago", "caracol", "mantis", "sapo", "lince", "cuervo", "erizo", "anguila", "polilla", "escarabajo"];
  const PHENO = ["volcán", "niebla", "cristal", "reloj", "vacío", "tormenta", "musgo", "ceniza", "relámpago", "eclipse", "oxígeno", "plasma"];

  function genName(rng) {
    return PRE[Math.floor(rng() * PRE.length)] + MID[Math.floor(rng() * MID.length)] + SUF[Math.floor(rng() * SUF.length)];
  }
  // Género de los tags (para que los artículos concuerden: "del volcán" pero
  // "de la niebla"). Solo afecta al TEXTO: el consumo de rng no cambia (1 tirada),
  // así que la paridad cliente/servidor se mantiene.
  const FEM_TAGS = { mantis: 1, anguila: 1, polilla: 1, niebla: 1, tormenta: 1, ceniza: 1 };
  const elArt = (w) => (FEM_TAGS[w] ? "la " : "el ") + w;
  const delArt = (w) => (FEM_TAGS[w] ? "de la " : "del ") + w;
  function genLore(rng, tags) {
    const T = [
      (a, b) => `Duerme entre restos ${delArt(b)} hasta que ${elArt(a)} que lleva dentro despierta.`,
      (a, b) => `Nadie ha visto su lado de ${a} sin temblar.`,
      (a, b) => `Se alimenta de ${b} y de malas decisiones.`,
      (a, b) => `Dicen que su espíritu de ${a} predice el clima.`,
      (a, b) => `Coleccionable desde el primer amanecer ${delArt(b)}.`,
    ];
    const t = T[Math.floor(rng() * T.length)];
    return t(tags[0], tags[1]);
  }
  const pickRange = (rng, r) => Math.round(r[0] + rng() * (r[1] - r[0]));

  // Escalado por nivel (+4%/nivel)
  const scaled = (base, level) => Math.round(base * (1 + 0.04 * (level - 1)));

  // Fecha local YYYY-MM-DD
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // -------------------- Generación determinista de plantilla -----------------
  // El orden de llamadas a rng() es un INVARIANTE (ver README §3.1):
  // rareza -> tipo -> tags(2) -> habilidad -> nombre(3) -> hp/atkP/atkS/defP/defS/spd(6) -> lore(1).
  function genTemplate(id) {
    const rng = mulberry32(hashStr(id));

    const r = rng();
    let rarity = "COMUN", acc = 0;
    for (let i = 0; i < RARITIES.length; i++) {
      acc += RARITY_PROB[i];
      if (r < acc) { rarity = RARITIES[i]; break; }
    }

    const type = TYPES[Math.floor(rng() * TYPES.length)];
    // 40% de probabilidad de un SEGUNDO tipo (distinto del primero).
    const types = [type];
    if (rng() < 0.4) { const t2 = TYPES[Math.floor(rng() * TYPES.length)]; if (t2 !== type) types.push(t2); }
    const tags = [ANIMAL[Math.floor(rng() * ANIMAL.length)], PHENO[Math.floor(rng() * PHENO.length)]];
    const pool = ABILITY_BY_TYPE[type];
    const ability = pool[Math.floor(rng() * pool.length)];
    const name = genName(rng);
    const rg = RANGES[rarity];
    const base_stats = applyTypeBias({
      hp: pickRange(rng, rg.hp),
      atkP: pickRange(rng, rg.atkP), atkS: pickRange(rng, rg.atkS),
      defP: pickRange(rng, rg.defP), defS: pickRange(rng, rg.defS),
      spd: pickRange(rng, rg.spd),
    }, type);
    const lore = genLore(rng, tags);

    return { id, type, types, rarity, name, tags, base_stats, ability, lore, art_seed: hashStr(id) };
  }

  // Lote de un día: ids "<fecha>_NNNN", deterministas.
  function dailyBatch(date, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(genTemplate(date + "_" + String(i).padStart(4, "0")));
    return out;
  }

  // ============================ TEMPORADA (mensual) ==========================
  // El catálogo coleccionable (el "álbum") es MENSUAL, no diario: un lote grande
  // (~180) que cambia cada mes. Cada mes se identifica por su día 1 ("clave de
  // temporada"), que actúa como batch_date en BD. Sobre ese álbum estable rota un
  // subconjunto DESTACADO diario (highlights) que alimenta puzzle/mazmorra/arena/
  // oráculo y pondera el huevo/tiradas. Todo determinista -> paridad por fecha.
  const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  // Clave de temporada = primer día del mes de `date` ("YYYY-MM-01").
  function seasonKey(date) {
    const s = (date || todayStr()).slice(0, 7);
    return s + "-01";
  }
  // Etiqueta legible: "junio 2026".
  function seasonLabel(date) {
    const s = (date || todayStr());
    const y = s.slice(0, 4), m = parseInt(s.slice(5, 7), 10) - 1;
    return MESES_ES[m] + " " + y;
  }

  // EVENTO temático del día (retención + algo que comentar). Determinista por
  // fecha, así que cliente y servidor lo derivan igual. Antes vivía en el job;
  // aquí es la fuente única (el job la re-exporta como eventFor por compat).
  //   Sábado : "Sábado de <TIPO>" — el destacado del día sesga hacia ese tipo.
  //   Domingo: "Domingo Legendario" — ≥2 legendarias garantizadas en el destacado.
  function dailyEvent(date) {
    const d = new Date(date + "T00:00:00");
    const dow = d.getDay();
    if (dow === 6) {
      const t = TYPES[hashStr("event:" + date) % TYPES.length];
      return { kind: "type", type: t, share: 0.4, name: "Sábado de " + t, emoji: "🔥" };
    }
    if (dow === 0) return { kind: "legendary", min: 2, name: "Domingo Legendario", emoji: "👑" };
    return null;
  }

  // Compone el álbum de una temporada por CUPOS de rareza (curva 60/25/12/3,
  // README §6): escanea ids deterministas "<seasonKey>_NNNN" hasta clavar la
  // curva. Sin sesgo de evento (eso es flavor diario, no del álbum estable).
  function composeSeason(sKey, n) {
    const want = {
      LEGENDARIA: Math.max(2, Math.round(n * 0.03)),
      EPICA: Math.max(2, Math.round(n * 0.12)),
      RARA: Math.max(2, Math.round(n * 0.25)),
    };
    want.COMUN = Math.max(0, n - want.LEGENDARIA - want.EPICA - want.RARA);
    const out = [], picked = { COMUN: 0, RARA: 0, EPICA: 0, LEGENDARIA: 0 };
    for (let i = 0; i < n * 16 && out.length < n; i++) {
      const t = genTemplate(sKey + "_" + String(i).padStart(4, "0"));
      if (picked[t.rarity] >= want[t.rarity]) continue;
      out.push(t); picked[t.rarity]++;
    }
    return out;
  }

  // Subconjunto DESTACADO del día: k criaturas del álbum `list`, deterministas
  // por fecha y sesgadas por el evento. Devuelve plantillas (subconjunto de list).
  function dailyHighlights(date, list, k) {
    if (!list || !list.length) return [];
    k = Math.min(k || 0, list.length);
    const rng = mulberry32(hashStr("hl:" + date) >>> 0);
    const idxs = list.map((_, i) => i);
    for (let i = idxs.length - 1; i > 0; i--) { // Fisher-Yates determinista
      const j = Math.floor(rng() * (i + 1));
      const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t;
    }
    let order = idxs;
    const ev = dailyEvent(date);
    if (ev && ev.kind === "type") {
      const want = Math.round(k * (ev.share || 0.4));
      const typed = [], rest = [];
      for (const i of idxs) (((list[i].types || [list[i].type]).includes(ev.type)) ? typed : rest).push(i);
      order = typed.slice(0, want).concat(rest, typed.slice(want));
    } else if (ev && ev.kind === "legendary") {
      const minL = ev.min || 2, legs = [], rest = [];
      for (const i of idxs) ((list[i].rarity === "LEGENDARIA") ? legs : rest).push(i);
      order = legs.slice(0, minL).concat(rest, legs.slice(minL));
    }
    return order.slice(0, k).map((i) => list[i]);
  }

  // La criatura ÚNICA del día (exclusiva, pieza de "caza"/FOMO): id determinista.
  function dailyUniqueId(date) { return "uniq_" + (date || todayStr()); }
  function dailyUnique(date) { return genTemplate(dailyUniqueId(date)); }

  // ================================ COMBATE =================================
  // Una unidad de combate. `tpl` lleva { id, name, type, ability, base_stats }.
  function buildUnit(tpl, level, team, idx) {
    const s = tpl.base_stats;
    return {
      uid: team + idx,
      tplId: tpl.id,
      name: tpl.name,
      type: tpl.type,
      types: tpl.types && tpl.types.length ? tpl.types.slice() : [tpl.type],
      ability: tpl.ability,
      level: level,
      hpMax: scaled(s.hp, level), hp: scaled(s.hp, level),
      atkP: scaled(s.atkP, level), atkS: scaled(s.atkS, level),
      defP: scaled(s.defP, level), defS: scaled(s.defS, level),
      spd: scaled(s.spd, level),
      energy: 0, team,
      atkMul: 1, defMul: 1, atkTurns: 0, defTurns: 0,
      critDownTurns: 0, critDownAmt: 0, markTurns: 0, markAmt: 0,
      guarding: false, poisonTurns: 0, poisonAmt: 0, stunTurns: 0, shield: 0, mods: {},
    };
  }
  // Construye una unidad a partir de stats ya escalados (snapshot/publicUnit).
  // `s.startEnergy` permite que la estancia Defensiva empiece con energía (capitán+estancia).
  function unitFromStats(s, team, idx) {
    return {
      uid: team + idx,
      tplId: s.tplId, name: s.name, type: s.type, types: s.types && s.types.length ? s.types.slice() : [s.type], ability: s.ability,
      level: s.level || 1,
      hpMax: s.hpMax, hp: s.hpMax, atkP: s.atkP, atkS: s.atkS, defP: s.defP, defS: s.defS, spd: s.spd,
      energy: s.startEnergy || 0, team,
      atkMul: 1, defMul: 1, atkTurns: 0, defTurns: 0,
      critDownTurns: 0, critDownAmt: 0, markTurns: 0, markAmt: 0,
      guarding: false, poisonTurns: 0, poisonAmt: 0, stunTurns: 0, shield: 0, mods: {},
    };
  }

  // --------------------- Capitán + estancia (decisión previa) ----------------
  // Modificadores DETERMINISTAS que se hornean en los stats de un equipo antes de
  // congelar la oferta de combate (el servidor los aplica; el motor de combate ni
  // se entera). El capitán da liderazgo al equipo y un bono personal; la estancia
  // inclina el equipo a ataque o defensa (y la defensiva arranca con energía).
  const STANCES = {
    NEUTRAL: { atk: 1.0, def: 1.0, startEnergy: 0 },
    AGRESIVA: { atk: 1.15, def: 0.9, startEnergy: 0 },
    DEFENSIVA: { atk: 0.92, def: 1.15, startEnergy: 1 },
  };
  const LEADERSHIP = { atk: 1.06, def: 1.06 }; // a todo el equipo si hay capitán
  const CAPTAIN_SELF = 1.15;                   // +15% a stats del capitán

  // Muta `units` (atk/def/hpMax/spd/startEnergy) según capitán + estancia.
  function applyCaptainStance(units, captainUid, stance) {
    const st = STANCES[stance] || STANCES.NEUTRAL;
    const hasCaptain = units.some((u) => u.uid === captainUid);
    const lead = hasCaptain ? LEADERSHIP : { atk: 1, def: 1 };
    units.forEach((u) => {
      const isCap = u.uid === captainUid;
      const capSelf = isCap ? CAPTAIN_SELF : 1;
      const am = st.atk * lead.atk * capSelf, dm = st.def * lead.def * capSelf;
      u.atkP = Math.round(u.atkP * am); u.atkS = Math.round(u.atkS * am);
      u.defP = Math.round(u.defP * dm); u.defS = Math.round(u.defS * dm);
      if (isCap) { u.hpMax = Math.round(u.hpMax * CAPTAIN_SELF); u.hp = u.hpMax; u.spd = Math.round(u.spd * CAPTAIN_SELF); }
      u.startEnergy = (u.startEnergy || 0) + st.startEnergy;
      u.energy = u.startEnergy;
    });
    return units;
  }

  // ATK/DEF efectivos según la CLASE del atacante: físico usa atkP/defP, especial atkS/defS.
  const effAtk = (u) => (isPhysical(u.type) ? u.atkP : u.atkS) * u.atkMul;
  const effDef = (att, tgt) => (isPhysical(att.type) ? tgt.defP : tgt.defS) * tgt.defMul;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const alive = (arr) => arr.filter((u) => u.hp > 0);
  function pickTarget(foes) {
    const a = alive(foes);
    if (!a.length) return null;
    return a.sort((x, y) => x.hp / x.hpMax - y.hp / y.hpMax)[0];
  }

  // Reducción de daño al estar en guardia (mecánica de proteger).
  const GUARD_REDUCTION = 0.6; // recibe 60% del daño
  // Multiplicador global de daño directo: ajusta la DURACIÓN media del combate
  // (~10-15 rondas) sin tocar el balance relativo (tipos, defensa, arquetipos).
  const DAMAGE_SCALE = 1.6;
  // Objetivo efectivo de un golpe de objetivo único: una unidad enemiga EN GUARDIA
  // intercepta el golpe (protege a sus aliados); si no, el objetivo deseado (si vive)
  // o, en su defecto, el de menor HP%. Los AoE no se redirigen (golpean a todos).
  function resolveTarget(desiredUid, foes) {
    const guards = alive(foes).filter((f) => f.guarding);
    if (guards.length) return guards.sort((a, b) => (a.uid < b.uid ? -1 : 1))[0];
    if (desiredUid) { const t = foes.find((f) => f.uid === desiredUid && f.hp > 0); if (t) return t; }
    return pickTarget(foes);
  }

  // Devuelve { tgt, dmg, crit, typeM, guarded } para que la UI pueda animar el golpe.
  function dealDamage(rng, att, tgt, mult, opt) {
    opt = opt || {};
    const am = att.mods || {}, tm = tgt.mods || {};
    const defv = effDef(att, tgt) * (1 - (opt.ignoreDef || 0));
    const typeM = typeEff(att.type, typesOf(tgt)); // tipo primario del atacante vs ambos tipos del defensor
    // Reliquia: +crítico (CRISTAL_AFILADO). mods por defecto 0 => combate normal intacto.
    const critP = clamp(0.05 + (att.spd - tgt.spd) / 1000 - (tgt.critDownTurns > 0 ? tgt.critDownAmt : 0) + (am.critBonus || 0), 0.02, 0.5);
    const crit = opt.crit || rng() < critP;
    const critM = crit ? 1.8 : 1;
    const markM = tgt.markTurns > 0 ? 1 + tgt.markAmt : 1;
    const guardM = tgt.guarding ? GUARD_REDUCTION : 1;
    // Constante de armadura ESCALADA por nivel: así la mitigación 100/(100+def) es
    // invariante al nivel (atk, def y armorK suben igual) -> el combate dura las
    // mismas rondas a cualquier nivel (no se eterniza a nivel alto).
    const armorK = 100 * (1 + 0.04 * (((tgt.level || 1)) - 1));
    const raw = Math.max(1, Math.round(effAtk(att) * mult * typeM * critM * markM * guardM * DAMAGE_SCALE * (armorK / (armorK + defv))));
    // Escudo/barrera: absorbe daño antes de tocar el HP.
    let dmg = raw, shielded = false;
    if (tgt.shield > 0) { const ab = Math.min(tgt.shield, dmg); tgt.shield -= ab; dmg -= ab; shielded = ab > 0; }
    tgt.hp = Math.max(0, tgt.hp - dmg);
    // Reliquia: robo de vida (VAMPIRISMO) y espinas que reflejan daño (ESPINAS).
    if (am.lifesteal) att.hp = Math.min(att.hpMax, att.hp + Math.round(dmg * am.lifesteal));
    if (tm.thorns && dmg > 0) att.hp = Math.max(0, att.hp - Math.round(dmg * tm.thorns));
    return { tgt, dmg, crit, typeM, guarded: tgt.guarding, shielded };
  }

  // Se ejecuta al inicio de la acción propia: la guardia dura desde que se declara
  // hasta el siguiente turno propio (protege durante los turnos rivales intermedios).
  function decBuffs(u) {
    if (u.atkTurns > 0) { u.atkTurns--; if (u.atkTurns === 0) u.atkMul = 1; }
    if (u.defTurns > 0) { u.defTurns--; if (u.defTurns === 0) u.defMul = 1; }
    if (u.critDownTurns > 0) u.critDownTurns--;
    if (u.markTurns > 0) u.markTurns--;
    if (u.guarding) u.guarding = false;
  }
  // Estados al inicio del turno de la unidad (tras decBuffs): aplica DAÑO POR TURNO
  // (veneno/quemadura, ignora defensa) y consume ATURDIMIENTO. Devuelve {poison, stunned}.
  function tickStatus(u) {
    let poison = 0;
    if (u.poisonTurns > 0) { poison = Math.max(1, Math.round(u.hpMax * u.poisonAmt)); u.hp = Math.max(0, u.hp - poison); u.poisonTurns--; }
    let stunned = false;
    if (u.hp > 0 && u.stunTurns > 0) { stunned = true; u.stunTurns--; }
    return { poison, stunned };
  }

  const OVERCHARGE_EXTRA = 2;   // energía extra para sobrecargar
  const OVERCHARGE_MULT = 1.5;  // efecto ×1.5 al sobrecargar

  // Ejecuta la acción de una unidad según su `intent`:
  //   { type: 'ability' | 'guard' | 'basic', target?: uid, overcharge?: bool }
  // Devuelve un `action` con detalle de golpes para animar. El consumo de rng es
  // idéntico para los mismos efectos (la sobrecarga/guardia no añaden llamadas rng
  // salvo las propias de cada golpe).
  function performAction(rng, u, intent, mine, foes) {
    intent = intent || { type: "basic" };
    const ab = ABILITIES[u.ability];
    const action = { uid: u.uid, name: u.name, ability: null, guard: false, overcharge: false, hits: [] };

    // GUARDIA: protege a los aliados este turno (intercepta golpes de objetivo único).
    if (intent.type === "guard") {
      u.guarding = true;
      action.guard = true;
      return action;
    }

    const wantAbility = intent.type === "ability";
    if (wantAbility && u.energy >= ab.cost) {
      // Reliquia: sobrecarga más barata (SOBRECARGA_EFICIENTE) -> mods.overchargeExtra.
      const extra = u.mods && u.mods.overchargeExtra != null ? u.mods.overchargeExtra : OVERCHARGE_EXTRA;
      const oc = !!intent.overcharge && u.energy >= ab.cost + extra;
      u.energy -= oc ? ab.cost + extra : ab.cost;
      action.ability = ab.name;
      action.overcharge = oc;
      const M = oc ? OVERCHARGE_MULT : 1; // multiplicador de sobrecarga (daño/cura)
      switch (ab.kind) {
        case "dmg": {
          const t = resolveTarget(intent.target, foes);
          if (t) {
            if (ab.selfHp) u.hp = Math.max(1, u.hp - Math.round(u.hpMax * ab.selfHp));
            action.hits.push(dealDamage(rng, u, t, ab.mult * M, { ignoreDef: ab.ignoreDef, crit: ab.crit }));
          }
          break;
        }
        case "aoe":
          alive(foes).forEach((t) => action.hits.push(dealDamage(rng, u, t, ab.mult * M, {})));
          break;
        case "buffDef":
          (ab.team ? alive(mine) : [u]).forEach((x) => { x.defMul = 1 + ab.amt; x.defTurns = ab.turns; });
          break;
        case "buffAtk":
          u.atkMul = 1 + ab.amt; u.atkTurns = 99;
          if (ab.defDown) { u.defMul = 1 - ab.defDown; u.defTurns = 99; }
          break;
        case "critDown": { const t = resolveTarget(intent.target, foes); if (t) { t.critDownTurns = ab.turns; t.critDownAmt = ab.amt; } break; }
        case "mark": { const t = resolveTarget(intent.target, foes); if (t) { t.markTurns = ab.turns; t.markAmt = ab.amt; } break; }
        case "heal": u.hp = Math.min(u.hpMax, u.hp + Math.round(u.hpMax * ab.amt * M)); break;
        case "healTeam": alive(mine).forEach((x) => (x.hp = Math.min(x.hpMax, x.hp + Math.round(x.hpMax * ab.amt * M)))); break;
        case "double": {
          const a = resolveTarget(intent.target, foes); if (a) action.hits.push(dealDamage(rng, u, a, M, {}));
          const b = resolveTarget(intent.target, foes); if (b) action.hits.push(dealDamage(rng, u, b, M, {}));
          break;
        }
        case "dot": { const t = resolveTarget(intent.target, foes); if (t) { t.poisonTurns = ab.turns; t.poisonAmt = ab.amt; action.statusTgt = t.uid; } break; }
        case "stun": { const t = resolveTarget(intent.target, foes); if (t) { t.stunTurns = ab.turns; action.statusTgt = t.uid; } break; }
        case "shield": (ab.team ? alive(mine) : [u]).forEach((x) => { x.shield = (x.shield || 0) + Math.round(x.hpMax * ab.amt * M); }); break;
        case "drain": {
          const t = resolveTarget(intent.target, foes);
          if (t) { const h = dealDamage(rng, u, t, ab.mult * M, {}); action.hits.push(h); u.hp = Math.min(u.hpMax, u.hp + Math.round(h.dmg * (ab.drain || 0.5))); }
          break;
        }
      }
    } else {
      const t = resolveTarget(intent.target, foes);
      if (t) action.hits.push(dealDamage(rng, u, t, 1, {}));
    }
    return action;
  }

  // IA del rival: decide su `intent`. Determinista (la guardia no consume rng).
  //   - Guarda si un aliado distinto está muy tocado (<25% HP), ella está sana
  //     (>50%) y su habilidad aún no está cargada.
  //   - Si no, lanza la habilidad en cuanto puede salvo golpes de 1 objetivo, que
  //     reserva si hay >=2 enemigos vivos con >50% HP (consume 1 rng en ese caso).
  function aiIntent(rng, u, foes, allies) {
    const ab = ABILITIES[u.ability];
    const weakAlly = alive(allies).some((a) => a !== u && a.hp / a.hpMax < 0.25);
    if (weakAlly && u.hp / u.hpMax > 0.5 && u.energy < ab.cost) return { type: "guard" };
    if (u.energy >= ab.cost) {
      const strong = alive(foes).filter((x) => x.hp / x.hpMax > 0.5).length;
      if (ab.kind === "dmg" && strong >= 2 && ab.cost >= 3) return rng() < 0.5 ? { type: "ability" } : { type: "basic" };
      return { type: "ability" };
    }
    return { type: "basic" };
  }

  // Orden de turno determinista: mayor SPD primero; empate -> equipo A antes que B.
  function turnOrder(teamA, teamB) {
    return alive(teamA.concat(teamB)).sort((a, b) => b.spd - a.spd || (a.team < b.team ? -1 : 1));
  }

  // Construye el `intent` a partir de una decisión { action, target, overcharge }.
  // d ausente -> ataque básico (objetivo auto).
  function intentFromDecision(d) {
    if (!d) return { type: "basic" };
    if (d.action === "guard") return { type: "guard" };
    if (d.action === "attack") return { type: "basic", target: d.target }; // básico focalizado
    return { type: "ability", target: d.target, overcharge: !!d.overcharge };
  }

  // Ejecuta UN turno completo (todas las unidades vivas actúan una vez por turnOrder),
  // mutando los equipos. Cada unidad usa su decisión de `dmap` si la tiene; si no:
  //   - equipo A -> ataque básico (compat PvE: el jugador siempre manda decisiones)
  //   - equipo B -> aiIntent (PvE) ... salvo que tenga decisión (PvP: humano).
  // Devuelve { log, done }. Fuente única usada por resolveBattle (PvE/batch) y por
  // el orquestador PvP (ronda a ronda, autoritativo).
  function stepTurn(teamA, teamB, rng, dmap, turn) {
    const log = [];
    const order = turnOrder(teamA, teamB);
    for (const u of order) {
      if (u.hp <= 0) continue;
      decBuffs(u);
      u.energy = Math.min(COMBAT_ENERGY_MAX, u.energy + 1);
      const st = tickStatus(u); // veneno/quemadura + aturdimiento
      const mine = u.team === "A" ? teamA : teamB;
      const foes = u.team === "A" ? teamB : teamA;
      let action;
      if (u.hp <= 0) {
        action = { uid: u.uid, name: u.name, ability: null, guard: false, hits: [], poison: st.poison, died: true };
      } else if (st.stunned) {
        action = { uid: u.uid, name: u.name, stunned: true, hits: [], poison: st.poison };
      } else {
        const d = dmap && dmap.get(turn + ":" + u.uid);
        let intent;
        if (d) intent = intentFromDecision(d);
        else if (u.team === "B") intent = aiIntent(rng, u, foes, mine);
        else intent = { type: "basic" };
        action = performAction(rng, u, intent, mine, foes);
        action.poison = st.poison;
      }
      log.push(Object.assign({ turn }, action));
      if (!alive(teamA).length || !alive(teamB).length) break;
    }
    const done = !alive(teamA).length || !alive(teamB).length || turn >= TURNS_MAX;
    return { log, done };
  }

  // Resolución completa y autoritativa (PvE/batch). `decisions` = [{ turn, uid,
  // action?, target?, overcharge? }]. Para PvP, las decisiones incluyen AMBOS equipos.
  function resolveBattle(teamA, teamB, seed, decisions) {
    const rng = mulberry32(seed >>> 0);
    const dmap = new Map((decisions || []).map((d) => [d.turn + ":" + d.uid, d]));
    const log = [];
    let turn = 0;
    while (alive(teamA).length && alive(teamB).length && turn < TURNS_MAX) {
      turn++;
      const r = stepTurn(teamA, teamB, rng, dmap, turn);
      for (const e of r.log) log.push(e);
      if (r.done) break;
    }
    const hpA = alive(teamA).reduce((s, u) => s + u.hp, 0);
    const hpB = alive(teamB).reduce((s, u) => s + u.hp, 0);
    const winner = alive(teamA).length && (!alive(teamB).length || hpA >= hpB) ? "A" : "B";
    return { winner, turns: turn, log, hpA, hpB, survivorsA: alive(teamA).length, survivorsB: alive(teamB).length };
  }

  // Equipo rival reconstruible SOLO desde el seed (cliente y servidor coinciden).
  function botTeamFromSeed(seed, templates, level) {
    const rng = mulberry32((seed ^ 0xb07e11) >>> 0);
    const units = [];
    for (let i = 0; i < 3; i++) {
      const tpl = templates[Math.floor(rng() * templates.length)];
      const lvl = Math.max(1, level + (Math.floor(rng() * 3) - 1));
      units.push(buildUnit(tpl, lvl, "B", i));
    }
    return units;
  }

  // ===================== MECÁNICAS INNOVADORAS (deterministas) ===============
  // Todas derivan de la SEMILLA del día (o de un id), así que cliente y servidor
  // calculan EXACTAMENTE lo mismo sin comunicarse. El servidor sigue siendo la
  // autoridad (revalida con el motor); esto solo evita duplicar fórmulas.

  // -- Variantes PRISMÁTICAS: 1% determinista por instancia (cosmético) --------
  function isPrismatic(instanceId) {
    if (!instanceId) return false;
    return (hashStr("prism:" + instanceId) % 100) === 0; // 1%
  }
  // Paleta alternativa: rota los canales RGB de forma determinista (cambio de
  // matiz vistoso y barato) — solo afecta al render, nunca a stats.
  function prismaticShift(hex, instanceId) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return hex;
    const v = parseInt(m[1], 16);
    let r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    const rot = hashStr("prismhue:" + instanceId) % 3;
    if (rot === 0) { const t = r; r = g; g = b; b = t; }
    else if (rot === 1) { const t = r; r = b; b = g; g = t; }
    const boost = (c) => Math.min(255, Math.round(c * 1.15 + 12));
    return "#" + [boost(r), boost(g), boost(b)].map((c) => c.toString(16).padStart(2, "0")).join("");
  }

  // -- VALORES INDIVIDUALES (IV): cada CAPTURA es única ---------------------
  // Deriva un pequeño ajuste por stat (±6%) de forma DETERMINISTA del
  // instance_id (UUID único por captura). No se guarda nada: cliente y servidor
  // lo recalculan igual -> paridad por construcción. "Potencial" = media 0..100.
  const IV_STATS = ["hp", "atkP", "atkS", "defP", "defS", "spd"];
  const IV_SPREAD = 0.06; // ±6%
  function ivFor(instanceId) {
    if (!instanceId) return null;
    const mult = {}; let sum = 0;
    for (const s of IV_STATS) {
      const roll = (hashStr("iv:" + s + ":" + instanceId) % 1000) / 999; // 0..1
      mult[s] = 1 - IV_SPREAD + roll * (IV_SPREAD * 2);                   // 0.94..1.06
      sum += roll;
    }
    return { mult, potential: Math.round((sum / IV_STATS.length) * 100) };
  }
  // Aplica los IV a unas base_stats (devuelve copia; sin instanceId, sin cambios).
  function applyIV(base, instanceId) {
    const iv = ivFor(instanceId); if (!iv || !base) return base;
    const out = {};
    for (const k in base) out[k] = Math.max(1, Math.round(base[k] * (iv.mult[k] || 1)));
    return out;
  }

  // -- SHINY ÁUREA: variante MUY rara (~0,25%) por encima de la prismática.
  // Determinista por instancia. La prismática (1%) sigue siendo la variante
  // "común-rara"; la áurea es el premio gordo (cosmético, no toca stats).
  function isShiny(instanceId) {
    if (!instanceId) return false;
    return (hashStr("shiny:" + instanceId) % 400) === 0; // ~0,25%
  }
  // Variante cosmética efectiva (áurea manda sobre prismática): "aurea" | "prismatica" | null.
  function variantOf(instanceId) {
    if (isShiny(instanceId)) return "aurea";
    if (isPrismatic(instanceId)) return "prismatica";
    return null;
  }

  // -- PUZZLE diario: equipo + enemigos FIJOS del lote de hoy, iguales para todos.
  function dailyPuzzle(date, templates) {
    const seed = hashStr("puzzle:" + date) >>> 0;
    const rng = mulberry32(seed);
    const ids = templates.map((t) => t.id || t.template_id);
    const pick = () => ids[Math.floor(rng() * ids.length)];
    const team = [pick(), pick(), pick()];
    const enemy = [pick(), pick(), pick()];
    const level = 8 + (seed % 6); // 8..13, igual para ambos lados (combate justo)
    return { date, seed, team, enemy, level };
  }

  // -- NÉMESIS: counter-pick determinista contra los TIPOS de tu equipo.
  function nemesisTeam(userId, week, myTypes, templates) {
    const seed = hashStr("nemesis:" + userId + ":" + week) >>> 0;
    const rng = mulberry32(seed);
    const counters = templates.filter((t) => {
      const tt = t.types || [t.type];
      return tt.some((a) => (myTypes || []).some((d) => typeMult(a, d) > 1));
    });
    const pool = counters.length >= 3 ? counters : templates;
    const out = [], used = {};
    for (let i = 0; i < 3 && pool.length; i++) {
      let idx = Math.floor(rng() * pool.length), guard = 0;
      while (used[idx] && guard++ < 20) idx = Math.floor(rng() * pool.length);
      used[idx] = 1; out.push(pool[idx]);
    }
    return out;
  }
  function nemesisName(userId) {
    const A = ["Vex", "Mor", "Zarn", "Kael", "Drix", "Nyx", "Grom", "Sael"];
    const B = ["maldur", "thrax", "vorn", "geist", "luk", "rakh", "dien", "mor"];
    const h = hashStr("nemname:" + userId) >>> 0;
    return A[h % A.length] + B[(h >>> 8) % B.length];
  }

  // -- ORÁCULO: profecía determinista del lote de MAÑANA (pista verídica, críptica).
  function oracleProphecy(date, templates) {
    const seed = hashStr("oracle:" + date) >>> 0;
    const rng = mulberry32(seed);
    const counts = {};
    templates.forEach((t) => (t.types || [t.type]).forEach((ty) => (counts[ty] = (counts[ty] || 0) + 1)));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const domType = top ? top[0] : TYPES[seed % TYPES.length];
    const legendary = templates.filter((t) => t.rarity === "LEGENDARIA").length;
    const VERBS = ["despierta", "se alza", "susurra", "arde", "se quiebra", "renace"];
    const OMENS = ["los veloces caerán", "el metal llorará", "tres sombras danzarán",
      "la marea cambiará", "lo común brillará", "el tiempo se doblará"];
    const v = VERBS[Math.floor(rng() * VERBS.length)];
    const o = OMENS[Math.floor(rng() * OMENS.length)];
    return { date, text: `Cuando ${domType.toLowerCase()} ${v}, ${o}…`, hint: { domType, legendary } };
  }

  // ============================ ROGUELIKE / MAZMORRA =========================
  // Reliquias: modificadores pasivos que se acumulan durante una run. Unos se
  // hornean en stats (stat), otros son flags que el combate lee (mods), otros
  // actúan a nivel de run entre nodos (run, gestionado por el servidor).
  const RELICS = {
    CRISTAL_AFILADO:      { name: "Cristal Afilado",  emoji: "🔪", desc: "+10% prob. crítico",              mods: { critBonus: 0.10 } },
    BATERIA:              { name: "Batería",          emoji: "🔋", desc: "+1⚡ inicial en cada combate",    stat: { startEnergy: 1 } },
    COLMILLO_VAMPIRICO:   { name: "Colmillo Vampírico", emoji: "🩸", desc: "Cura 10% del daño que haces",   mods: { lifesteal: 0.10 } },
    ESPINAS:              { name: "Espinas",          emoji: "🌵", desc: "Refleja 15% del daño recibido",  mods: { thorns: 0.15 } },
    CORAZON_TITAN:        { name: "Corazón de Titán", emoji: "❤️", desc: "+12% HP máximo",                  stat: { hpMult: 1.12 } },
    TOTEM_FURIA:          { name: "Tótem de Furia",   emoji: "😡", desc: "+12% ATK",                        stat: { atkMult: 1.12 } },
    MURALLA:              { name: "Muralla",          emoji: "🧱", desc: "+15% DEF",                        stat: { defMult: 1.15 } },
    NUCLEO_EFICIENTE:     { name: "Núcleo Eficiente", emoji: "⚡", desc: "La sobrecarga cuesta solo +1⚡",  mods: { overchargeExtra: 1 } },
    BOTIQUIN:             { name: "Botiquín",         emoji: "🧰", desc: "Cura 20% del equipo tras cada nodo", run: { healAfter: 0.20 } },
    AMULETO_ORO:          { name: "Amuleto de Oro",   emoji: "🪙", desc: "+50% monedas por nodo",           run: { coinMult: 0.5 } },
  };

  // Agrega los efectos de combate de las reliquias al equipo (muta atk/def/hpMax/
  // startEnergy y rellena u.mods). NO toca u.hp (el HP se arrastra en la run).
  function applyRelics(units, relicIds) {
    const counts = {}; (relicIds || []).forEach((id) => (counts[id] = (counts[id] || 0) + 1));
    let hpMult = 1, atkMult = 1, defMult = 1, startEnergy = 0;
    const mods = { critBonus: 0, lifesteal: 0, thorns: 0, overchargeExtra: OVERCHARGE_EXTRA };
    for (const id in counts) {
      const r = RELICS[id]; if (!r) continue;
      for (let k = 0; k < counts[id]; k++) {
        if (r.stat) {
          if (r.stat.hpMult) hpMult *= r.stat.hpMult;
          if (r.stat.atkMult) atkMult *= r.stat.atkMult;
          if (r.stat.defMult) defMult *= r.stat.defMult;
          if (r.stat.startEnergy) startEnergy += r.stat.startEnergy;
        }
        if (r.mods) {
          if (r.mods.critBonus) mods.critBonus += r.mods.critBonus;
          if (r.mods.lifesteal) mods.lifesteal += r.mods.lifesteal;
          if (r.mods.thorns) mods.thorns += r.mods.thorns;
          if (r.mods.overchargeExtra != null) mods.overchargeExtra = Math.min(mods.overchargeExtra, r.mods.overchargeExtra);
        }
      }
    }
    units.forEach((u) => {
      u.hpMax = Math.round(u.hpMax * hpMult);
      u.atkP = Math.round(u.atkP * atkMult); u.atkS = Math.round(u.atkS * atkMult);
      u.defP = Math.round(u.defP * defMult); u.defS = Math.round(u.defS * defMult);
      u.startEnergy = (u.startEnergy || 0) + startEnergy;
      u.energy = u.startEnergy;
      u.mods = Object.assign({}, mods);
    });
    return units;
  }
  // Efectos de reliquia a nivel de run (curación/monedas entre nodos).
  function relicRunEffects(relicIds) {
    let healAfter = 0, coinMult = 1;
    (relicIds || []).forEach((id) => {
      const r = RELICS[id];
      if (r && r.run) { if (r.run.healAfter) healAfter += r.run.healAfter; if (r.run.coinMult) coinMult += r.run.coinMult; }
    });
    return { healAfter, coinMult };
  }

  // ----------------------- Generación determinista de la run -----------------
  const DUNGEON_DEPTH = 8; // nodos hasta el jefe (incluido)
  // Dificultades elegibles: nivel BASE FIJO de los enemigos (sube con profundidad/
  // élite/jefe sobre esa base) y multiplicador de recompensa. El jugador elige.
  const DUNGEON_DIFFICULTIES = {
    FACIL:     { label: "Fácil",     level: 10,  coinMult: 1.0 },
    NORMAL:    { label: "Normal",    level: 30,  coinMult: 1.6 },
    DIFICIL:   { label: "Difícil",   level: 50,  coinMult: 2.5 },
    EXPERTO:   { label: "Experto",   level: 75,  coinMult: 3.5 },
    PESADILLA: { label: "Pesadilla", level: 100, coinMult: 5.0 },
  };
  const dungeonDiff = (id) => DUNGEON_DIFFICULTIES[id] || DUNGEON_DIFFICULTIES.NORMAL;
  function dgnRng(seed, depth, salt) { return mulberry32(hashStr("dgn:" + seed + ":" + depth + ":" + (salt || "")) >>> 0); }

  // Dos opciones de nodo en cada profundidad (la última es el JEFE).
  function dungeonNodeOptions(seed, depth) {
    if (depth >= DUNGEON_DEPTH - 1) return [{ type: "JEFE" }];
    const rng = dgnRng(seed, depth, "opt");
    // Pools que garantizan poder avanzar (siempre hay combate disponible).
    const pool = depth % 3 === 2 ? ["ELITE", "TIENDA", "DESCANSO"] : ["COMBATE", "COMBATE", "ELITE", "DESCANSO", "TIENDA"];
    const a = pool[Math.floor(rng() * pool.length)];
    let b = pool[Math.floor(rng() * pool.length)];
    if (b === a) b = pool[(pool.indexOf(a) + 1) % pool.length];
    return [{ type: a }, { type: b }];
  }

  // Equipo enemigo de un nodo de combate (escala con la profundidad y el tipo).
  // Rarezas permitidas para los enemigos según la profundidad (curva de dificultad):
  // comunes al principio, épicas/legendarias en el tramo final y el jefe.
  function dungeonRarities(depth) {
    if (depth <= 2) return ["COMUN"];
    if (depth <= 4) return ["COMUN", "RARA"];
    if (depth <= 6) return ["RARA", "EPICA"];
    return ["EPICA", "LEGENDARIA"];
  }
  // Nivel enemigo en un nodo: RAMPA dentro de la run. Empieza muy por debajo del
  // nivel de referencia de la dificultad (~25%) y sube hasta superarlo (~120% en
  // el jefe): un equipo flojo puede ganar 1-2 nodos pero no pasarse la mazmorra,
  // y la dificultad "de verdad" llega progresivamente (feedback de jugadores).
  function dungeonLevelAt(baseLevel, depth, kind) {
    const start = Math.max(1, Math.round(baseLevel * 0.25));
    const end = Math.max(start + 1, Math.round(baseLevel * 1.2));
    const ramp = (end - start) / (DUNGEON_DEPTH - 1);
    const bonus = kind === "ELITE" ? 2 : kind === "JEFE" ? 4 : 0;
    return Math.max(1, Math.round(start + depth * ramp) + bonus);
  }

  function dungeonEnemyTeam(seed, depth, kind, templates, baseLevel) {
    const rng = dgnRng(seed, depth, "enemy:" + kind);
    const nodeLevel = dungeonLevelAt(baseLevel, depth, kind);
    const ar = dungeonRarities(depth);
    let pool = templates.filter((t) => ar.includes(t.rarity));
    if (!pool.length) pool = templates;
    const units = [];
    for (let i = 0; i < 3; i++) {
      const tpl = pool[Math.floor(rng() * pool.length)];
      const lvl = Math.max(1, nodeLevel + (Math.floor(rng() * 3) - 1));
      units.push(buildUnit(tpl, lvl, "B", i));
    }
    if (kind === "JEFE") units.forEach((u) => { u.hpMax = Math.round(u.hpMax * 1.4); u.hp = u.hpMax; u.atk = Math.round(u.atk * 1.2); });
    else if (kind === "ELITE") units.forEach((u) => { u.hpMax = Math.round(u.hpMax * 1.15); u.hp = u.hpMax; });
    return units;
  }

  // 3 reliquias ofrecidas tras superar un nodo (deterministas por profundidad).
  function dungeonDraft(seed, depth) {
    const rng = dgnRng(seed, depth, "draft");
    const ids = Object.keys(RELICS);
    const out = [], used = {};
    while (out.length < 3 && Object.keys(used).length < ids.length) {
      const id = ids[Math.floor(rng() * ids.length)];
      if (!used[id]) { used[id] = 1; out.push(id); }
    }
    return out;
  }

  return {
    // constantes
    TYPES, STRONG, RARITIES, RARITY_PROB, RANGES, ABILITIES, ABILITY_BY_TYPE,
    TYPE_STATS, applyTypeBias, TYPE_CLASS, isPhysical, RELICS, DUNGEON_DEPTH, DUNGEON_DIFFICULTIES, dungeonDiff,
    ENERGY_MAX, ENERGY_REGEN_MS, COMBAT_ENERGY_MAX, TURNS_MAX, RELEASE_DUST, LEVEL_MAX,
    // funciones puras
    typeMult, typeEff, typesOf, levelCost, computeLeague, mulberry32, hashStr,
    genName, genLore, pickRange, scaled, todayStr, genTemplate, dailyBatch,
    seasonKey, seasonLabel, dailyEvent, composeSeason, dailyHighlights, dailyUniqueId, dailyUnique,
    // combate
    buildUnit, unitFromStats, applyCaptainStance, STANCES, pickTarget, resolveTarget,
    dealDamage, decBuffs, tickStatus, performAction, aiIntent, turnOrder, stepTurn, intentFromDecision, resolveBattle, botTeamFromSeed,
    // roguelike / mazmorra
    applyRelics, relicRunEffects, dungeonNodeOptions, dungeonEnemyTeam, dungeonDraft, dungeonLevelAt,
    // mecánicas innovadoras (deterministas)
    isPrismatic, prismaticShift, ivFor, applyIV, isShiny, variantOf, dailyPuzzle, nemesisTeam, nemesisName, oracleProphecy,
  };
});
