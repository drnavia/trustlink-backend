/**
 * @file complianceExpiry.js
 * @description Helper centralizado para evaluar vencimientos documentales obligatorios
 * (Antecedentes Penales, Póliza ART/Seguro Personal y ART de ayudantes de cuadrilla)
 * al emitir pases QR o validarlos en garita / API externa.
 * @location /trustlink-backend/src/utils/complianceExpiry.js
 */

/**
 * Normaliza una fecha DATE / ISO / Date a formato YYYY-MM-DD (UTC) o null si no es válida.
 * @param {string|Date|null|undefined} rawDate
 * @returns {string|null}
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
 * Devuelve la fecha actual en formato YYYY-MM-DD (UTC).
 * @param {Date} [referenceDate]
 * @returns {string}
 */
function getTodayIsoDate(referenceDate = new Date()) {
  return referenceDate.toISOString().slice(0, 10);
}

/**
 * Indica si una fecha de vencimiento ya caducó (< hoy).
 * Si no hay fecha cargada, devuelve false para preservar compatibilidad con perfiles sin fecha.
 * @param {string|Date|null|undefined} rawDate
 * @param {Date} [referenceDate]
 * @returns {boolean}
 */
function isExpiryDatePassed(rawDate, referenceDate = new Date()) {
  const iso = toIsoDateOnly(rawDate);
  if (!iso) return false;
  return iso < getTodayIsoDate(referenceDate);
}

/**
 * Evalúa si existe alguna infracción por documentación vencida del prestador o de su cuadrilla.
 * Devuelve `null` si todo lo declarado con fecha se encuentra vigente.
 *
 * @param {object} params
 * @param {string|Date|null|undefined} [params.criminalRecordExpiry]
 * @param {string|Date|null|undefined} [params.insuranceExpiry]
 * @param {Array<{id?: number, full_name?: string, insurance_expiry?: string|Date|null}>} [params.authorizedEmployees]
 * @param {'create'|'gate'} [params.context]
 * @param {Date} [params.referenceDate]
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

  if (isExpiryDatePassed(criminalRecordExpiry, referenceDate)) {
    const expiryDate = toIsoDateOnly(criminalRecordExpiry);
    return {
      code: 'CRIMINAL_RECORD_EXPIRED',
      field: 'criminal_record_expiry',
      expiry_date: expiryDate,
      message: `${prefix} los Antecedentes Penales del prestador están vencidos (venció el ${expiryDate}).`,
    };
  }

  if (isExpiryDatePassed(insuranceExpiry, referenceDate)) {
    const expiryDate = toIsoDateOnly(insuranceExpiry);
    return {
      code: 'INSURANCE_EXPIRED',
      field: 'insurance_expiry',
      expiry_date: expiryDate,
      message: `${prefix} la Póliza ART / Seguro Personal del prestador está vencida (venció el ${expiryDate}).`,
    };
  }

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
 * Enriquece el snapshot de ayudantes de un pase con la fecha de seguro vigente en DB
 * (si el ayudante renovó o venció su ART luego de emitido el pase, prevalece el dato actual).
 *
 * @param {object} db
 * @param {Array<object>} authorizedEmployees
 * @returns {Promise<Array<object>>}
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
