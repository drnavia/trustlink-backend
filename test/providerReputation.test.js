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
  STANDARD_SPECIALTIES_CATALOG,
  resolveSpecialtyCatalogMatch,
  normalizeReviewTags,
  normalizeCommercialProfileInput,
  computeResponseTimeStats,
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

  // Caso 2: Prestador recién registrado sin historial previo recibe etiqueta "Nuevo en TrustLink"
  it('clasifica como Nuevo en TrustLink a un prestador sin trabajos ni reclamos', () => {
    const rep = computeProviderReputation({
      ratingAvg: 0,
      reviewsCount: 0,
      completedJobs: 0,
      disputesCount: 0,
      hasExpiredDocs: false,
    });
    assert.equal(rep.level, 'new');
    assert.equal(rep.thermometer, 3);
    assert.equal(rep.level_label, 'Nuevo en TrustLink');
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

  // Caso 5: Normalización de la ficha comercial rápida (urgencias, presupuesto, factura y pagos)
  it('normaliza la ficha comercial rápida descartando valores inválidos', () => {
    const profile = normalizeCommercialProfileInput({
      accepts_emergencies: true,
      quote_visit_policy: 'sin_cargo',
      invoice_type: 'factura_c',
      accepted_payment_methods: ['efectivo', 'CRIPTOMONEDA', 'mercadopago', 'efectivo'],
      service_bio: '  Electricista matriculado para tableros y urgencias.  ',
    });
    assert.equal(profile.accepts_emergencies, true);
    assert.equal(profile.quote_visit_policy, 'sin_cargo');
    assert.equal(profile.invoice_type, 'factura_c');
    assert.deepEqual(profile.accepted_payment_methods, ['efectivo', 'mercadopago']);
    assert.equal(profile.service_bio, 'Electricista matriculado para tableros y urgencias.');
  });

  // Caso 6: Cálculo de tiempo promedio de respuesta desde hilos de `visit_requests`
  it('calcula tiempo promedio de respuesta y etiqueta legible desde visit_requests', () => {
    const stats = computeResponseTimeStats([
      {
        created_at: '2026-11-24T10:00:00.000Z',
        messages: [
          { sender_role: 'resident', created_at: '2026-11-24T10:00:00.000Z', text: 'Hola' },
          { sender_role: 'provider', created_at: '2026-11-24T10:20:00.000Z', text: 'Voy hoy' },
        ],
      },
      {
        created_at: '2026-11-24T12:00:00.000Z',
        messages: [
          { sender_role: 'resident', created_at: '2026-11-24T12:00:00.000Z', text: 'Consulta' },
          { sender_role: 'provider', created_at: '2026-11-24T12:40:00.000Z', text: 'Confirmado' },
        ],
      },
      {
        created_at: '2026-11-24T14:00:00.000Z',
        messages: [{ sender_role: 'resident', created_at: '2026-11-24T14:00:00.000Z', text: 'Sin respuesta' }],
      },
    ]);
    assert.equal(stats.answered_count, 2);
    assert.equal(stats.avg_response_minutes, 30);
    assert.equal(stats.response_label, 'Responde en ~30 min');
  });

  // Caso 7: Resolución de catálogo estándar oficial vs especialidad personalizada
  it('identifica rubros del catálogo estándar sin importar tildes/mayúsculas y detecta personalizados', () => {
    assert.ok(STANDARD_SPECIALTIES_CATALOG.length >= 15);
    const std = resolveSpecialtyCatalogMatch('  climatizacion ');
    assert.equal(std.isStandard, true);
    assert.equal(std.canonicalSpecialty, 'Climatización');

    const custom = resolveSpecialtyCatalogMatch('Instalador de Domótica KNX');
    assert.equal(custom.isStandard, false);
    assert.equal(custom.canonicalSpecialty, 'Instalador de Domótica KNX');
  });

  // Caso 8: Copy de próximo hito sin contradicciones cuando un prestador con puntaje bajo tiene 0 reclamos
  it('muestra próximo objetivo contextual sin mencionar reclamos cuando disputesCount es 0', () => {
    const noDisputes = computeProviderReputation({
      ratingAvg: 3.0,
      reviewsCount: 1,
      completedJobs: 1,
      disputesCount: 0,
    });
    assert.equal(noDisputes.level_label, 'En crecimiento');
    assert.ok(
      !noDisputes.next_milestone.toLowerCase().includes('reclamo'),
      'No debe pedir resolver reclamos cuando el prestador tiene 0 reclamos'
    );

    const withDisputes = computeProviderReputation({
      ratingAvg: 3.0,
      reviewsCount: 2,
      completedJobs: 2,
      disputesCount: 2,
    });
    assert.equal(withDisputes.level_label, 'Requiere mejora');
    assert.ok(withDisputes.next_milestone.toLowerCase().includes('reclamo'));
  });
});
