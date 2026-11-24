/**
 * @file complianceExpiry.test.js
 * @description Pruebas unitarias para el helper de vencimiento documental (`complianceExpiry.js`).
 * Verifica las reglas de bloqueo por vencimiento de antecedentes penales, póliza ART del prestador
 * y póliza ART de ayudantes/cuadrilla adjuntos a un pase QR, usando una fecha de referencia fija.
 * @location /trustlink-backend/test/complianceExpiry.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isExpiryDatePassed,
  findComplianceExpiryViolation,
} = require('../src/utils/complianceExpiry');

// Suite unitaria determinista que evalúa vigencias contra una fecha de referencia controlada
describe('complianceExpiry helper', () => {
  // Fecha de referencia fija (2026-11-24) para asegurar reproducibilidad en cualquier momento
  const ref = new Date('2026-11-24T12:00:00Z');

  // Escenario: documentación ausente (`null`), con vencimiento en el mismo día o en fecha futura.
  // Precondiciones: prestador con antecedentes vigentes hoy, ART futura y ayudante con ART vigente.
  // Resultado esperado: `isExpiryDatePassed` devuelve `false` y no se detecta ninguna violación (`null`).
  it('permite documentos sin fecha o con fecha hoy/futura', () => {
    assert.equal(isExpiryDatePassed(null, ref), false);
    assert.equal(isExpiryDatePassed('2026-11-24', ref), false);
    assert.equal(isExpiryDatePassed('2027-01-15', ref), false);
    assert.equal(
      findComplianceExpiryViolation({
        criminalRecordExpiry: '2026-11-24',
        insuranceExpiry: '2027-03-01',
        authorizedEmployees: [{ full_name: 'Ayudante OK', insurance_expiry: '2027-01-01' }],
        referenceDate: ref,
      }),
      null
    );
  });

  // Escenario: intento de ingreso en garita con certificado de antecedentes penales vencido ayer.
  // Precondiciones: `criminalRecordExpiry` anterior a `ref` y póliza ART vigente en contexto `gate`.
  // Resultado esperado: devuelve violación con código `CRIMINAL_RECORD_EXPIRED` y fecha de vencimiento.
  it('bloquea con CRIMINAL_RECORD_EXPIRED cuando vencieron antecedentes penales', () => {
    const res = findComplianceExpiryViolation({
      criminalRecordExpiry: '2026-11-23',
      insuranceExpiry: '2027-03-01',
      context: 'gate',
      referenceDate: ref,
    });
    assert.ok(res);
    assert.equal(res.code, 'CRIMINAL_RECORD_EXPIRED');
    assert.equal(res.expiry_date, '2026-11-23');
  });

  // Escenario: intento de emisión de un Pase QR cuando la póliza ART del prestador titular venció.
  // Precondiciones: antecedentes vigentes, `insuranceExpiry` pasada y contexto `create`.
  // Resultado esperado: devuelve violación `INSURANCE_EXPIRED` con mensaje específico de emisión bloqueada.
  it('bloquea con INSURANCE_EXPIRED cuando venció la póliza ART del prestador', () => {
    const res = findComplianceExpiryViolation({
      criminalRecordExpiry: '2027-01-01',
      insuranceExpiry: '2026-10-01',
      context: 'create',
      referenceDate: ref,
    });
    assert.ok(res);
    assert.equal(res.code, 'INSURANCE_EXPIRED');
    assert.match(res.message, /No se puede emitir el pase QR/);
  });

  // Escenario: validación en garita de un pase con cuadrilla donde un ayudante tiene ART vencida.
  // Precondiciones: prestador titular al día, un ayudante vigente y un segundo ayudante vencido.
  // Resultado esperado: bloquea con `CREW_INSURANCE_EXPIRED` identificando el nombre del ayudante incumplidor.
  it('bloquea con CREW_INSURANCE_EXPIRED cuando un ayudante adjunto tiene ART vencida', () => {
    const res = findComplianceExpiryViolation({
      criminalRecordExpiry: '2027-01-01',
      insuranceExpiry: '2027-01-01',
      authorizedEmployees: [
        { full_name: 'Carlos OK', insurance_expiry: '2027-05-01' },
        { full_name: 'Mateo Vencido', insurance_expiry: '2026-09-10' },
      ],
      context: 'gate',
      referenceDate: ref,
    });
    assert.ok(res);
    assert.equal(res.code, 'CREW_INSURANCE_EXPIRED');
    assert.equal(res.employee_name, 'Mateo Vencido');
  });
});
