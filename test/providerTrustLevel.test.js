/**
 * @file providerTrustLevel.test.js
 * @description Pruebas unitarias del motor puro de Confianza Progresiva v2 (`N0..N4`) + Eje Comercial desacoplado.
 * Verifica la escalera de insignias, la visibilidad temprana en directorio desde Nivel 1,
 * la habilitación de Pase QR desde Nivel 3, el sello oficial N4 y la desacoplación de Destacado.
 * @location /trustlink-backend/test/providerTrustLevel.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeProviderTrustLevel, isExpiryDatePast } = require('../src/utils/providerTrustLevel');

test('Nivel 0: oculto si falta celular validado, DNI validado o especialidad visible', () => {
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
  assert.equal(res.tone, 'slate');
  assert.equal(res.visible_in_directory, true);
  assert.equal(res.is_verified, false);
  assert.equal(res.can_issue_pass, false);
  assert.equal(res.can_subscribe_verified_partner, false);
  assert.equal(res.checks.identity_ok, true);
  assert.equal(res.checks.criminal_ok, false);
  assert.equal(res.checks.art_ok, false);
  assert.equal(res.checks.pass_qr_ok, false);
});

test('Nivel 2 (En verificación): seguro cargado con o sin antecedentes en revisión, aún sin Pase QR', () => {
  const onlyArt = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasArtDoc: true,
  });
  assert.equal(onlyArt.level, 2);
  assert.equal(onlyArt.tier, 'insurance_review');
  assert.equal(onlyArt.label, 'En verificación');
  assert.equal(onlyArt.tone, 'indigo');
  assert.equal(onlyArt.can_issue_pass, false);

  const bothDocs = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasArtDoc: true,
    hasCriminalDoc: true,
    complianceApproved: false,
  });
  assert.equal(bothDocs.level, 2);
  assert.equal(bothDocs.tier, 'docs_in_review');
  assert.equal(bothDocs.label, 'En verificación');
  assert.equal(bothDocs.tone, 'indigo');
  assert.equal(bothDocs.visible_in_directory, true);
  assert.equal(bothDocs.is_verified, false);
  assert.equal(bothDocs.can_issue_pass, false);
});

test('Nivel 3 (Pase QR habilitado), Nivel 4 (Verificado) y Eje Comercial (Destacado desacoplado)', () => {
  // Aunque tenga flag de membresía, sin compliance aprobado NO puede ser Destacado ni N3
  const paidWithoutCompliance = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: false,
    isVerifiedMember: true,
  });
  assert.equal(paidWithoutCompliance.level, 2);
  assert.equal(paidWithoutCompliance.is_featured_partner, false);
  assert.equal(paidWithoutCompliance.can_issue_pass, false);

  // Con compliance aprobado y vigente -> Nivel 3 (Pase QR habilitado)
  const qrEnabled = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: true,
    autoVerified: false,
    isVerifiedMember: true,
  });
  assert.equal(qrEnabled.level, 3);
  assert.equal(qrEnabled.label, 'Pase QR habilitado');
  assert.equal(qrEnabled.tone, 'emerald');
  assert.equal(qrEnabled.is_verified, true);
  assert.equal(qrEnabled.is_featured_partner, true);
  assert.equal(qrEnabled.can_issue_pass, true);
  assert.equal(qrEnabled.can_subscribe_verified_partner, true);

  // Con compliance aprobado + cotejo automático de PDFs -> Nivel 4 (Verificado)
  const verified = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    complianceApproved: true,
    autoVerified: true,
    isVerifiedMember: false,
  });
  assert.equal(verified.level, 4);
  assert.equal(verified.label, 'Verificado');
  assert.equal(verified.tone, 'sky');
  assert.equal(verified.is_verified, true);
  assert.equal(verified.is_auto_verified, true);
  assert.equal(verified.is_featured_partner, false);
  assert.equal(verified.can_issue_pass, true);
});

test('Degradación automática ante documentación vencida y evaluación de fechas', () => {
  const expired = computeProviderTrustLevel({
    identityVerified: true,
    hasVisibleSpecialty: true,
    hasCriminalDoc: true,
    hasArtDoc: true,
    artExpired: true,
    complianceApproved: true,
    autoVerified: true,
    isVerifiedMember: true,
  });
  assert.equal(expired.tier, 'docs_expired');
  assert.equal(expired.tone, 'danger');
  assert.equal(expired.is_verified, false);
  assert.equal(expired.is_featured_partner, false);
  assert.equal(expired.can_issue_pass, false);
  assert.equal(expired.has_expired_docs, true);

  const refDate = new Date('2026-11-25T12:00:00Z');
  assert.equal(isExpiryDatePast('2026-11-24', refDate), true);
  assert.equal(isExpiryDatePast('2026-11-25', refDate), false);
  assert.equal(isExpiryDatePast('2026-12-01', refDate), false);
});
