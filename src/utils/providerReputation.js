/**
 * @file providerReputation.js
 * @description Helpers puros y deterministas para el sistema de reputación estilo marketplace
 * de TrustLink (Fase 5):
 * - Catálogo controlado y sanitizador de micro-tags en reseñas (`REVIEW_MICRO_TAGS`).
 * - Cálculo del termómetro de reputación de 5 niveles (`1..5`), puntaje `/100`,
 *   insignia de mérito (`TrustLink Platino`, `Destacado Oro`, `Confiable`, etc.) y
 *   próximo hito sugerido (`next_milestone`) para impulsar retención anti-leakage.
 * @location /trustlink-backend/src/utils/providerReputation.js
 */

/**
 * Catálogo oficial de micro-tags tocables disponibles para que el residente
 * destaque atributos del servicio al calificar un contrato.
 */
const REVIEW_MICRO_TAGS = [
  'Puntual',
  'Prolijo',
  'Precio justo',
  'Buena comunicación',
  'Resolvió en el día',
  'Recomendado',
];

/** Valores permitidos para la política de presupuesto / visita técnica del prestador. */
const ALLOWED_QUOTE_POLICIES = ['sin_cargo', 'arancelada', 'consultar'];

/** Valores permitidos para la condición de facturación del prestador. */
const ALLOWED_INVOICE_TYPES = ['factura_a', 'factura_c', 'ambas', 'sin_factura', 'consultar'];

/** Medios de pago habilitados para mostrar en la ficha comercial del prestador. */
const ALLOWED_PAYMENT_METHODS = ['efectivo', 'transferencia', 'mercadopago', 'tarjeta'];

/**
 * Catálogo oficial normalizado de especialidades estándar de TrustLink (Fase 5.3).
 * Si el prestador ya tiene compliance personal aprobado y elige un rubro de este catálogo,
 * se auto-aprueba al instante sin generar cuello de botella en Operaciones.
 */
const STANDARD_SPECIALTIES_CATALOG = [
  'Electricista',
  'Plomero',
  'Gasista',
  'Climatización',
  'Piletero',
  'Jardinero / Parquero',
  'Pintor',
  'Albañil',
  'Carpintero',
  'Herrero',
  'Cerrajero',
  'Limpieza',
  'Fumigación',
  'Durlock / Yesero',
  'Techista / Impermeabilización',
  'Riego Automático',
  'Mantenimiento General',
  'Técnico en Electrodomésticos',
];

// Mapa en minúsculas sin tildes para emparejar nombres estándar ignorando variaciones tipográficas
const STANDARD_SPECIALTY_LOOKUP = new Map(
  STANDARD_SPECIALTIES_CATALOG.map((spec) => [
    spec
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
    spec,
  ])
);

/**
 * Determina si una especialidad ingresada pertenece al catálogo estándar oficial o si debe
 * tratarse como especialidad personalizada sujeta a moderación de Operaciones.
 *
 * @param {string} rawSpecialty - Nombre del rubro enviado por el prestador.
 * @returns {{ isStandard: boolean, canonicalSpecialty: string }} Resultado de la resolución.
 */
function resolveSpecialtyCatalogMatch(rawSpecialty) {
  const trimmed = String(rawSpecialty || '').trim();
  if (!trimmed) {
    return { isStandard: false, canonicalSpecialty: '' };
  }
  const key = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const canonical = STANDARD_SPECIALTY_LOOKUP.get(key);
  if (canonical) {
    return { isStandard: true, canonicalSpecialty: canonical };
  }
  return { isStandard: false, canonicalSpecialty: trimmed };
}

// Mapa auxiliar en minúsculas para normalizar variantes de capitalización o acentos básicos
const REVIEW_TAG_LOOKUP = new Map(
  REVIEW_MICRO_TAGS.map((tag) => [
    tag
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
    tag,
  ])
);

/**
 * Valida y normaliza un arreglo de micro-tags recibido desde el cliente al crear una reseña.
 * Descarta valores vacíos o fuera del catálogo permitido, elimina duplicados y limita a 6 tags.
 *
 * @param {unknown} rawTags - Arreglo opcional enviado en `req.body.tags`.
 * @returns {string[]} Lista limpia de etiquetas canónicas pertenecientes a `REVIEW_MICRO_TAGS`.
 */
function normalizeReviewTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];

  const unique = [];
  const seen = new Set();

  for (const item of rawTags) {
    if (typeof item !== 'string') continue;
    const key = item
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const canonical = REVIEW_TAG_LOOKUP.get(key);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      unique.push(canonical);
      if (unique.length >= REVIEW_MICRO_TAGS.length) break;
    }
  }

  return unique;
}

/**
 * Calcula la reputación integral de un prestador combinando calificación promedio,
 * volumen de trabajos conformados, historial de reclamos, vigencia documental y
 * estado operativo local (sin depender de acceso a base de datos).
 *
 * @param {object} metrics - Métricas consolidadas del prestador.
 * @param {number|string} [metrics.ratingAvg=0] - Promedio de estrellas (`0.0` a `5.0`).
 * @param {number} [metrics.reviewsCount=0] - Cantidad total de reseñas recibidas.
 * @param {number} [metrics.completedJobs=0] - Contratos finalizados/conformados.
 * @param {number} [metrics.totalJobs=0] - Total de contratos históricos.
 * @param {number} [metrics.disputesCount=0] - Reclamos o disputas post-servicio registradas.
 * @param {boolean} [metrics.hasExpiredDocs=false] - Si posee antecedentes o ART vencidos.
 * @param {boolean} [metrics.hasActiveLocalSuspension=false] - Si posee suspensión local activa.
 * @param {boolean} [metrics.isVerifiedMember=false] - Si tiene membresía Socio Verificado vigente.
 * @returns {{
 *   score: number,
 *   thermometer: 1|2|3|4|5,
 *   level: 'platinum'|'gold'|'silver'|'bronze'|'new'|'alert',
 *   level_label: string,
 *   tone: 'emerald'|'lime'|'amber'|'orange'|'rose'|'sky',
 *   dispute_rate: number,
 *   next_milestone: string
 * }} Snapshot estructurado listo para el directorio y el panel Mi Reputación.
 */
function computeProviderReputation(metrics = {}) {
  const ratingAvg = Math.max(0, Math.min(5, Number(metrics.ratingAvg || 0)));
  const reviewsCount = Math.max(0, Number(metrics.reviewsCount || 0));
  const completedJobs = Math.max(0, Number(metrics.completedJobs || 0));
  const totalJobs = Math.max(completedJobs, Number(metrics.totalJobs || 0));
  const disputesCount = Math.max(0, Number(metrics.disputesCount || 0));
  const hasExpiredDocs = Boolean(metrics.hasExpiredDocs);
  const hasActiveLocalSuspension = Boolean(metrics.hasActiveLocalSuspension);
  const isVerifiedMember = Boolean(metrics.isVerifiedMember);

  // Tasa de reclamos expresada en porcentaje (0..100) sobre contratos históricos
  const disputeRate =
    totalJobs > 0 ? Math.round((disputesCount / totalJobs) * 1000) / 10 : disputesCount > 0 ? 100 : 0;

  // Etapa 1: Si tiene documentación vencida o suspensión activa, el termómetro cae a alerta preventiva
  if (hasActiveLocalSuspension || hasExpiredDocs) {
    const score = hasActiveLocalSuspension ? 25 : 42;
    return {
      score,
      thermometer: hasActiveLocalSuspension ? 1 : 2,
      level: 'alert',
      level_label: hasActiveLocalSuspension ? 'Suspendido localmente' : 'Documentación por renovar',
      tone: hasActiveLocalSuspension ? 'rose' : 'orange',
      dispute_rate: disputeRate,
      next_milestone: hasActiveLocalSuspension
        ? 'Regularizá tu situación operativa con la administración de la comunidad.'
        : 'Renová tu ART y/o antecedentes penales para recuperar tu nivel y visibilidad máxima.',
    };
  }

  // Etapa 2: Prestador recién aprobado sin historial de trabajos ni reseñas todavía
  if (completedJobs === 0 && reviewsCount === 0 && disputesCount === 0) {
    return {
      score: 70,
      thermometer: 3,
      level: 'new',
      level_label: 'Nuevo Verificado',
      tone: 'sky',
      dispute_rate: 0,
      next_milestone:
        'Completá tus primeros 2 trabajos con conformidad en TrustLink para alcanzar el nivel Confiable.',
    };
  }

  // Etapa 3: Puntaje compuesto 0..100 (calidad de estrellas + trayectoria + penalización por reclamos)
  const effectiveRating = reviewsCount > 0 ? ratingAvg : 4.2;
  const ratingComponent = (effectiveRating / 5) * 65; // Hasta 65 pts por calidad de reseñas
  const volumeComponent = Math.min(25, completedJobs * 2.5); // Hasta 25 pts al llegar a 10 trabajos
  const complianceBonus = 10; // +10 pts por documentación vigente sin suspensiones
  const disputePenalty = Math.min(45, disputesCount * 15 + (disputeRate > 20 ? 10 : 0));

  const rawScore = Math.round(
    Math.max(10, Math.min(100, ratingComponent + volumeComponent + complianceBonus - disputePenalty))
  );

  // Etapa 4: Clasificación por nivel de mérito y barra de termómetro (1..5)
  const qualifiesPlatinum =
    (completedJobs >= 10 || (completedJobs >= 5 && isVerifiedMember)) &&
    effectiveRating >= 4.7 &&
    disputesCount === 0;

  if (qualifiesPlatinum) {
    return {
      score: Math.max(rawScore, 92),
      thermometer: 5,
      level: 'platinum',
      level_label: 'TrustLink Platino',
      tone: 'emerald',
      dispute_rate: disputeRate,
      next_milestone: 'Mantené tu documentación al día y 0 reclamos para conservar el nivel máximo.',
    };
  }

  const qualifiesGold =
    completedJobs >= 5 && effectiveRating >= 4.4 && disputeRate <= 10;

  if (qualifiesGold) {
    const remainingForPlatinum = Math.max(1, (isVerifiedMember ? 5 : 10) - completedJobs);
    return {
      score: Math.max(rawScore, 84),
      thermometer: 5,
      level: 'gold',
      level_label: 'Destacado Oro',
      tone: 'emerald',
      dispute_rate: disputeRate,
      next_milestone:
        disputesCount > 0
          ? 'Mantené una racha sin reclamos y calificación ≥ 4.7 para aspirar a TrustLink Platino.'
          : `Completá ${remainingForPlatinum} trabajo(s) más con conformidad y rating ≥ 4.7 para alcanzar TrustLink Platino.`,
    };
  }

  const qualifiesSilver =
    (completedJobs >= 2 || reviewsCount >= 2) && effectiveRating >= 4.0 && disputeRate <= 20;

  if (qualifiesSilver) {
    const remainingForGold = Math.max(1, 5 - completedJobs);
    return {
      score: Math.max(rawScore, 74),
      thermometer: 4,
      level: 'silver',
      level_label: 'Confiable',
      tone: 'lime',
      dispute_rate: disputeRate,
      next_milestone: `Completá ${remainingForGold} trabajo(s) más con conformidad y rating ≥ 4.4 para subir a Destacado Oro.`,
    };
  }

  if (rawScore >= 55) {
    return {
      score: rawScore,
      thermometer: 3,
      level: 'bronze',
      level_label: 'En crecimiento',
      tone: 'amber',
      dispute_rate: disputeRate,
      next_milestone:
        'Cerrá tus próximas visitas con conformidad y pedí reseña al residente para subir a nivel Confiable.',
    };
  }

  const hasDisputes = disputesCount > 0;
  const remainingForSilver = Math.max(1, 2 - completedJobs);
  const milestoneWithoutDisputes =
    completedJobs < 2
      ? `Completá ${remainingForSilver} trabajo(s) más con conformidad y calificación ≥ 4.0 para subir a nivel Confiable.`
      : 'Sumá trabajos conformados con calificación ≥ 4.0 para mejorar tu puntaje y subir a nivel Confiable.';

  return {
    score: rawScore,
    thermometer: rawScore >= 35 ? 2 : 1,
    level: 'bronze',
    level_label: hasDisputes ? 'Requiere mejora' : 'En crecimiento',
    tone: rawScore >= 35 ? 'orange' : 'rose',
    dispute_rate: disputeRate,
    next_milestone: hasDisputes
      ? 'Resolvé tus reclamos pendientes y sumá trabajos conformados con buenas reseñas para recuperar el termómetro verde.'
      : milestoneWithoutDisputes,
  };
}

/**
 * Sanitiza y normaliza los campos de la ficha comercial rápida del prestador (Fase 5.2):
 * urgencias 24h, política de presupuesto, facturación, medios de pago y descripción breve.
 *
 * @param {object} [raw={}] - Payload recibido desde el formulario del Portal Prestador.
 * @returns {{
 *   accepts_emergencies: boolean,
 *   quote_visit_policy: string,
 *   invoice_type: string,
 *   accepted_payment_methods: string[],
 *   service_bio: string|null
 * }} Objeto normalizado listo para persistir en `providers`.
 */
function normalizeCommercialProfileInput(raw = {}) {
  const acceptsEmergencies = Boolean(raw.accepts_emergencies);

  const rawQuote = String(raw.quote_visit_policy || 'consultar').trim().toLowerCase();
  const quoteVisitPolicy = ALLOWED_QUOTE_POLICIES.includes(rawQuote) ? rawQuote : 'consultar';

  const rawInvoice = String(raw.invoice_type || 'consultar').trim().toLowerCase();
  const invoiceType = ALLOWED_INVOICE_TYPES.includes(rawInvoice) ? rawInvoice : 'consultar';

  const rawMethods = Array.isArray(raw.accepted_payment_methods)
    ? raw.accepted_payment_methods
    : ['efectivo', 'transferencia', 'mercadopago'];
  const acceptedPaymentMethods = [];
  for (const m of rawMethods) {
    const norm = String(m || '').trim().toLowerCase();
    if (ALLOWED_PAYMENT_METHODS.includes(norm) && !acceptedPaymentMethods.includes(norm)) {
      acceptedPaymentMethods.push(norm);
    }
  }

  const bioClean =
    raw.service_bio !== undefined && raw.service_bio !== null
      ? String(raw.service_bio).trim().slice(0, 400)
      : '';

  return {
    accepts_emergencies: acceptsEmergencies,
    quote_visit_policy: quoteVisitPolicy,
    invoice_type: invoiceType,
    accepted_payment_methods: acceptedPaymentMethods,
    service_bio: bioClean || null,
  };
}

/**
 * Formatea una duración promedio en minutos a una etiqueta humana estilo marketplace
 * (ej.: `"Responde en < 15 min"`, `"Responde en ~35 min"`, `"Responde en ~2 h"`).
 *
 * @param {number|null} avgMinutes - Promedio en minutos o `null` si aún no hay muestras.
 * @returns {string|null} Etiqueta legible o `null`.
 */
function formatResponseTimeLabel(avgMinutes) {
  if (avgMinutes === null || avgMinutes === undefined || !Number.isFinite(avgMinutes)) {
    return null;
  }
  const rounded = Math.max(1, Math.round(avgMinutes));
  if (rounded < 15) return 'Responde en < 15 min';
  if (rounded < 60) return `Responde en ~${rounded} min`;
  const hours = Math.round(rounded / 60);
  if (hours <= 1) return 'Responde en ~1 h';
  if (hours <= 12) return `Responde en ~${hours} h`;
  if (hours <= 24) return 'Responde en el día';
  return 'Responde en +24 h';
}

/**
 * Calcula estadísticas de tiempo promedio de respuesta de un prestador a partir
 * de los hilos JSONB `messages` de `visit_requests`.
 * Para cada visita mide la diferencia entre el primer mensaje del residente (o `created_at`)
 * y la primera respuesta cuyo `sender_role` sea `'provider'`.
 *
 * @param {Array<{ created_at?: string|Date, messages?: Array|string }>} visitRows - Filas de visitas del prestador.
 * @returns {{ avg_response_minutes: number|null, response_label: string|null, answered_count: number }}
 */
function computeResponseTimeStats(visitRows = []) {
  if (!Array.isArray(visitRows) || visitRows.length === 0) {
    return { avg_response_minutes: null, response_label: null, answered_count: 0 };
  }

  const samplesMinutes = [];

  for (const row of visitRows) {
    let msgs = [];
    if (Array.isArray(row?.messages)) {
      msgs = row.messages;
    } else if (typeof row?.messages === 'string') {
      try {
        const parsed = JSON.parse(row.messages);
        if (Array.isArray(parsed)) msgs = parsed;
      } catch (_) {
        msgs = [];
      }
    }

    // Buscar la primera respuesta emitida por el prestador dentro del hilo
    const firstProviderMsg = msgs.find(
      (m) => String(m?.sender_role || '').toLowerCase() === 'provider' && m?.created_at
    );
    if (!firstProviderMsg) continue;

    // Tomar como inicio el primer mensaje del residente (o `created_at` de la visita)
    const firstResidentMsg = msgs.find(
      (m) => String(m?.sender_role || '').toLowerCase() !== 'provider' && m?.created_at
    );
    const startRaw = firstResidentMsg?.created_at || row?.created_at;
    const startMs = startRaw ? new Date(startRaw).getTime() : NaN;
    const replyMs = new Date(firstProviderMsg.created_at).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(replyMs)) continue;
    const diffMinutes = Math.max(1, (replyMs - startMs) / 60000);
    // Acotar outliers extremos (máximo 7 días) para no distorsionar el promedio histórico
    samplesMinutes.push(Math.min(diffMinutes, 7 * 24 * 60));
  }

  if (samplesMinutes.length === 0) {
    return { avg_response_minutes: null, response_label: null, answered_count: 0 };
  }

  const avgMinutes = Math.round(
    samplesMinutes.reduce((acc, v) => acc + v, 0) / samplesMinutes.length
  );

  return {
    avg_response_minutes: avgMinutes,
    response_label: formatResponseTimeLabel(avgMinutes),
    answered_count: samplesMinutes.length,
  };
}

module.exports = {
  REVIEW_MICRO_TAGS,
  ALLOWED_QUOTE_POLICIES,
  ALLOWED_INVOICE_TYPES,
  ALLOWED_PAYMENT_METHODS,
  STANDARD_SPECIALTIES_CATALOG,
  resolveSpecialtyCatalogMatch,
  normalizeReviewTags,
  normalizeCommercialProfileInput,
  formatResponseTimeLabel,
  computeResponseTimeStats,
  computeProviderReputation,
};
