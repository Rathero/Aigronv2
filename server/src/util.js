// util.js — helpers compartidos del servidor.

// Mapea una fila de creature_templates a las 6 stats base del motor.
// Compatibilidad: si faltan las columnas nuevas (plantillas viejas), usa base_atk/base_def
// para físico y especial por igual (relleno).
function tplBaseStats(r) {
  return {
    hp: r.base_hp,
    atkP: r.base_atk_p != null ? r.base_atk_p : r.base_atk,
    atkS: r.base_atk_s != null ? r.base_atk_s : r.base_atk,
    defP: r.base_def_p != null ? r.base_def_p : r.base_def,
    defS: r.base_def_s != null ? r.base_def_s : r.base_def,
    spd: r.base_spd,
  };
}

module.exports = { tplBaseStats };
