/**
 * @file mercadopago.service.js
 * @description Servicio de integración con Mercado Pago Checkout Pro / Marketplace Split
 * usando `fetch` nativo de Node (sin dependencias externas). Soporta modo dual `mock | mercadopago`,
 * cálculo parametrizable de Take Rate (default 7%), creación de preferencias de pago,
 * consulta de pagos reales y validación criptográfica oficial de firma `x-signature` (ts + v1 HMAC-SHA256).
 * @location /trustlink-backend/src/modules/payments/mercadopago.service.js
 */

const crypto = require('crypto');

const MP_API_BASE = 'https://api.mercadopago.com';

const safeTimingEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Resuelve la configuración efectiva de la pasarela desde variables de entorno.
 */
function getGatewayConfig(env = process.env) {
  const accessToken = String(env.MP_ACCESS_TOKEN || '').trim();
  const rawMode = String(env.PAYMENT_GATEWAY_MODE || '').trim().toLowerCase();

  let mode = 'mock';
  if (rawMode === 'mercadopago') {
    mode = 'mercadopago';
  } else if (rawMode === 'mock') {
    mode = 'mock';
  } else if (accessToken) {
    mode = 'mercadopago';
  }

  const rawFee = Number(env.MP_PLATFORM_FEE_PERCENT);
  const platformFeePercent =
    !Number.isNaN(rawFee) && rawFee >= 0 && rawFee <= 25 ? rawFee : 7;

  const sandbox =
    String(env.MP_SANDBOX || '').trim().toLowerCase() === 'true' ||
    accessToken.startsWith('TEST-');

  const publicAppUrl = String(env.MP_PUBLIC_APP_URL || env.FRONTEND_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const webhookUrl = String(env.MP_WEBHOOK_URL || '').trim();

  return {
    mode,
    mpConfigured: Boolean(accessToken),
    accessToken,
    platformFeePercent,
    sandbox,
    publicAppUrl,
    webhookUrl,
  };
}

/**
 * Calcula el desglose financiero Take Rate plataforma / Neto prestador.
 */
function calculateSplit(totalAmount, feePercent = 7) {
  const total = Number(Number(totalAmount).toFixed(2));
  const rate = Number(feePercent) / 100;
  const platformFee = Number((total * rate).toFixed(2));
  const providerPayout = Number((total - platformFee).toFixed(2));
  return {
    totalAmount: total,
    feePercent: Number(feePercent),
    platformFee,
    providerPayout,
  };
}

/**
 * Mapea estados nativos de Mercado Pago al enum `payment_status` de TrustLink
 * ('pending' | 'approved' | 'released' | 'refunded').
 */
function mapMercadoPagoStatus(mpStatus) {
  const normalized = String(mpStatus || '').trim().toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (['refunded', 'charged_back', 'cancelled', 'rejected'].includes(normalized)) {
    return 'refunded';
  }
  return 'pending';
}

/**
 * Parsea `external_reference` (ej. `contract-42` o `42`) a ID numérico de contrato.
 */
function parseContractIdFromReference(externalReference) {
  if (!externalReference) return null;
  const match = String(externalReference).trim().match(/(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Valida la firma oficial de webhooks de Mercado Pago (`x-signature: ts=...,v1=...`)
 * usando el manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 */
function verifyMercadoPagoXSignature({
  xSignatureHeader,
  xRequestId = '',
  dataId = '',
  secret,
}) {
  if (!xSignatureHeader || !secret) return false;
  const parts = {};
  String(xSignatureHeader)
    .split(',')
    .forEach((segment) => {
      const [k, ...rest] = segment.split('=');
      if (k && rest.length > 0) {
        parts[k.trim().toLowerCase()] = rest.join('=').trim();
      }
    });

  if (!parts.ts || !parts.v1) return false;

  const manifestSegments = [];
  if (dataId !== undefined && dataId !== null && String(dataId).trim() !== '') {
    manifestSegments.push(`id:${String(dataId).trim()}`);
  }
  if (xRequestId && String(xRequestId).trim() !== '') {
    manifestSegments.push(`request-id:${String(xRequestId).trim()}`);
  }
  manifestSegments.push(`ts:${parts.ts}`);
  const manifest = `${manifestSegments.join(';')};`;

  const expectedHmac = crypto
    .createHmac('sha256', String(secret).trim())
    .update(manifest)
    .digest('hex')
    .toLowerCase();

  return safeTimingEqual(parts.v1.toLowerCase(), expectedHmac);
}

/**
 * Crea una preferencia real de Checkout Pro en Mercado Pago.
 */
async function createCheckoutPreference(
  {
    contractId,
    description,
    totalAmount,
    platformFee,
    payerEmail = null,
    sellerAccessToken = null,
  },
  { fetchImpl = globalThis.fetch, config = getGatewayConfig() } = {}
) {
  const tokenToUse = String(sellerAccessToken || config.accessToken || '').trim();
  if (!tokenToUse) {
    throw new Error(
      'Mercado Pago no configurado: definí MP_ACCESS_TOKEN o cambiá PAYMENT_GATEWAY_MODE=mock.'
    );
  }

  const payload = {
    items: [
      {
        id: `contract-${contractId}`,
        title: `TrustLink · Servicio #${contractId}`,
        description: String(description || 'Servicio verificado en TrustLink').slice(0, 250),
        quantity: 1,
        currency_id: 'ARS',
        unit_price: Number(Number(totalAmount).toFixed(2)),
      },
    ],
    external_reference: `contract-${contractId}`,
    statement_descriptor: 'TRUSTLINK',
  };

  if (payerEmail && String(payerEmail).includes('@')) {
    payload.payer = { email: String(payerEmail).trim() };
  }

  if (config.publicAppUrl) {
    payload.back_urls = {
      success: `${config.publicAppUrl}/?mp_status=approved&contract_id=${contractId}#payments`,
      pending: `${config.publicAppUrl}/?mp_status=pending&contract_id=${contractId}#payments`,
      failure: `${config.publicAppUrl}/?mp_status=rejected&contract_id=${contractId}#payments`,
    };
    if (config.publicAppUrl.startsWith('https://')) {
      payload.auto_return = 'approved';
    }
  }

  if (config.webhookUrl) {
    payload.notification_url = config.webhookUrl;
  }

  // En Marketplace Split (cuando el prestador conectó su cuenta OAuth), enviamos marketplace_fee
  if (sellerAccessToken && Number(platformFee) > 0) {
    payload.marketplace_fee = Number(Number(platformFee).toFixed(2));
  }

  const response = await fetchImpl(`${MP_API_BASE}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenToUse}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    const detail = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Error al crear preferencia en Mercado Pago: ${detail}`);
  }

  const checkoutUrl = config.sandbox
    ? data.sandbox_init_point || data.init_point
    : data.init_point || data.sandbox_init_point;

  return {
    preferenceId: String(data.id),
    initPoint: data.init_point || null,
    sandboxInitPoint: data.sandbox_init_point || null,
    checkoutUrl,
  };
}

/**
 * Consulta un pago real en la API de Mercado Pago (`GET /v1/payments/:id`).
 */
async function fetchMercadoPagoPayment(
  mpPaymentId,
  { fetchImpl = globalThis.fetch, config = getGatewayConfig() } = {}
) {
  if (!config.accessToken) {
    throw new Error('MP_ACCESS_TOKEN no configurado para consultar pagos de Mercado Pago.');
  }

  const response = await fetchImpl(
    `${MP_API_BASE}/v1/payments/${encodeURIComponent(String(mpPaymentId))}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
      },
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    const detail = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`No se pudo consultar el pago #${mpPaymentId} en Mercado Pago: ${detail}`);
  }

  return {
    paymentId: String(data.id),
    rawStatus: String(data.status || 'pending'),
    mappedStatus: mapMercadoPagoStatus(data.status),
    transactionAmount: Number(data.transaction_amount || 0),
    currencyId: data.currency_id || 'ARS',
    externalReference: data.external_reference || null,
    contractId: parseContractIdFromReference(data.external_reference),
  };
}

module.exports = {
  safeTimingEqual,
  getGatewayConfig,
  calculateSplit,
  mapMercadoPagoStatus,
  parseContractIdFromReference,
  verifyMercadoPagoXSignature,
  createCheckoutPreference,
  fetchMercadoPagoPayment,
};
