/**
 * @file providerReputation.test.js
 * @description Pruebas unitarias del motor de reputación estilo marketplace (`providerReputation.js`):
 * verifica normalización de micro-tags en reseñas, cálculo de termómetro (1..5), niveles de mérito
 * (`Nuevo Verificado`, `Confiable`, `Destacado Oro`, `TrustLink Platino`) y degradación por vencimientos.
 * @location /trustlink-backend/test/providerReputation.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  REVIEW_MICRO_TAGS,
  normalizeReviewTags,
  computeProviderReputation,
} = require('../src/utils/providerReputation');

describe('providerReputation helper', () => {
  // Caso 1: Sanitización de micro-tags (acentos, duplicados y descarte de tags fuera de catálogo)
  it('normaliza micro-tags válidos, ignora desconocidos y elimina duplicados', () => {
    const cleaned = normalizeReviewTags([
      'puntual',
      'Buena comunicacion',
      'PUNTUAL',
      'TagInventado',
      123,
      'Resolvió en el día',
    ]);
    assert.deepEqual(cleaned, ['Puntual', 'Buena comunicación', 'Resolvió en el día']);
    assert.equal(REVIEW_MICRO_TAGS.length, 6);
  });

  // Caso 2: Prestador recién aprobado sin historial previo recibe etiqueta "Nuevo Verificado"
  it('clasifica como Nuevo Verificado a un prestador sin trabajos ni reclamos', () => {
    const rep = computeProviderReputation({
      ratingAvg: 0,
      reviewsCount: 0,
      completedJobs: 0,
      disputesCount: 0,
      hasExpiredDocs: false,
    });
    assert.equal(rep.level, 'new');
    assert.equal(rep.thermometer, 3);
    assert.equal(rep.level_label, 'Nuevo Verificado');
  });

  // Caso 3: Escalado a Confiable, Destacado Oro y TrustLink Platino según mérito
  it('escala niveles Confiable -> Destacado Oro -> TrustLink Platino según trabajos y rating', () => {
    const silver = computeProviderReputation({
      ratingAvg: 4.3,
      reviewsCount: 2,
      completedJobs: 2,
      disputesCount: 0,
    });
    assert.equal(silver.level, 'silver');
    assert.equal(silver.thermometer, 4);

    const gold = computeProviderReputation({
      ratingAvg: 4.6,
      reviewsCount: 5,
      completedJobs: 5,
      disputesCount: 0,
      isVerifiedMember: false,
    });
    assert.equal(gold.level, 'gold');
    assert.equal(gold.thermometer, 5);

    const platinum = computeProviderReputation({
      ratingAvg: 4.9,
      reviewsCount: 5,
      completedJobs: 5,
      disputesCount: 0,
      isVerifiedMember: true,
    });
    assert.equal(platinum.level, 'platinum');
    assert.equal(platinum.thermometer, 5);
    assert.equal(platinum.level_label, 'TrustLink Platino');
  });

  // Caso 4: Documentación vencida o suspensión local degradan el termómetro inmediatamente
  it('degrada el termómetro a alerta si tiene documentación vencida o suspensión local', () => {
    const expired = computeProviderReputation({
      ratingAvg: 5,
      reviewsCount: 20,
      completedJobs: 20,
      hasExpiredDocs: true,
    });
    assert.equal(expired.level, 'alert');
    assert.equal(expired.thermometer, 2);

    const suspended = computeProviderReputation({
      ratingAvg: 5,
      reviewsCount: 20,
      completedJobs: 20,
      hasActiveLocalSuspension: true,
    });
    assert.equal(suspended.level, 'alert');
    assert.equal(suspended.thermometer, 1);
  });
});
