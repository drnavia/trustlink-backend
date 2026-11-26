/**
 * @file complianceExpiry.js
 * @description Helper centralizado para evaluar vencimientos documentales obligatorios
 * (Antecedentes Penales con ventana configurable por barrio de 30/90/180/365 días desde fecha de emisión,
 * Póliza ART / Seguro de Accidentes Personales y ART de ayudantes de cuadrilla)
 * al emitir pases QR o validarlos en garita / API externa.
 * @location /trustlink-backend/src/utils/complianceExpiry.js
 */

/** Ventanas oficiales permitidas por comunidad para la antigüedad máxima de Antecedentes Penales. */
const ALLOWED_CRIMINAL_WINDOW_DAYS = [30, 90, 180, 365];

/** Ventana estándar de la red cuando un barrio no define una política distinta. */
const DEFAULT_CRIMINAL_WINDOW_DAYS = 180;

/**
 * Normaliza la ventana de vigencia de Antecedentes Penales de una comunidad.
 * @param {number|string|null|undefined} rawDays - Días configurados en `countries.criminal_record_max_age_days`.
 * @returns {number} Ventana válida (`30`, `90`, `180` o `365`).
 */
function normalizeCriminalWindowDays(rawDays) {
  const num = Number(rawDays);
  if (ALLOWED_CRIMINAL_WINDOW_DAYS.includes(num)) return num;
  return DEFAULT_CRIMINAL_WINDOW_DAYS;
}

/**
 * Normaliza una fecha `DATE`, cadena ISO o instancia `Date` al formato `YYYY-MM-DD` (UTC).
 * Si el valor es nulo, vacío o inválido devuelve `null`.
 * @param {string|Date|null|undefined} rawDate - Fecha original proveniente de DB o payload.
 * @returns {string|null} Fecha normalizada `YYYY-MM-DD` o `null`.
 */
function toIsoDateOnly(rawDate) {
  if (!rawDate) return null;
  if (typeof rawDate === 'string') {
    const trimmed = rawDate.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }
  const parsed = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Suma una cantidad de días calendario a una fecha `YYYY-MM-DD` (UTC) y devuelve `YYYY-MM-DD`.
 * @param {string|Date|null|undefined} rawDate - Fecha base de emisión.
 * @param {number} days - Cantidad de días a sumar.
 * @returns {string|null} Fecha resultante `YYYY-MM-DD` o `null`.
 */
function addDaysToIsoDate(rawDate, days) {
  const iso = toIsoDateOnly(rawDate);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Calcula la fecha efectiva de vencimiento de Antecedentes Penales:
 * - Si existe `criminalRecordIssuedAt` (modelo N3 con fecha de emisión), aplica `issuedAt + maxAgeDays`.
 * - En registros heredados sin `issuedAt`, utiliza `criminalRecordExpiry` directamente.
 *
 * @param {object} params
 * @param {string|Date|null|undefined} [params.criminalRecordIssuedAt]
 * @param {string|Date|null|undefined} [params.criminalRecordExpiry]
 * @param {number|null|undefined} [params.maxAgeDays]
 * @returns {string|null} Fecha efectiva de vencimiento `YYYY-MM-DD` o `null`.
 */
function computeEffectiveCriminalRecordExpiry({
  criminalRecordIssuedAt = null,
  criminalRecordExpiry = null,
  maxAgeDays = DEFAULT_CRIMINAL_WINDOW_DAYS,
} = {}) {
  if (criminalRecordIssuedAt) {
    return addDaysToIsoDate(criminalRecordIssuedAt, normalizeCriminalWindowDays(maxAgeDays));
  }
  return toIsoDateOnly(criminalRecordExpiry);
}

/**
 * Devuelve la fecha de referencia actual en formato `YYYY-MM-DD` (UTC).
 * @param {Date} [referenceDate] - Fecha base opcional (útil para pruebas unitarias determinísticas).
 * @returns {string} Fecha `YYYY-MM-DD`.
 */
function getTodayIsoDate(referenceDate = new Date()) {
  return referenceDate.toISOString().slice(0, 10);
}

/**
 * Indica si una fecha de vencimiento ya caducó estrictamente antes del día actual (`< hoy`).
 * Un documento que vence hoy sigue siendo válido durante toda la jornada; si no hay fecha
 * cargada devuelve `false` para preservar compatibilidad con perfiles históricos sin vencimiento.
 * @param {string|Date|null|undefined} rawDate - Fecha de vencimiento a evaluar.
 * @param {Date} [referenceDate] - Fecha de referencia (por defecto, ahora).
 * @returns {boolean} `true` si el documento está vencido.
 */
function isExpiryDatePassed(rawDate, referenceDate = new Date()) {
  const iso = toIsoDateOnly(rawDate);
  if (!iso) return false;
  return iso < getTodayIsoDate(referenceDate);
}

/**
 * Evalúa secuencialmente si existe alguna infracción por documentación vencida del prestador
 * o de los ayudantes incluidos en el pase (incluyendo la ventana de Antecedentes del barrio).
 *
 * @param {object} [params]
 * @param {string|Date|null|undefined} [params.criminalRecordIssuedAt] - Fecha de emisión de antecedentes (N3).
 * @param {string|Date|null|undefined} [params.criminalRecordExpiry] - Vencimiento directo/heredado de antecedentes.
 * @param {number|null|undefined} [params.criminalRecordMaxAgeDays] - Ventana de días configurada por el barrio.
 * @param {string|Date|null|undefined} [params.insuranceExpiry] - Vencimiento de Seguro AP / Póliza ART.
 * @param {Array<{id?: number, full_name?: string, insurance_expiry?: string|Date|null}>} [params.authorizedEmployees]
 * @param {'create'|'gate'} [params.context]
 * @param {Date} [params.referenceDate]
 * @returns {null|{code: string, field: string, expiry_date: string, employee_name?: string, message: string}}
 */
function findComplianceExpiryViolation({
  criminalRecordIssuedAt = null,
  criminalRecordExpiry = null,
  criminalRecordMaxAgeDays = DEFAULT_CRIMINAL_WINDOW_DAYS,
  insuranceExpiry = null,
  authorizedEmployees = [],
  context = 'gate',
  referenceDate = new Date(),
} = {}) {
  const prefix =
    context === 'create'
      ? 'No se puede emitir el pase QR:'
      : 'Ingreso bloqueado en garita:';

  // 1. Verificar vigencia de Antecedentes Penales según fecha de emisión y ventana del barrio
  const windowDays = normalizeCriminalWindowDays(criminalRecordMaxAgeDays);
  const effectiveCriminalExpiry = computeEffectiveCriminalRecordExpiry({
    criminalRecordIssuedAt,
    criminalRecordExpiry,
    maxAgeDays: windowDays,
  });

  if (isExpiryDatePassed(effectiveCriminalExpiry, referenceDate)) {
    return {
      code: 'CRIMINAL_RECORD_EXPIRED',
      field: 'criminal_record_expiry',
      expiry_date: effectiveCriminalExpiry,
      message: criminalRecordIssuedAt
        ? `${prefix} los Antecedentes Penales superan la vigencia máxima de ${windowDays} días configurada para este barrio (venció el ${effectiveCriminalExpiry}).`
        : `${prefix} los Antecedentes Penales del prestador están vencidos (venció el ${effectiveCriminalExpiry}).`,
    };
  }

  // 2. Verificar vigencia de Seguro de Accidentes Personales / Póliza ART del prestador titular
  if (isExpiryDatePassed(insuranceExpiry, referenceDate)) {
    const expiryDate = toIsoDateOnly(insuranceExpiry);
    return {
      code: 'INSURANCE_EXPIRED',
      field: 'insurance_expiry',
      expiry_date: expiryDate,
      message: `${prefix} el Seguro AP / Póliza ART del prestador está vencido (venció el ${expiryDate}).`,
    };
  }

  // 3. Verificar vigencia de Póliza ART de cada integrante de la cuadrilla autorizada
  if (Array.isArray(authorizedEmployees) && authorizedEmployees.length > 0) {
    for (const emp of authorizedEmployees) {
      if (emp && isExpiryDatePassed(emp.insurance_expiry, referenceDate)) {
        const expiryDate = toIsoDateOnly(emp.insurance_expiry);
        const empName = emp.full_name || 'Ayudante';
        return {
          code: 'CREW_INSURANCE_EXPIRED',
          field: 'employee_insurance_expiry',
          expiry_date: expiryDate,
          employee_name: empName,
          message: `${prefix} el ayudante ${empName} tiene su Póliza ART vencida (venció el ${expiryDate}).`,
        };
      }
    }
  }

  return null;
}

/**
 * Enriquece el snapshot JSONB de ayudantes guardado en un pase QR consultando sus fechas
 * actuales en `public.provider_employees`.
 *
 * @param {object} db - Cliente/pool de PostgreSQL con método `query`.
 * @param {Array<object>} authorizedEmployees - Snapshot de ayudantes almacenado en `access_passes`.
 * @returns {Promise<Array<object>>} Lista de ayudantes con `insurance_expiry` hidratado.
 */
async function hydrateAuthorizedEmployeesExpiry(db, authorizedEmployees) {
  if (!Array.isArray(authorizedEmployees) || authorizedEmployees.length === 0) {
    return [];
  }
  const ids = authorizedEmployees
    .map((e) => Number(e?.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) return authorizedEmployees;

  try {
    const res = await db.query(
      `SELECT id, insurance_expiry, is_active
       FROM public.provider_employees
       WHERE id = ANY($1::int[])`,
      [ids]
    );
    const byId = new Map(res.rows.map((r) => [Number(r.id), r]));
    return authorizedEmployees.map((emp) => {
      const live = byId.get(Number(emp.id));
      if (!live) return emp;
      return {
        ...emp,
        insurance_expiry: live.insurance_expiry
          ? toIsoDateOnly(live.insurance_expiry)
          : null,
      };
    });
  } catch {
    return authorizedEmployees;
  }
}

module.exports = {
  ALLOWED_CRIMINAL_WINDOW_DAYS,
  DEFAULT_CRIMINAL_WINDOW_DAYS,
  normalizeCriminalWindowDays,
  toIsoDateOnly,
  addDaysToIsoDate,
  computeEffectiveCriminalRecordExpiry,
  getTodayIsoDate,
  isExpiryDatePassed,
  findComplianceExpiryViolation,
  hydrateAuthorizedEmployeesExpiry,
};
