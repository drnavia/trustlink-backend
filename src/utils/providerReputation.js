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

  return {
    score: rawScore,
    thermometer: rawScore >= 35 ? 2 : 1,
    level: 'bronze',
    level_label: 'Requiere mejora',
    tone: rawScore >= 35 ? 'orange' : 'rose',
    dispute_rate: disputeRate,
    next_milestone:
      'Resolvé reclamos pendientes y sumá trabajos conformados con buenas reseñas para recuperar el termómetro verde.',
  };
}

module.exports = {
  REVIEW_MICRO_TAGS,
  normalizeReviewTags,
  computeProviderReputation,
};
