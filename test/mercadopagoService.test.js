/**
 * @file mercadopagoService.test.js
 * @description Suite de pruebas unitarias para `mercadopago.service.js`.
 * Valida la resolución de configuración dual (mock vs. Mercado Pago), el cálculo
 * del split de comisiones, el mapeo de estados/referencias, la verificación criptográfica
 * de la firma oficial `x-signature` y la creación/consulta de preferencias vía `fetch` inyectado.
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

// Suite unitaria sin dependencias de red ni base de datos para la lógica pura de pasarela
describe('mercadopago.service', () => {
  // Escenario: resolución automática y manual del modo de pasarela según variables de entorno.
  // Precondiciones: entornos simulados sin credenciales, con token TEST- (sandbox) y con override `mock`.
  // Resultado esperado: selecciona `mock` por defecto (comisión 7%), cambia a `mercadopago` sandbox
  // con token TEST- y comisión parametrizable, y respeta el forzado explícito a `mock`.
  it('resuelve modo dual mock/mercadopago, sandbox y comisión parametrizable', () => {
    // Caso 1: sin variables de entorno debe caer en modo mock y comisión base del 7%
    const mockCfg = getGatewayConfig({});
    assert.equal(mockCfg.mode, 'mock');
    assert.equal(mockCfg.platformFeePercent, 7);

    // Caso 2: token TEST- activa automáticamente Mercado Pago en modo sandbox y comisión del 8%
    const autoMpCfg = getGatewayConfig({
      MP_ACCESS_TOKEN: 'TEST-123456',
      MP_PLATFORM_FEE_PERCENT: '8',
    });
    assert.equal(autoMpCfg.mode, 'mercadopago');
    assert.equal(autoMpCfg.sandbox, true);
    assert.equal(autoMpCfg.platformFeePercent, 8);

    // Caso 3: aun con credenciales productivas, PAYMENT_GATEWAY_MODE='mock' fuerza el modo simulado
    const forcedMock = getGatewayConfig({
      MP_ACCESS_TOKEN: 'APP_USR-999',
      PAYMENT_GATEWAY_MODE: 'mock',
    });
    assert.equal(forcedMock.mode, 'mock');
    assert.equal(forcedMock.mpConfigured, true);
  });

  // Escenario: cálculo exacto del split entre comisión de TrustLink y monto neto del prestador.
  // Precondiciones: montos enteros y con centavos bajo distintos porcentajes de comisión (7% y 8%).
  // Resultado esperado: redondeo consistente a 2 decimales cuya suma coincide con el total acordado.
  it('calcula split plataforma / neto prestador con precisión de 2 decimales', () => {
    const split7 = calculateSplit(10000, 7);
    assert.equal(split7.platformFee, 700);
    assert.equal(split7.providerPayout, 9300);

    const split8 = calculateSplit(12345.67, 8);
    assert.equal(split8.platformFee, 987.65);
    assert.equal(split8.providerPayout, 11358.02);
  });

  // Escenario: normalización de estados nativos de Mercado Pago al modelo interno y parseo de referencias.
  // Precondiciones: estados de pago de MP (`approved`, `in_process`, `rejected`, `refunded`) y formatos
  // de `external_reference` (`contract-42`, `99`, cadena inválida).
  // Resultado esperado: mapeo correcto a estados internos y extracción segura del ID numérico (o `null`).
  it('mapea estados nativos de MP y extrae contractId de external_reference', () => {
    assert.equal(mapMercadoPagoStatus('approved'), 'approved');
    assert.equal(mapMercadoPagoStatus('in_process'), 'pending');
    assert.equal(mapMercadoPagoStatus('rejected'), 'refunded');
    assert.equal(mapMercadoPagoStatus('refunded'), 'refunded');

    assert.equal(parseContractIdFromReference('contract-42'), 42);
    assert.equal(parseContractIdFromReference('99'), 99);
    assert.equal(parseContractIdFromReference('invalid'), null);
  });

  // Escenario: validación criptográfica del encabezado oficial `x-signature` de webhooks de Mercado Pago.
  // Precondiciones: secreto compartido, timestamp `ts`, `x-request-id`, `dataId` y firma HMAC-SHA256
  // calculada sobre el manifiesto estándar `id:<dataId>;request-id:<reqId>;ts:<ts>;`.
  // Resultado esperado: acepta la firma íntegra (`true`) y rechaza alteraciones en `x-request-id` (`false`).
  it('valida firma oficial x-signature de Mercado Pago (ts + v1 HMAC-SHA256)', () => {
    const secret = 'mp_webhook_test_secret';
    const ts = '1732450000';
    const reqId = 'req-abc-123';
    const dataId = '987654321';
    const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    // Caso positivo: todos los componentes del manifiesto coinciden con la firma v1
    assert.equal(
      verifyMercadoPagoXSignature({
        xSignatureHeader: `ts=${ts},v1=${v1}`,
        xRequestId: reqId,
        dataId,
        secret,
      }),
      true
    );

    // Caso negativo: manipulación del x-request-id debe invalidar la verificación HMAC
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

  // Escenario: integración con los endpoints de Checkout Pro y consulta de pagos de Mercado Pago sin red real.
  // Precondiciones: configuración en modo sandbox y doble de prueba `mockFetch` inyectado para capturar
  // URL/payload enviados y devolver respuestas simuladas de preferencia y pago aprobado.
  // Resultado esperado: envía `external_reference` y `auto_return` correctos, retorna URL de sandbox
  // y traduce correctamente el pago consultado (`paymentId`, `mappedStatus`, `contractId`).
  it('crea preferencia real de Checkout Pro y consulta pago vía fetch inyectado', async () => {
    let capturedUrl = '';
    let capturedBody = null;

    /**
     * Doble de prueba que sustituye `fetch` global para interceptar llamadas a la API de Mercado Pago.
     * Captura la URL y el cuerpo JSON de cada solicitud y devuelve respuestas simuladas para
     * creación de preferencias (`/checkout/preferences`) y consulta de pagos individuales.
     *
     * @param {string} url - Endpoint de la API de Mercado Pago invocado por el servicio.
     * @param {RequestInit} [opts] - Opciones de la solicitud HTTP (incluye `body` en POST).
     * @returns {Promise<{ok: boolean, status: number, json: () => Promise<object>}>} Respuesta HTTP simulada.
     */
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

    // Paso 1: crear preferencia de pago y verificar payload enviado + URL de checkout sandbox
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

    // Paso 2: consultar pago por ID y verificar normalización de estado y contrato asociado
    const payment = await fetchMercadoPagoPayment('555777', {
      fetchImpl: mockFetch,
      config: cfg,
    });
    assert.equal(payment.paymentId, '555777');
    assert.equal(payment.mappedStatus, 'approved');
    assert.equal(payment.contractId, 12);
  });
});
