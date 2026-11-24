/**
 * @file complianceExpiry.js
 * @description Helper centralizado para evaluar vencimientos documentales obligatorios
 * (Antecedentes Penales, Póliza ART/Seguro Personal y ART de ayudantes de cuadrilla)
 * al emitir pases QR o validarlos en garita / API externa.
 * @location /trustlink-backend/src/utils/complianceExpiry.js
 */

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
    // Si ya comienza con YYYY-MM-DD, evita desfases por zona horaria local
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }
  const parsed = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
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
 * o de los ayudantes incluidos en el pase.
 *
 * Orden de prioridad de validación:
 * 1. Antecedentes Penales del prestador (`CRIMINAL_RECORD_EXPIRED`).
 * 2. Póliza ART / Seguro Personal del prestador (`INSURANCE_EXPIRED`).
 * 3. Póliza ART individual de cada ayudante autorizado (`CREW_INSURANCE_EXPIRED`).
 *
 * Devuelve `null` si toda la documentación declarada con fecha se encuentra vigente.
 *
 * @param {object} [params]
 * @param {string|Date|null|undefined} [params.criminalRecordExpiry] - Vencimiento de antecedentes penales.
 * @param {string|Date|null|undefined} [params.insuranceExpiry] - Vencimiento de póliza ART/seguro personal.
 * @param {Array<{id?: number, full_name?: string, insurance_expiry?: string|Date|null}>} [params.authorizedEmployees] - Nómina de ayudantes del pase.
 * @param {'create'|'gate'} [params.context] - Contexto del mensaje (`create` al emitir pase, `gate` en garita).
 * @param {Date} [params.referenceDate] - Fecha de referencia para la comparación.
 * @returns {null|{code: string, field: string, expiry_date: string, employee_name?: string, message: string}}
 */
function findComplianceExpiryViolation({
  criminalRecordExpiry = null,
  insuranceExpiry = null,
  authorizedEmployees = [],
  context = 'gate',
  referenceDate = new Date(),
} = {}) {
  const prefix =
    context === 'create'
      ? 'No se puede emitir el pase QR:'
      : 'Ingreso bloqueado en garita:';

  // 1. Verificar vigencia de Antecedentes Penales del prestador titular
  if (isExpiryDatePassed(criminalRecordExpiry, referenceDate)) {
    const expiryDate = toIsoDateOnly(criminalRecordExpiry);
    return {
      code: 'CRIMINAL_RECORD_EXPIRED',
      field: 'criminal_record_expiry',
      expiry_date: expiryDate,
      message: `${prefix} los Antecedentes Penales del prestador están vencidos (venció el ${expiryDate}).`,
    };
  }

  // 2. Verificar vigencia de Póliza ART / Seguro Personal del prestador titular
  if (isExpiryDatePassed(insuranceExpiry, referenceDate)) {
    const expiryDate = toIsoDateOnly(insuranceExpiry);
    return {
      code: 'INSURANCE_EXPIRED',
      field: 'insurance_expiry',
      expiry_date: expiryDate,
      message: `${prefix} la Póliza ART / Seguro Personal del prestador está vencida (venció el ${expiryDate}).`,
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
 * De esta manera, si un ayudante renovó o venció su ART luego de emitido el pase, prevalece
 * el estado vigente en base de datos al momento de la validación en garita. Ante errores de DB,
 * conserva el snapshot original como respaldo.
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
  toIsoDateOnly,
  getTodayIsoDate,
  isExpiryDatePassed,
  findComplianceExpiryViolation,
  hydrateAuthorizedEmployeesExpiry,
};
