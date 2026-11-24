/**
 * @file complianceExpiry.test.js
 * @description Pruebas unitarias para el helper de vencimiento documental (ART, antecedentes y cuadrilla).
 * @location /trustlink-backend/test/complianceExpiry.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isExpiryDatePassed,
  findComplianceExpiryViolation,
} = require('../src/utils/complianceExpiry');

describe('complianceExpiry helper', () => {
  const ref = new Date('2026-11-24T12:00:00Z');

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
