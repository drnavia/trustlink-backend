/**
 * @file providerTrustLevel.js
 * @description Motor puro de Confianza Progresiva por Niveles (Fase 6.1) para TrustLink.
 * Calcula de forma determinista el nivel de respaldo (`0..5`), la insignia visible en todos
 * los portales, la elegibilidad para figurar en el directorio del Portal Residente y la
 * habilitación para emitir/validar Pases QR en garita (manteniendo estricto el control perimetral).
 * @location /trustlink-backend/src/utils/providerTrustLevel.js
 */

/** Catálogo ordenado de niveles progresivos de confianza (Eje A — separado de Reputación). */
const TRUST_LEVEL_CATALOG = [
  {
    level: 0,
    tier: 'incomplete',
    label: 'Sin habilitar',
    short_label: 'Nivel 0 · Incompleto',
    tone: 'slate',
  },
  {
    level: 1,
    tier: 'basic',
    label: 'Perfil Básico',
    short_label: 'Nivel 1 · Básico',
    tone: 'slate',
  },
  {
    level: 2,
    tier: 'partial_docs',
    label: 'Respaldo Parcial',
    short_label: 'Nivel 2 · Parcial',
    tone: 'sky',
  },
  {
    level: 3,
    tier: 'docs_complete',
    label: 'Doc. en validación',
    short_label: 'Nivel 3 · Doc. Completa',
    tone: 'teal',
  },
  {
    level: 4,
    tier: 'verified',
    label: 'Verificado',
    short_label: 'Nivel 4 · Verificado',
    tone: 'emerald',
  },
  {
    level: 5,
    tier: 'verified_partner',
    label: 'Socio Verificado',
    short_label: 'Nivel 5 · Socio Verificado',
    tone: 'gold',
  },
];

/**
 * Evalúa si una fecha de vencimiento (`YYYY-MM-DD` o Date) se encuentra vencida respecto
 * a la fecha de referencia (`now`, por defecto hoy a las 00:00 UTC/local).
 *
 * @param {string|Date|null|undefined} rawDate - Fecha de vencimiento a evaluar.
 * @param {Date} [now=new Date()] - Fecha de referencia.
 * @returns {boolean} `true` si la fecha existe y ya venció.
 */
function isExpiryDatePast(rawDate, now = new Date()) {
  if (!rawDate) return false;
  const toDayKey = (val) => {
    if (typeof val === 'string') {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(val.trim());
      if (m) return m[1];
    }
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return null;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  const expDay = toDayKey(rawDate);
  const refDay = toDayKey(now);
  if (!expDay || !refDay) return false;
  return expDay < refDay;
}

/**
 * Calcula el nivel progresivo de confianza (`0..5`) y todos los metadatos de insignia,
 * visibilidad en directorio y habilitación de Pase QR en garita.
 *
 * Reglas de negocio (Fase 6.1):
 * - Nivel 0 (oculto): cuenta inactiva, rechazada, sin identidad validada o sin especialidad visible.
 * - Nivel 1 (`Perfil Básico`): identidad validada + ≥ 1 especialidad visible (sin docs aún). Visible en directorio, sin Pase QR.
 * - Nivel 2 (`Antecedentes al día` / `ART al día`): Nivel 1 + 1 documento personal vigente. Visible en directorio, sin Pase QR.
 * - Nivel 3 (`Doc. en validación`): Nivel 1 + Antecedentes vigentes + ART vigente cargados (esperando aprobación). Visible en directorio, sin Pase QR.
 * - Nivel 4 (`Verificado`): compliance aprobado + documentación personal vigente + ≥ 1 especialidad aprobada y visible. Habilita Pase QR y filtro *Solo Verificados*.
 * - Nivel 5 (`Socio Verificado`): **exige Nivel 4 obligatorio** + membresía activa. Máxima prioridad e insignia dorada.
 *
 * @param {Object} input - Datos consolidados del prestador.
 * @param {boolean} [input.userIsActive=true] - Si la cuenta de usuario está activa.
 * @param {boolean} [input.identityVerified=false] - Si la identidad (DNI) fue validada.
 * @param {boolean} [input.hasVisibleSpecialty=false] - Si posee al menos 1 especialidad activa y visible (no rechazada, custom aprobada).
 * @param {boolean} [input.hasCriminalDoc=false] - Si cargó archivo/URL de Antecedentes Penales.
 * @param {boolean} [input.criminalExpired=false] - Si los Antecedentes Penales están vencidos.
 * @param {boolean} [input.hasArtDoc=false] - Si cargó archivo/URL de Póliza ART / Seguro.
 * @param {boolean} [input.artExpired=false] - Si la Póliza ART está vencida.
 * @param {boolean} [input.complianceApproved=false] - Si tiene compliance personal aprobado por Ops/TrustLink.
 * @param {boolean} [input.isAllRejected=false] - Si todas sus solicitudes fueron rechazadas.
 * @param {boolean} [input.isVerifiedMember=false] - Si tiene membresía paga activa.
 * @returns {Object} Resultado normalizado de nivel e insignia.
 */
function computeProviderTrustLevel({
  userIsActive = true,
  identityVerified = false,
  hasVisibleSpecialty = false,
  hasCriminalDoc = false,
  criminalExpired = false,
  hasArtDoc = false,
  artExpired = false,
  complianceApproved = false,
  isAllRejected = false,
  isVerifiedMember = false,
} = {}) {
  const criminalOk = Boolean(hasCriminalDoc) && !Boolean(criminalExpired);
  const artOk = Boolean(hasArtDoc) && !Boolean(artExpired);
  const hasExpiredDocs = Boolean(criminalExpired) || Boolean(artExpired);
  const effectiveIdentity = Boolean(identityVerified) || Boolean(complianceApproved);
  const baseChecks = {
    identity_ok: effectiveIdentity,
    specialty_ok: Boolean(hasVisibleSpecialty),
    criminal_ok: criminalOk,
    criminal_expired: Boolean(criminalExpired),
    art_ok: artOk,
    art_expired: Boolean(artExpired),
    compliance_ok: false,
    pass_qr_ok: false,
    member_ok: false,
  };

  // Caso bloqueado: cuenta suspendida o rechazada
  if (!userIsActive || isAllRejected) {
    return {
      level: 0,
      tier: isAllRejected ? 'rejected' : 'suspended',
      label: isAllRejected ? 'Rechazado' : 'Cuenta suspendida',
      sublabel: isAllRejected
        ? 'Corregí tu documentación para volver a evaluación'
        : 'Cuenta deshabilitada por Administración',
      tone: 'danger',
      is_verified: false,
      visible_in_directory: false,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: hasExpiredDocs,
      checks: { ...baseChecks },
      next_step_hint: isAllRejected
        ? 'Actualizá tus documentos o especialidad para solicitar una nueva revisión.'
        : 'Contactá a Administración Central para reactivar tu cuenta.',
    };
  }

  // Nivel 0: falta identidad validada o especialidad visible
  if (!effectiveIdentity || !hasVisibleSpecialty) {
    const missing = [];
    if (!effectiveIdentity) missing.push('validación de identidad (DNI)');
    if (!hasVisibleSpecialty) missing.push('al menos 1 especialidad visible');
    return {
      level: 0,
      tier: 'incomplete',
      label: 'Sin habilitar',
      sublabel: `Falta ${missing.join(' y ')}`,
      tone: 'slate',
      is_verified: false,
      visible_in_directory: false,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: hasExpiredDocs,
      checks: { ...baseChecks },
      next_step_hint: !hasVisibleSpecialty
        ? 'Agregá al menos 1 especialidad visible para comenzar a figurar al validar tu identidad.'
        : 'Tu identidad (DNI) está pendiente de validación por Administración para habilitar tu Perfil Básico.',
    };
  }

  // Caso degradado: tenía compliance aprobado pero venció Antecedentes o ART
  if (complianceApproved && hasExpiredDocs) {
    return {
      level: criminalOk || artOk ? 2 : 1,
      tier: 'docs_expired',
      label: 'Doc. vencida',
      sublabel: 'Renová ART/Antecedentes para rehabilitar garita',
      tone: 'danger',
      is_verified: false,
      visible_in_directory: true,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: true,
      checks: { ...baseChecks },
      next_step_hint: 'Renová tu documentación vencida para recuperar tu insignia Verificado y Pases QR.',
    };
  }

  // Nivel 5: Socio Verificado (EXIGE Nivel 4 verificado obligatorio + suscripción activa)
  if (complianceApproved && !hasExpiredDocs && Boolean(isVerifiedMember)) {
    return {
      level: 5,
      tier: 'verified_partner',
      label: 'Socio Verificado',
      sublabel: 'Compliance aprobado + suscripción activa',
      tone: 'gold',
      is_verified: true,
      visible_in_directory: true,
      can_issue_pass: true,
      can_subscribe_verified_partner: true,
      has_expired_docs: false,
      checks: { ...baseChecks, compliance_ok: true, pass_qr_ok: true, member_ok: true },
      next_step_hint: 'Nivel máximo alcanzado: tenés prioridad destacada y respaldo completo en garita.',
    };
  }

  // Nivel 4: Verificado TrustLink (compliance aprobado + documentación vigente)
  if (complianceApproved && !hasExpiredDocs) {
    return {
      level: 4,
      tier: 'verified',
      label: 'Verificado',
      sublabel: 'Identidad y documentación validadas',
      tone: 'emerald',
      is_verified: true,
      visible_in_directory: true,
      can_issue_pass: true,
      can_subscribe_verified_partner: true,
      has_expired_docs: false,
      checks: { ...baseChecks, compliance_ok: true, pass_qr_ok: true },
      next_step_hint: 'Ya sos Verificado. Podés activar Socio Verificado para obtener prioridad máxima e insignia dorada.',
    };
  }

  // Nivel 3: Documentación Completa (Antecedentes + ART vigentes cargados, pendiente de validación Ops/IA)
  if (criminalOk && artOk) {
    return {
      level: 3,
      tier: 'docs_complete',
      label: 'Doc. en validación',
      sublabel: 'ART + Antecedentes cargados',
      tone: 'teal',
      is_verified: false,
      visible_in_directory: true,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: false,
      checks: { ...baseChecks },
      next_step_hint: 'Cargaste toda tu documentación. Al aprobarse por TrustLink subirás a Nivel 4 (Verificado).',
    };
  }

  // Nivel 2: Respaldo Parcial (solo 1 de los 2 documentos personales vigente)
  if (criminalOk || artOk) {
    return {
      level: 2,
      tier: 'partial_docs',
      label: criminalOk ? 'Antecedentes al día' : 'ART al día',
      sublabel: criminalOk ? 'Falta cargar Póliza ART' : 'Falta cargar Antecedentes',
      tone: 'sky',
      is_verified: false,
      visible_in_directory: true,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: hasExpiredDocs,
      checks: { ...baseChecks },
      next_step_hint: criminalOk
        ? 'Cargá tu Póliza ART vigente para alcanzar Nivel 3 y pasar a verificación.'
        : 'Cargá tus Antecedentes Penales vigentes para alcanzar Nivel 3 y pasar a verificación.',
    };
  }

  // Nivel 1: Perfil Básico (identidad validada + especialidad visible, sin documentación de compliance aún)
  return {
    level: 1,
    tier: 'basic',
    label: 'Perfil Básico',
    sublabel: 'Identidad validada · sin compliance aún',
    tone: 'slate',
    is_verified: false,
    visible_in_directory: true,
    can_issue_pass: false,
    can_subscribe_verified_partner: false,
    has_expired_docs: hasExpiredDocs,
    checks: { ...baseChecks },
    next_step_hint: 'Cargá tu Póliza ART y Antecedentes Penales vigentes para subir de nivel y habilitar Pases QR.',
  };
}

module.exports = {
  TRUST_LEVEL_CATALOG,
  isExpiryDatePast,
  computeProviderTrustLevel,
};
