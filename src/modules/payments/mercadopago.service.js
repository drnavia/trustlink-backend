/**
 * @file mercadopago.service.js
 * @description Servicio de integración con Mercado Pago Checkout Pro / Marketplace Split
 * usando `fetch` nativo de Node (sin dependencias externas). Soporta modo dual `mock | mercadopago`,
 * cálculo parametrizable de Take Rate (default 7%), creación de preferencias de pago,
 * consulta de pagos reales y validación criptográfica oficial de firma `x-signature` (ts + v1 HMAC-SHA256).
 * @location /trustlink-backend/src/modules/payments/mercadopago.service.js
 */

const crypto = require('crypto');

// URL base oficial de la API REST de Mercado Pago
const MP_API_BASE = 'https://api.mercadopago.com';

/**
 * Compara dos cadenas en tiempo constante usando `crypto.timingSafeEqual` para mitigar
 * ataques de temporización (timing attacks) al validar firmas HMAC de webhooks.
 * Rechaza inmediatamente si alguno de los buffers está vacío o difiere en longitud.
 *
 * @param {string} a - Primera cadena (ej. firma `v1` recibida).
 * @param {string} b - Segunda cadena (ej. HMAC-SHA256 esperado).
 * @returns {boolean} `true` solo si ambas cadenas coinciden exactamente.
 */
const safeTimingEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Resuelve la configuración efectiva de la pasarela desde variables de entorno:
 * modo operativo (`mock` vs `mercadopago`), Take Rate de plataforma (0..25%, default 7%),
 * detección automática de entorno `sandbox` (por flag o prefijo `TEST-` del token)
 * y URLs públicas de retorno y webhook.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Diccionario de variables de entorno.
 * @returns {{ mode: string, mpConfigured: boolean, accessToken: string, platformFeePercent: number, sandbox: boolean, publicAppUrl: string, webhookUrl: string }}
 */
function getGatewayConfig(env = process.env) {
  // 1. Determinar modo efectivo: respeta PAYMENT_GATEWAY_MODE o activa 'mercadopago' si hay token
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

  // 2. Validar Take Rate en rango seguro (0% a 25%); si es inválido o ausente, usar 7%
  const rawFee = Number(env.MP_PLATFORM_FEE_PERCENT);
  const platformFeePercent =
    !Number.isNaN(rawFee) && rawFee >= 0 && rawFee <= 25 ? rawFee : 7;

  // 3. Detectar modo sandbox y normalizar URLs de redirección y notificación IPN/Webhook
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
 * Calcula el desglose financiero Take Rate plataforma / Neto a acreditar al prestador,
 * redondeando todos los importes a 2 decimales y asegurando `platformFee + providerPayout = totalAmount`.
 *
 * @param {number|string} totalAmount - Monto total acordado del servicio.
 * @param {number} [feePercent=7] - Porcentaje de comisión de TrustLink.
 * @returns {{ totalAmount: number, feePercent: number, platformFee: number, providerPayout: number }}
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
 * Mapea estados nativos de Mercado Pago al enum `payment_status` interno de TrustLink
 * (`'pending'` | `'approved'` | `'released'` | `'refunded'`).
 * Estados de rechazo, cancelación o contracargo se unifican bajo `'refunded'`.
 *
 * @param {string} mpStatus - Estado devuelto por la API de Mercado Pago.
 * @returns {'approved'|'refunded'|'pending'} Estado equivalente en TrustLink.
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
 * Parsea `external_reference` (ej. `"contract-42"` o `"42"`) extrayendo el ID numérico
 * final del contrato en TrustLink.
 *
 * @param {string|number|null|undefined} externalReference - Referencia externa recibida de Mercado Pago.
 * @returns {number|null} ID entero positivo del contrato o `null` si no puede parsearse.
 */
function parseContractIdFromReference(externalReference) {
  if (!externalReference) return null;
  const match = String(externalReference).trim().match(/(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Valida la firma criptográfica oficial de webhooks de Mercado Pago (`x-signature: ts=...,v1=...`)
 * construyendo el manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, calculando
 * su HMAC-SHA256 con el secreto de webhook y comparando `v1` en tiempo constante.
 *
 * @param {{ xSignatureHeader: string, xRequestId?: string, dataId?: string|number, secret: string }} params
 * @returns {boolean} `true` si la firma `x-signature` es auténtica.
 */
function verifyMercadoPagoXSignature({
  xSignatureHeader,
  xRequestId = '',
  dataId = '',
  secret,
}) {
  // 1. Verificar presencia de encabezado y secreto, y parsear pares `clave=valor` separados por coma
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

  // 2. Armar el manifest oficial omitiendo segmentos vacíos (`id`, `request-id`) y cerrando siempre con `ts`
  const manifestSegments = [];
  if (dataId !== undefined && dataId !== null && String(dataId).trim() !== '') {
    manifestSegments.push(`id:${String(dataId).trim()}`);
  }
  if (xRequestId && String(xRequestId).trim() !== '') {
    manifestSegments.push(`request-id:${String(xRequestId).trim()}`);
  }
  manifestSegments.push(`ts:${parts.ts}`);
  const manifest = `${manifestSegments.join(';')};`;

  // 3. Calcular HMAC-SHA256 esperado y validar en tiempo constante contra `v1`
  const expectedHmac = crypto
    .createHmac('sha256', String(secret).trim())
    .update(manifest)
    .digest('hex')
    .toLowerCase();

  return safeTimingEqual(parts.v1.toLowerCase(), expectedHmac);
}

/**
 * Crea una preferencia real de Checkout Pro en Mercado Pago (`POST /checkout/preferences`).
 * Si se provee `sellerAccessToken` (cuenta OAuth del prestador conectada) y `platformFee > 0`,
 * incluye `marketplace_fee` para ejecutar Marketplace Split automáticamente.
 *
 * @param {{ contractId: number|string, description?: string, totalAmount: number|string, platformFee?: number, payerEmail?: string|null, sellerAccessToken?: string|null }} order
 * @param {{ fetchImpl?: typeof fetch, config?: ReturnType<typeof getGatewayConfig> }} [options]
 * @returns {Promise<{ preferenceId: string, initPoint: string|null, sandboxInitPoint: string|null, checkoutUrl: string|null }>}
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
  // 1. Resolver token de autorización (prioriza token OAuth del vendedor sobre el de plataforma)
  const tokenToUse = String(sellerAccessToken || config.accessToken || '').trim();
  if (!tokenToUse) {
    throw new Error(
      'Mercado Pago no configurado: definí MP_ACCESS_TOKEN o cambiá PAYMENT_GATEWAY_MODE=mock.'
    );
  }

  // 2. Construir payload base de Checkout Pro en ARS vinculado al contrato vía `external_reference`
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

  // 3. Adjuntar opcionalmente email del pagador, URLs de retorno, webhook y comisión Marketplace Split
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

  // 4. Invocar la API de preferencias de Mercado Pago y validar respuesta HTTP/JSON
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

  // 5. Seleccionar URL de checkout según entorno (`sandbox_init_point` vs `init_point`)
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
 * Consulta un pago real en la API de Mercado Pago (`GET /v1/payments/:id`)
 * para conciliar su estado real (ej. al recibir un webhook) y devuelve un resumen
 * normalizado con `mappedStatus` y `contractId`.
 *
 * @param {string|number} mpPaymentId - Identificador del pago en Mercado Pago.
 * @param {{ fetchImpl?: typeof fetch, config?: ReturnType<typeof getGatewayConfig> }} [options]
 * @returns {Promise<{ paymentId: string, rawStatus: string, mappedStatus: string, transactionAmount: number, currencyId: string, externalReference: string|null, contractId: number|null }>}
 */
async function fetchMercadoPagoPayment(
  mpPaymentId,
  { fetchImpl = globalThis.fetch, config = getGatewayConfig() } = {}
) {
  // 1. Verificar credencial configurada y consultar el detalle del pago en la API REST de Mercado Pago
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

  // 2. Validar respuesta y mapear los datos crudos del pago al modelo de TrustLink
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
