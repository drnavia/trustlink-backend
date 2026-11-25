/**
 * @file scheduleAvailability.js
 * @description Motor puro de disponibilidad y calendario vivo por intervalos (30 o 60 minutos)
 * para TrustLink (Fase 5.4). Normaliza reglas semanales de trabajo por día (Lun–Dom),
 * genera franjas horarias en la zona horaria del usuario (por defecto Argentina UTC-3) y
 * cruza automáticamente bloqueos manuales, trabajos externos, visitas confirmadas y pases QR.
 *
 * Para la vista del Residente soporta proyección libre de datos sensibles (`includeBlockDetails = false`),
 * exponiendo únicamente si cada franja está libre, ocupada o vencida sin revelar clientes externos ni lotes.
 * @location /trustlink-backend/src/utils/scheduleAvailability.js
 */

/** Etiquetas completas en español indexadas por `Date.prototype.getDay()` (`0` = Domingo .. `6` = Sábado). */
const DAY_LABELS_ES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

/** Etiquetas cortas en español indexadas por `0`..`6`. */
const DAY_SHORT_LABELS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Orden de presentación semanal habitual en Argentina (Lunes a Domingo). */
const WEEK_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Jornada semanal por defecto para prestadores que aún no personalizaron sus horarios:
 * Lunes a Viernes de 08:00 a 18:00, Sábado de 09:00 a 13:00 y Domingo no laborable,
 * con franjas cada 30 minutos.
 */
const DEFAULT_WEEKLY_RULES = [
  { day_of_week: 0, is_working: false, start_time: '09:00', end_time: '13:00', slot_minutes: 30 },
  { day_of_week: 1, is_working: true, start_time: '08:00', end_time: '18:00', slot_minutes: 30 },
  { day_of_week: 2, is_working: true, start_time: '08:00', end_time: '18:00', slot_minutes: 30 },
  { day_of_week: 3, is_working: true, start_time: '08:00', end_time: '18:00', slot_minutes: 30 },
  { day_of_week: 4, is_working: true, start_time: '08:00', end_time: '18:00', slot_minutes: 30 },
  { day_of_week: 5, is_working: true, start_time: '08:00', end_time: '18:00', slot_minutes: 30 },
  { day_of_week: 6, is_working: true, start_time: '09:00', end_time: '13:00', slot_minutes: 30 },
];

/**
 * Convierte una cadena horaria `HH:MM` a minutos totales desde las 00:00.
 *
 * @param {string} hhmm - Hora en formato `HH:MM` (ej. `'08:30'`).
 * @returns {number|null} Minutos desde medianoche (`0..1439`) o `null` si el formato es inválido.
 */
function parseTimeToMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

/**
 * Formatea una cantidad de minutos desde las 00:00 en formato `HH:MM` con ceros a la izquierda.
 *
 * @param {number} totalMinutes - Minutos desde medianoche.
 * @returns {string} Cadena `HH:MM`.
 */
function formatMinutesToTime(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Normaliza y valida el arreglo de reglas semanales (7 días) recibido desde el cliente o BD.
 * Garantiza los 7 días (`0..6`), intervalo válido (`30` o `60` min) y `end_time > start_time`
 * en los días marcados como laborables.
 *
 * @param {Array<Object>} rawRules - Reglas enviadas por el prestador.
 * @param {number} [defaultSlotMinutes=30] - Intervalo global por defecto (`30` o `60`).
 * @returns {{ rules: Array<Object>, error: string|null }} Reglas normalizadas o mensaje de error.
 */
function normalizeWeeklyRulesInput(rawRules, defaultSlotMinutes = 30) {
  const safeSlot = Number(defaultSlotMinutes) === 60 ? 60 : 30;
  const byDay = new Map(
    DEFAULT_WEEKLY_RULES.map((r) => [r.day_of_week, { ...r, slot_minutes: safeSlot }])
  );

  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    return { rules: Array.from(byDay.values()), error: null };
  }

  for (const item of rawRules) {
    const dow = Number(item?.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return { rules: [], error: 'Día de semana inválido en la configuración de agenda (debe ser 0..6).' };
    }

    const isWorking = Boolean(item?.is_working);
    const startMin = parseTimeToMinutes(item?.start_time || '08:00');
    const endMin = parseTimeToMinutes(item?.end_time || '18:00');
    const slotMinutes = Number(item?.slot_minutes) === 60 ? 60 : safeSlot;

    if (startMin === null || endMin === null) {
      return {
        rules: [],
        error: `Formato horario inválido para ${DAY_LABELS_ES[dow]} (usá HH:MM, ej. 08:00).`,
      };
    }

    if (isWorking && endMin <= startMin) {
      return {
        rules: [],
        error: `En ${DAY_LABELS_ES[dow]}, la hora de fin debe ser posterior a la hora de inicio.`,
      };
    }

    byDay.set(dow, {
      day_of_week: dow,
      is_working: isWorking,
      start_time: formatMinutesToTime(startMin),
      end_time: formatMinutesToTime(endMin),
      slot_minutes: slotMinutes,
    });
  }

  return {
    rules: WEEK_DISPLAY_ORDER.map((dow) => byDay.get(dow)),
    error: null,
  };
}

/**
 * Combina filas persistidas en `provider_availability_rules` con la jornada semanal por defecto,
 * devolviendo siempre los 7 días en orden Lunes → Domingo con etiquetas en español.
 *
 * @param {Array<Object>} dbRows - Filas recuperadas desde PostgreSQL.
 * @returns {Array<Object>} Arreglo completo de 7 reglas semanales.
 */
function mergeWithDefaultRules(dbRows = []) {
  const map = new Map(DEFAULT_WEEKLY_RULES.map((r) => [r.day_of_week, { ...r }]));
  for (const row of dbRows || []) {
    const dow = Number(row.day_of_week);
    if (Number.isInteger(dow) && dow >= 0 && dow <= 6) {
      map.set(dow, {
        day_of_week: dow,
        is_working: Boolean(row.is_working),
        start_time: String(row.start_time || '08:00').slice(0, 5),
        end_time: String(row.end_time || '18:00').slice(0, 5),
        slot_minutes: Number(row.slot_minutes) === 60 ? 60 : 30,
      });
    }
  }
  return WEEK_DISPLAY_ORDER.map((dow) => ({
    ...map.get(dow),
    day_label: DAY_LABELS_ES[dow],
    short_label: DAY_SHORT_LABELS_ES[dow],
  }));
}

/**
 * Genera un resumen legible de la jornada semanal del prestador para mostrar al residente
 * (ej. `"Lun, Mar, Mié, Jue, Vie 08:00–18:00 · Sáb 09:00–13:00"`).
 *
 * @param {Array<Object>} rules - Reglas semanales normalizadas.
 * @returns {string} Resumen compacto de horarios de atención.
 */
function buildScheduleSummaryText(rules = []) {
  const working = (rules || []).filter((r) => r.is_working);
  if (working.length === 0) return 'Sin días laborables configurados';

  // Agrupar días con exactamente el mismo rango horario
  const groups = [];
  for (const r of working) {
    const rangeKey = `${r.start_time}–${r.end_time}`;
    const existing = groups.find((g) => g.rangeKey === rangeKey);
    const label = DAY_SHORT_LABELS_ES[Number(r.day_of_week)] || '';
    if (existing) {
      existing.days.push(label);
    } else {
      groups.push({ rangeKey, days: [label] });
    }
  }

  return groups.map((g) => `${g.days.join(', ')} ${g.rangeKey}`).join(' · ');
}

/**
 * Convierte una fecha local `YYYY-MM-DD` más minutos locales desde 00:00 a timestamp UTC (ms),
 * aplicando el desfase de zona horaria del usuario (`tzOffsetMinutes` de `Date.getTimezoneOffset()`,
 * ej. `180` para Argentina UTC-3).
 *
 * @param {string} dateStr - Fecha local `YYYY-MM-DD`.
 * @param {number} minutesFromMidnight - Minutos desde 00:00 en hora local.
 * @param {number} [tzOffsetMinutes=180] - Minutos a sumar para pasar de hora local a UTC.
 * @returns {number} Timestamp UTC en milisegundos.
 */
function localDateMinutesToUtcMs(dateStr, minutesFromMidnight, tzOffsetMinutes = 180) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return utcMidnight + (minutesFromMidnight + Number(tzOffsetMinutes || 0)) * 60 * 1000;
}

/**
 * Suma `deltaDays` días calendario a una cadena `YYYY-MM-DD` sin verse afectado por husos horarios.
 *
 * @param {string} dateStr - Fecha base `YYYY-MM-DD`.
 * @param {number} deltaDays - Días a sumar (puede ser negativo).
 * @returns {string} Fecha resultante `YYYY-MM-DD`.
 */
function addCalendarDays(dateStr, deltaDays) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Obtiene la fecha calendario local `YYYY-MM-DD` correspondiente a un instante UTC y un `tzOffsetMinutes`.
 *
 * @param {number} [nowMs=Date.now()] - Instante UTC en milisegundos.
 * @param {number} [tzOffsetMinutes=180] - Desfase `getTimezoneOffset()` (180 = UTC-3).
 * @returns {string} Fecha local `YYYY-MM-DD`.
 */
function getLocalDateString(nowMs = Date.now(), tzOffsetMinutes = 180) {
  const shifted = new Date(nowMs - Number(tzOffsetMinutes || 0) * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parsea un timestamp de bloque de agenda en milisegundos UTC de forma consistente.
 *
 * @param {string|Date} raw - Valor de fecha/hora del bloque.
 * @returns {number} Milisegundos UTC o `NaN` si es inválido.
 */
function parseBlockTimestampMs(raw) {
  if (!raw) return NaN;
  if (raw instanceof Date) return raw.getTime();
  const str = String(raw).trim();
  // Si viene de Postgres sin sufijo Z ni offset, lo interpretamos como UTC (coherente con toISOString())
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str)) {
    return Date.parse(str.replace(' ', 'T') + 'Z');
  }
  return Date.parse(str);
}

/**
 * Construye las franjas horarias (cada 30 o 60 minutos) de un día calendario específico
 * cruzando la jornada semanal configurada con los bloques confirmados de agenda y,
 * únicamente para el prestador (`includeBlockDetails = true`), las solicitudes de potencial
 * visita aún pendientes de confirmación (`tentativeVisits`, sin bloquear todavía para otros residentes).
 *
 * @param {Object} params - Parámetros de generación.
 * @param {string} params.dateStr - Fecha local `YYYY-MM-DD`.
 * @param {Array<Object>} params.rules - Reglas semanales (7 días).
 * @param {Array<Object>} [params.blocks=[]] - Bloques confirmados/manuales de `provider_schedule_blocks`.
 * @param {Array<Object>} [params.tentativeVisits=[]] - Solicitudes pendientes (`pending_provider`/`pending_resident`).
 * @param {number} [params.tzOffsetMinutes=180] - Offset en minutos (180 = Argentina UTC-3).
 * @param {number} [params.nowMs=Date.now()] - Instante actual UTC para marcar franjas pasadas.
 * @param {boolean} [params.includeBlockDetails=false] - `true` para Portal Prestador; `false` para privacidad en Residente.
 * @returns {Object} Resumen del día y arreglo de franjas horarias.
 */
function buildDaySlots({
  dateStr,
  rules,
  blocks = [],
  tentativeVisits = [],
  tzOffsetMinutes = 180,
  nowMs = Date.now(),
  includeBlockDetails = false,
}) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const mergedRules = mergeWithDefaultRules(rules);
  const rule = mergedRules.find((r) => r.day_of_week === dayOfWeek) || mergedRules[0];

  const slotMinutes = Number(rule.slot_minutes) === 60 ? 60 : 30;
  const startMin = parseTimeToMinutes(rule.start_time) ?? 8 * 60;
  const endMin = parseTimeToMinutes(rule.end_time) ?? 18 * 60;

  // Pre-parsear bloques confirmados/manuales una sola vez para cruces O(N)
  const parsedBlocks = (blocks || [])
    .map((b) => ({
      ...b,
      _startMs: parseBlockTimestampMs(b.start_at),
      _endMs: parseBlockTimestampMs(b.end_at),
    }))
    .filter((b) => !Number.isNaN(b._startMs) && !Number.isNaN(b._endMs) && b._endMs > b._startMs);

  // Pre-parsear solicitudes tentativas (mínimo 60 min por defecto contemplando traslado) solo para el prestador
  const parsedTentative = includeBlockDetails
    ? (tentativeVisits || [])
        .map((v) => {
          const sMs = parseBlockTimestampMs(v.preferred_date || v.start_at);
          if (Number.isNaN(sMs)) return null;
          const rawEndMs = parseBlockTimestampMs(v.preferred_end_date || v.end_at);
          const minEndMs = sMs + 60 * 60 * 1000;
          const eMs = !Number.isNaN(rawEndMs) && rawEndMs >= minEndMs ? rawEndMs : minEndMs;
          return {
            ...v,
            _startMs: sMs,
            _endMs: eMs,
          };
        })
        .filter(Boolean)
    : [];

  const slots = [];
  if (rule.is_working && endMin > startMin) {
    for (let cursor = startMin; cursor + slotMinutes <= endMin; cursor += slotMinutes) {
      const slotStartMs = localDateMinutesToUtcMs(dateStr, cursor, tzOffsetMinutes);
      const slotEndMs = localDateMinutesToUtcMs(dateStr, cursor + slotMinutes, tzOffsetMinutes);

      // Priorizar bloques confirmados de TrustLink (pase/visita) sobre manuales
      const overlapping = parsedBlocks.filter(
        (b) => b._startMs < slotEndMs && b._endMs > slotStartMs
      );
      overlapping.sort((a, b) => {
        const weight = (t) =>
          t === 'trustlink_pass' ? 0 : t === 'trustlink_visit' ? 1 : t === 'external_visit' ? 2 : 3;
        return weight(a.block_type) - weight(b.block_type);
      });
      const hitBlock = overlapping[0] || null;

      // Solicitud de potencial visita (solo visible en la agenda del prestador; no bloquea a otros residentes)
      const hitTentative =
        !hitBlock && includeBlockDetails
          ? parsedTentative.find((v) => v._startMs < slotEndMs && v._endMs > slotStartMs) || null
          : null;

      let status = 'available';
      if (hitBlock) {
        status = 'busy';
      } else if (hitTentative) {
        status = 'tentative';
      } else if (slotEndMs <= nowMs) {
        status = 'past';
      }

      const slotEntry = {
        time: formatMinutesToTime(cursor),
        end_time: formatMinutesToTime(cursor + slotMinutes),
        start_iso: new Date(slotStartMs).toISOString(),
        end_iso: new Date(slotEndMs).toISOString(),
        status,
      };

      if (includeBlockDetails && hitBlock) {
        slotEntry.block = {
          id: hitBlock.id,
          block_type: hitBlock.block_type,
          title: hitBlock.title,
          source_ref: hitBlock.source_ref || null,
          start_at: new Date(hitBlock._startMs).toISOString(),
          end_at: new Date(hitBlock._endMs).toISOString(),
          is_manual: !hitBlock.source_ref,
        };
      }

      if (includeBlockDetails && hitTentative) {
        slotEntry.tentative_visit = {
          id: hitTentative.id,
          status: hitTentative.status,
          owner_name: hitTentative.owner_name || 'Residente',
          fraction_number: hitTentative.fraction_number || '',
          lot_number: hitTentative.lot_number || '',
          notes: hitTentative.notes || '',
          start_at: new Date(hitTentative._startMs).toISOString(),
          end_at: new Date(hitTentative._endMs).toISOString(),
        };
      }

      slots.push(slotEntry);
    }
  }

  const availableCount = slots.filter((s) => s.status === 'available').length;
  const busyCount = slots.filter((s) => s.status === 'busy').length;
  const tentativeCount = slots.filter((s) => s.status === 'tentative').length;

  return {
    date: dateStr,
    day_of_week: dayOfWeek,
    day_label: DAY_LABELS_ES[dayOfWeek],
    short_label: DAY_SHORT_LABELS_ES[dayOfWeek],
    is_working: Boolean(rule.is_working),
    start_time: rule.start_time,
    end_time: rule.end_time,
    slot_minutes: slotMinutes,
    available_count: availableCount,
    busy_count: busyCount,
    tentative_count: tentativeCount,
    total_slots: slots.length,
    slots,
  };
}

/**
 * Construye una ventana de varios días consecutivos (por defecto 7 días) con todas sus franjas
 * horarias y el resumen legible de la jornada semanal del prestador.
 *
 * @param {Object} params - Parámetros de proyección multi-día.
 * @param {string} [params.startDateStr] - Fecha local inicial `YYYY-MM-DD` (default hoy).
 * @param {number} [params.days=7] - Cantidad de días a proyectar (1..14).
 * @param {Array<Object>} params.rules - Reglas semanales del prestador.
 * @param {Array<Object>} [params.blocks=[]] - Bloques horarios del prestador.
 * @param {Array<Object>} [params.tentativeVisits=[]] - Solicitudes pendientes visibles como tentativas al prestador.
 * @param {number} [params.tzOffsetMinutes=180] - Offset horario del usuario en minutos.
 * @param {number} [params.nowMs=Date.now()] - Instante actual UTC.
 * @param {boolean} [params.includeBlockDetails=false] - Si expone metadatos de bloques y tentativas (solo prestador).
 * @returns {{ start_date: string, schedule_summary: string, slot_minutes: number, rules: Array<Object>, days: Array<Object> }}
 */
function buildMultiDayAvailability({
  startDateStr,
  days = 7,
  rules,
  blocks = [],
  tentativeVisits = [],
  tzOffsetMinutes = 180,
  nowMs = Date.now(),
  includeBlockDetails = false,
}) {
  const safeDays = Math.max(1, Math.min(14, Number(days) || 7));
  const baseDate =
    /^\d{4}-\d{2}-\d{2}$/.test(String(startDateStr || ''))
      ? String(startDateStr)
      : getLocalDateString(nowMs, tzOffsetMinutes);

  const mergedRules = mergeWithDefaultRules(rules);
  const slotMinutes = Number(mergedRules[0]?.slot_minutes) === 60 ? 60 : 30;
  const projectedDays = [];

  for (let i = 0; i < safeDays; i += 1) {
    const currentDate = addCalendarDays(baseDate, i);
    projectedDays.push(
      buildDaySlots({
        dateStr: currentDate,
        rules: mergedRules,
        blocks,
        tentativeVisits,
        tzOffsetMinutes,
        nowMs,
        includeBlockDetails,
      })
    );
  }

  return {
    start_date: baseDate,
    schedule_summary: buildScheduleSummaryText(mergedRules),
    slot_minutes: slotMinutes,
    rules: mergedRules,
    days: projectedDays,
  };
}

module.exports = {
  DAY_LABELS_ES,
  DAY_SHORT_LABELS_ES,
  WEEK_DISPLAY_ORDER,
  DEFAULT_WEEKLY_RULES,
  parseTimeToMinutes,
  formatMinutesToTime,
  normalizeWeeklyRulesInput,
  mergeWithDefaultRules,
  buildScheduleSummaryText,
  localDateMinutesToUtcMs,
  addCalendarDays,
  getLocalDateString,
  parseBlockTimestampMs,
  buildDaySlots,
  buildMultiDayAvailability,
};
