/**
 * @file providerTrustLevel.js
 * @description Motor puro de Confianza Progresiva por Niveles v2 (`N0 → N4`) + Eje Comercial desacoplado.
 * Calcula de forma determinista el nivel de respaldo (`0..4`), la insignia visible en todos
 * los portales, la elegibilidad para figurar en el directorio del Portal Residente y la
 * habilitación para emitir/validar Pases QR en garita (desde `N3` vigente).
 *
 * Escala oficial v2 (Eje de Confianza y Seguridad — nunca se compra):
 * - `N0 · Cuenta creada` *(oculto)*: falta celular validado, DNI validado o especialidad visible.
 * - `N1 · Perfil Básico` *(visible · solo consultas)*: celular + DNI validado + ≥ 1 especialidad visible.
 * - `N2 · En verificación` *(visible · solo consultas)*: N1 + Seguro AP o ART vigente cargado (y opcionalmente Antecedentes cargados esperando auditoría).
 * - `N3 · Pase QR habilitado` *(visible · Pase QR habilitado)*: N2 + Antecedentes Penales vigentes dentro de la ventana del barrio + aprobación documental de TrustLink.
 * - `N4 · Verificado` *(tilde oficial estilo X/Instagram)*: N3 + cotejo automático/cruzado de PDFs (`autoVerified = true`).
 *
 * Eje Comercial paralelo (`is_featured_partner`): membresía/destacado habilitada exclusivamente desde `N3` o `N4` vigente, sin alterar el nivel de seguridad.
 * @location /trustlink-backend/src/utils/providerTrustLevel.js
 */

const {
  DEFAULT_CRIMINAL_WINDOW_DAYS,
  normalizeCriminalWindowDays,
  computeEffectiveCriminalRecordExpiry,
  isExpiryDatePassed,
} = require('./complianceExpiry');

/** Catálogo ordenado de niveles progresivos de confianza (`0..4`). */
const TRUST_LEVEL_CATALOG = [
  {
    level: 0,
    tier: 'incomplete',
    label: 'Sin habilitar',
    short_label: 'Nivel 0 · Cuenta creada',
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
    tier: 'insurance_review',
    label: 'En verificación',
    short_label: 'Nivel 2 · En verificación',
    tone: 'indigo',
  },
  {
    level: 3,
    tier: 'qr_enabled',
    label: 'Pase QR habilitado',
    short_label: 'Nivel 3 · Pase QR',
    tone: 'emerald',
  },
  {
    level: 4,
    tier: 'auto_verified',
    label: 'Verificado',
    short_label: 'Nivel 4 · Verificado',
    tone: 'sky',
  },
];

/**
 * Evalúa si una fecha de vencimiento (`YYYY-MM-DD` o Date) ya venció.
 * @param {string|Date|null|undefined} rawDate
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
function isExpiryDatePast(rawDate, now = new Date()) {
  return isExpiryDatePassed(rawDate, now);
}

/**
 * Calcula el nivel progresivo de confianza (`0..4`) y el estado del Eje Comercial separado.
 *
 * @param {Object} input
 * @param {boolean} [input.userIsActive=true]
 * @param {boolean} [input.phoneVerified=true]
 * @param {boolean} [input.identityVerified=false]
 * @param {boolean} [input.hasVisibleSpecialty=false]
 * @param {boolean} [input.hasArtDoc=false] - Seguro de Accidentes Personales (AP) o Póliza ART cargada.
 * @param {boolean} [input.artExpired=false]
 * @param {boolean} [input.hasCriminalDoc=false] - Certificado de Antecedentes Penales cargado.
 * @param {boolean} [input.criminalExpired=false]
 * @param {string|Date|null} [input.criminalRecordIssuedAt=null] - Fecha de emisión de Antecedentes (para cálculo dinámico por barrio).
 * @param {string|Date|null} [input.criminalRecordExpiry=null] - Fecha de vencimiento directa/heredada.
 * @param {number} [input.criminalRecordMaxAgeDays=180] - Ventana de días configurada por la comunidad (`30|90|180|365`).
 * @param {boolean} [input.complianceApproved=false] - Aprobación documental de TrustLink para habilitar N3 (Pase QR).
 * @param {boolean} [input.autoVerified=false] - Cotejo automático/cruzado de PDFs validado para habilitar N4 (Verificado).
 * @param {boolean} [input.isAllRejected=false]
 * @param {boolean} [input.isVerifiedMember=false] - Suscripción activa en el Eje Comercial (`Destacado`).
 * @param {Date} [input.now=new Date()]
 * @returns {Object} Metadatos normalizados de nivel, controles y Eje Comercial.
 */
function computeProviderTrustLevel({
  userIsActive = true,
  phoneVerified = true,
  identityVerified = false,
  hasVisibleSpecialty = false,
  hasCriminalDoc = false,
  criminalExpired = false,
  criminalRecordIssuedAt = null,
  criminalRecordExpiry = null,
  criminalRecordMaxAgeDays = DEFAULT_CRIMINAL_WINDOW_DAYS,
  hasArtDoc = false,
  artExpired = false,
  complianceApproved = false,
  autoVerified = false,
  isAllRejected = false,
  isVerifiedMember = false,
  now = new Date(),
} = {}) {
  const windowDays = normalizeCriminalWindowDays(criminalRecordMaxAgeDays);
  const effectiveCriminalExpiry = computeEffectiveCriminalRecordExpiry({
    criminalRecordIssuedAt,
    criminalRecordExpiry,
    maxAgeDays: windowDays,
  });
  const computedCriminalExpired =
    Boolean(criminalExpired) ||
    (Boolean(effectiveCriminalExpiry) && isExpiryDatePassed(effectiveCriminalExpiry, now));

  const criminalOk = Boolean(hasCriminalDoc) && !computedCriminalExpired;
  const artOk = Boolean(hasArtDoc) && !Boolean(artExpired);
  const hasExpiredDocs = Boolean(computedCriminalExpired) || Boolean(artExpired);
  const effectiveIdentity = Boolean(identityVerified) || Boolean(complianceApproved);
  const effectivePhone = Boolean(phoneVerified) || Boolean(complianceApproved);

  const baseChecks = {
    phone_ok: effectivePhone,
    identity_ok: effectiveIdentity,
    specialty_ok: Boolean(hasVisibleSpecialty),
    art_ok: artOk,
    art_expired: Boolean(artExpired),
    criminal_ok: criminalOk,
    criminal_expired: computedCriminalExpired,
    compliance_ok: false,
    pass_qr_ok: false,
    auto_verified_ok: false,
    member_ok: false,
  };

  // Caso bloqueado: cuenta suspendida o rechazada
  if (!userIsActive || isAllRejected) {
    return {
      level: 0,
      max_level: 4,
      tier: isAllRejected ? 'rejected' : 'suspended',
      label: isAllRejected ? 'Rechazado' : 'Cuenta suspendida',
      sublabel: isAllRejected
        ? 'Corregí tu documentación para volver a evaluación'
        : 'Cuenta deshabilitada por Administración',
      tone: 'danger',
      is_verified: false,
      is_auto_verified: false,
      is_featured_partner: false,
      visible_in_directory: false,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: hasExpiredDocs,
      criminal_window_days: windowDays,
      effective_criminal_expiry: effectiveCriminalExpiry,
      checks: { ...baseChecks },
      next_step_hint: isAllRejected
        ? 'Actualizá tus documentos o especialidad para solicitar una nueva revisión.'
        : 'Contactá a Administración Central para reactivar tu cuenta.',
    };
  }

  // Nivel 0: falta celular validado, DNI validado o al menos 1 especialidad visible
  if (!effectivePhone || !effectiveIdentity || !hasVisibleSpecialty) {
    const missing = [];
    if (!effectivePhone) missing.push('validación de celular (SMS)');
    if (!effectiveIdentity) missing.push('validación de identidad (DNI)');
    if (!hasVisibleSpecialty) missing.push('al menos 1 especialidad visible');
    return {
      level: 0,
      max_level: 4,
      tier: 'incomplete',
      label: !effectivePhone ? 'Cuenta creada' : 'Sin habilitar',
      sublabel: `Falta ${missing.join(' y ')}`,
      tone: 'slate',
      is_verified: false,
      is_auto_verified: false,
      is_featured_partner: false,
      visible_in_directory: false,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: hasExpiredDocs,
      criminal_window_days: windowDays,
      effective_criminal_expiry: effectiveCriminalExpiry,
      checks: { ...baseChecks },
      next_step_hint: !effectivePhone
        ? 'Validá tu número de celular por SMS (o solicitá validación en Administración) para continuar al Nivel 1.'
        : !effectiveIdentity
          ? 'Cargá tu número de DNI y fotos frente/dorso (o PDF) para validación y habilitar tu Perfil Básico (N1).'
          : 'Agregá al menos 1 especialidad visible para aparecer en el directorio (N1).',
    };
  }

  // Caso degradado: tenía compliance aprobado pero venció Seguro AP/ART o Antecedentes (según ventana del barrio)
  if (complianceApproved && hasExpiredDocs) {
    return {
      level: artOk ? 2 : 1,
      max_level: 4,
      tier: 'docs_expired',
      label: 'Doc. vencida',
      sublabel: computedCriminalExpired && criminalRecordIssuedAt
        ? `Antecedentes fuera de ventana (${windowDays} días) — renová para habilitar QR`
        : 'Renová Seguro AP/ART o Antecedentes para rehabilitar garita',
      tone: 'danger',
      is_verified: false,
      is_auto_verified: false,
      is_featured_partner: false,
      visible_in_directory: true,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: true,
      criminal_window_days: windowDays,
      effective_criminal_expiry: effectiveCriminalExpiry,
      checks: { ...baseChecks },
      next_step_hint: computedCriminalExpired && criminalRecordIssuedAt
        ? `Tus Antecedentes Penales superaron los ${windowDays} días de antigüedad máxima. Renovalos para recuperar Pases QR.`
        : 'Renová tu documentación vencida para recuperar tu habilitación de Pases QR en garita.',
    };
  }

  // Nivel 4: Verificado TrustLink (tilde oficial estilo X/Instagram: N3 + cotejo automático/cruzado de PDFs)
  if (complianceApproved && !hasExpiredDocs && Boolean(autoVerified)) {
    const featuredPartner = Boolean(isVerifiedMember);
    return {
      level: 4,
      max_level: 4,
      tier: 'auto_verified',
      label: 'Verificado',
      sublabel: 'PDFs cotejados y Pases QR habilitados',
      tone: 'sky',
      is_verified: true,
      is_auto_verified: true,
      is_featured_partner: featuredPartner,
      visible_in_directory: true,
      can_issue_pass: true,
      can_subscribe_verified_partner: true,
      has_expired_docs: false,
      criminal_window_days: windowDays,
      effective_criminal_expiry: effectiveCriminalExpiry,
      checks: {
        ...baseChecks,
        compliance_ok: true,
        pass_qr_ok: true,
        auto_verified_ok: true,
        member_ok: featuredPartner,
      },
      next_step_hint: featuredPartner
        ? 'Nivel máximo de confianza (N4 Verificado) + Destacado comercial activo.'
        : 'Alcanzaste el nivel máximo de confianza (N4 Verificado). Podés sumar un plan Destacado si deseás priorizar tu perfil.',
    };
  }

  // Nivel 3: Habilitado · Pase QR (DNI + Seguro AP/ART + Antecedentes aprobados y vigentes)
  if (complianceApproved && !hasExpiredDocs) {
    const featuredPartner = Boolean(isVerifiedMember);
    return {
      level: 3,
      max_level: 4,
      tier: 'qr_enabled',
      label: 'Pase QR habilitado',
      sublabel: 'Documentación validada para ingreso en garita',
      tone: 'emerald',
      is_verified: true,
      is_auto_verified: false,
      is_featured_partner: featuredPartner,
      visible_in_directory: true,
      can_issue_pass: true,
      can_subscribe_verified_partner: true,
      has_expired_docs: false,
      criminal_window_days: windowDays,
      effective_criminal_expiry: effectiveCriminalExpiry,
      checks: {
        ...baseChecks,
        compliance_ok: true,
        pass_qr_ok: true,
        auto_verified_ok: false,
        member_ok: featuredPartner,
      },
      next_step_hint:
        'Ya estás habilitado para recibir Pases QR en garita (N3). Al completar el cotejo automático de tus PDFs obtendrás el sello N4 Verificado.',
    };
  }

  // Nivel 2: Seguro AP/ART cargado (en verificación) — y si además cargó Antecedentes, queda listo para auditoría N3
  if (artOk) {
    const hasBothDocs = criminalOk;
    return {
      level: 2,
      max_level: 4,
      tier: hasBothDocs ? 'docs_in_review' : 'insurance_review',
      label: 'En verificación',
      sublabel: hasBothDocs
        ? 'Seguro y Antecedentes cargados (en revisión)'
        : 'Seguro AP/ART cargado · falta Antecedentes',
      tone: 'indigo',
      is_verified: false,
      is_auto_verified: false,
      is_featured_partner: false,
      visible_in_directory: true,
      can_issue_pass: false,
      can_subscribe_verified_partner: false,
      has_expired_docs: hasExpiredDocs,
      criminal_window_days: windowDays,
      effective_criminal_expiry: effectiveCriminalExpiry,
      checks: { ...baseChecks },
      next_step_hint: hasBothDocs
        ? 'Cargaste Seguro y Antecedentes Penales. Al aprobarse por TrustLink subirás a Nivel 3 (Pase QR habilitado).'
        : 'Cargá tus Antecedentes Penales (Fecha de emisión, Código de Solicitud, Código de Seguridad y PDF) para avanzar a Nivel 3 y habilitar Pases QR.',
    };
  }

  // Nivel 1: Perfil Básico (DNI validado + Especialidad visible, sin seguro vigente aún)
  return {
    level: 1,
    max_level: 4,
    tier: 'basic',
    label: 'Perfil Básico',
    sublabel: 'Identidad validada · Solo consultas',
    tone: 'slate',
    is_verified: false,
    is_auto_verified: false,
    is_featured_partner: false,
    visible_in_directory: true,
    can_issue_pass: false,
    can_subscribe_verified_partner: false,
    has_expired_docs: hasExpiredDocs,
    criminal_window_days: windowDays,
    effective_criminal_expiry: effectiveCriminalExpiry,
    checks: { ...baseChecks },
    next_step_hint:
      'Cargá tu Seguro de Accidentes Personales (si trabajás solo) o Póliza de ART (si tenés ayudantes) para avanzar a Nivel 2.',
  };
}

module.exports = {
  TRUST_LEVEL_CATALOG,
  isExpiryDatePast,
  computeProviderTrustLevel,
};
