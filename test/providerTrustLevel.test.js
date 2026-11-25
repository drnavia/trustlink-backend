/**
 * @file providerTrustLevel.test.js
 * @description Pruebas unitarias del motor puro de Confianza Progresiva (Fase 6.1, niveles 0..5).
 * Verifica la escalera de insignias, la visibilidad temprana en directorio desde Nivel 1,
 * el resguardo estricto de Pase QR y la exigencia de Nivel 4 antes de otorgar Nivel 5 (Socio Verificado).
 * @location /trustlink-backend/test/providerTrustLevel.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeProviderTrustLevel, isExpiryDatePast } = require('../src/utils/providerTrustLevel');

test('Nivel 0: oculto si falta validación de identidad o especialidad visible', () => {
  const noIdentity = computeProviderTrustLevel({
    identityVerified: false,
    hasVisibleSpecialty: true,
  });
  assert.equal(noIdentity.level, 0);
  assert.equal(noIdentity.visible_in_directory, false);
  assert.equal(noIdentity.can_issue_pass, false);

  const noSpec = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: false,
  });
  assert.equal(noSpec.level, 0);
  assert.equal(noSpec.visible_in_directory, false);
});

test('Nivel 1 (Perfil Básico): visible en directorio con identidad validada + rubro, pero sin Pase QR', () => {
  const res = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
  });
  assert.equal(res.level, 1);
  assert.equal(res.tier, 'basic');
  assert.equal(res.label, 'Perfil Básico');
  assert.equal(res.visible_in_directory, true);
  assert.equal(res.is_verified, false);
  assert.equal(res.can_issue_pass, false);
  assert.equal(res.can_subscribe_verified_partner, false);
});

test('Nivel 2 (Respaldo Parcial): reconoce Antecedentes o ART por separado', () => {
  const onlyCrim = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
  });
  assert.equal(onlyCrim.level, 2);
  assert.equal(onlyCrim.label, 'Antecedentes al día');
  assert.equal(onlyCrim.can_issue_pass, false);

  const onlyArt = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasArtDoc: true,
  });
  assert.equal(onlyArt.level, 2);
  assert.equal(onlyArt.label, 'ART al día');
});

test('Nivel 3 (Doc. en validación): ambos documentos vigentes cargados esperando aprobación', () => {
  const res = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: false,
  });
  assert.equal(res.level, 3);
  assert.equal(res.tier, 'docs_complete');
  assert.equal(res.visible_in_directory, true);
  assert.equal(res.is_verified, false);
  assert.equal(res.can_issue_pass, false);
});

test('Nivel 4 (Verificado) y Nivel 5 (Socio Verificado): exige Nivel 4 obligatorio para el tilde dorado', () => {
  // Aunque tenga flag de membresía, sin compliance aprobado NO puede ser Nivel 5
  const paidWithoutCompliance = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: false,
    isVerifiedMember: true,
  });
  assert.equal(paidWithoutCompliance.level, 3);
  assert.equal(paidWithoutCompliance.is_verified, false);

  // Con compliance aprobado y vigente -> Nivel 4 (Verificado)
  const verified = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: true,
    isVerifiedMember: false,
  });
  assert.equal(verified.level, 4);
  assert.equal(verified.label, 'Verificado');
  assert.equal(verified.is_verified, true);
  assert.equal(verified.can_issue_pass, true);
  assert.equal(verified.can_subscribe_verified_partner, true);

  // Con compliance aprobado + suscripción activa -> Nivel 5 (Socio Verificado dorado)
  const partner = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: true,
    isVerifiedMember: true,
  });
  assert.equal(partner.level, 5);
  assert.equal(partner.label, 'Socio Verificado');
  assert.equal(partner.tone, 'gold');
  assert.equal(partner.is_verified, true);
  assert.equal(partner.can_issue_pass, true);
});

test('Degradación automática ante documentación vencida y evaluación de fechas', () => {
  const expired = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    artExpired: true,
    complianceApproved: true,
    isVerifiedMember: true,
  });
  assert.equal(expired.tier, 'docs_expired');
  assert.equal(expired.is_verified, false);
  assert.equal(expired.can_issue_pass, false);
  assert.equal(expired.has_expired_docs, true);

  const refDate = new Date('2026-11-25T12:00:00Z');
  assert.equal(isExpiryDatePast('2026-11-24', refDate), true);
  assert.equal(isExpiryDatePast('2026-11-25', refDate), false);
  assert.equal(isExpiryDatePast('2026-12-01', refDate), false);
});
