/**
 * @file mercadopagoService.test.js
 * @description Pruebas unitarias del servicio de Mercado Pago Checkout Pro / Split y firma oficial x-signature.
 * @location /trustlink-backend/test/mercadopagoService.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  getGatewayConfig,
  calculateSplit,
  mapMercadoPagoStatus,
  parseContractIdFromReference,
  verifyMercadoPagoXSignature,
  createCheckoutPreference,
  fetchMercadoPagoPayment,
} = require('../src/modules/payments/mercadopago.service');

describe('mercadopago.service', () => {
  it('resuelve modo dual mock/mercadopago, sandbox y comisión parametrizable', () => {
    const mockCfg = getGatewayConfig({});
    assert.equal(mockCfg.mode, 'mock');
    assert.equal(mockCfg.platformFeePercent, 7);

    const autoMpCfg = getGatewayConfig({
      MP_ACCESS_TOKEN: 'TEST-123456',
      MP_PLATFORM_FEE_PERCENT: '8',
    });
    assert.equal(autoMpCfg.mode, 'mercadopago');
    assert.equal(autoMpCfg.sandbox, true);
    assert.equal(autoMpCfg.platformFeePercent, 8);

    const forcedMock = getGatewayConfig({
      MP_ACCESS_TOKEN: 'APP_USR-999',
      PAYMENT_GATEWAY_MODE: 'mock',
    });
    assert.equal(forcedMock.mode, 'mock');
    assert.equal(forcedMock.mpConfigured, true);
  });

  it('calcula split plataforma / neto prestador con precisión de 2 decimales', () => {
    const split7 = calculateSplit(10000, 7);
    assert.equal(split7.platformFee, 700);
    assert.equal(split7.providerPayout, 9300);

    const split8 = calculateSplit(12345.67, 8);
    assert.equal(split8.platformFee, 987.65);
    assert.equal(split8.providerPayout, 11358.02);
  });

  it('mapea estados nativos de MP y extrae contractId de external_reference', () => {
    assert.equal(mapMercadoPagoStatus('approved'), 'approved');
    assert.equal(mapMercadoPagoStatus('in_process'), 'pending');
    assert.equal(mapMercadoPagoStatus('rejected'), 'refunded');
    assert.equal(mapMercadoPagoStatus('refunded'), 'refunded');

    assert.equal(parseContractIdFromReference('contract-42'), 42);
    assert.equal(parseContractIdFromReference('99'), 99);
    assert.equal(parseContractIdFromReference('invalid'), null);
  });

  it('valida firma oficial x-signature de Mercado Pago (ts + v1 HMAC-SHA256)', () => {
    const secret = 'mp_webhook_test_secret';
    const ts = '1732450000';
    const reqId = 'req-abc-123';
    const dataId = '987654321';
    const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    assert.equal(
      verifyMercadoPagoXSignature({
        xSignatureHeader: `ts=${ts},v1=${v1}`,
        xRequestId: reqId,
        dataId,
        secret,
      }),
      true
    );

    assert.equal(
      verifyMercadoPagoXSignature({
        xSignatureHeader: `ts=${ts},v1=${v1}`,
        xRequestId: 'wrong-request-id',
        dataId,
        secret,
      }),
      false
    );
  });

  it('crea preferencia real de Checkout Pro y consulta pago vía fetch inyectado', async () => {
    let capturedUrl = '';
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      if (opts?.body) capturedBody = JSON.parse(opts.body);
      if (url.includes('/checkout/preferences')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'PREF-999',
            init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=PREF-999',
            sandbox_init_point: 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=PREF-999',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 555777,
          status: 'approved',
          transaction_amount: 50000,
          currency_id: 'ARS',
          external_reference: 'contract-12',
        }),
      };
    };

    const cfg = getGatewayConfig({
      MP_ACCESS_TOKEN: 'TEST-token-123',
      MP_PUBLIC_APP_URL: 'https://trustlink-web-mauve.vercel.app',
      MP_WEBHOOK_URL: 'https://trustlink-backend-production.up.railway.app/api/v1/payments/webhook',
    });

    const pref = await createCheckoutPreference(
      {
        contractId: 12,
        description: 'Instalación tablero eléctrico',
        totalAmount: 50000,
        platformFee: 3500,
        payerEmail: 'vecino@example.com',
      },
      { fetchImpl: mockFetch, config: cfg }
    );

    assert.equal(capturedUrl, 'https://api.mercadopago.com/checkout/preferences');
    assert.equal(capturedBody.external_reference, 'contract-12');
    assert.equal(capturedBody.auto_return, 'approved');
    assert.equal(pref.preferenceId, 'PREF-999');
    assert.match(pref.checkoutUrl, /sandbox\.mercadopago\.com/);

    const payment = await fetchMercadoPagoPayment('555777', {
      fetchImpl: mockFetch,
      config: cfg,
    });
    assert.equal(payment.paymentId, '555777');
    assert.equal(payment.mappedStatus, 'approved');
    assert.equal(payment.contractId, 12);
  });
});
