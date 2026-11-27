/**
 * @file payments.controller.js
 * @description Lógica de negocio para el Módulo de Pagos, Contratos, Escrow y Reclamos de TrustLink.
 * Gestiona el ciclo completo de órdenes de servicio: creación y cotización in situ, cálculo de split
 * financiero (Take Rate configurable, por defecto 7% plataforma / 93% neto prestador), modo dual de
 * pasarela (`mock` local y `mercadopago` Checkout Pro), validación de webhooks firmados (secreto
 * compartido, `x-signature` oficial de MP y HMAC-SHA256), conformidad final con liberación de escrow,
 * generación del Comprobante del Hogar auditable, resumen de ingresos del prestador y disputas post-servicio.
 * @location /trustlink-backend/src/modules/payments/payments.controller.js
 */

const crypto = require('crypto');
const db = require('../../config/db');
const {
  safeTimingEqual,
  getGatewayConfig,
  calculateSplit,
  verifyMercadoPagoXSignature,
  createCheckoutPreference,
  fetchMercadoPagoPayment,
} = require('./mercadopago.service');

// Estados válidos aceptados para transiciones de pago en `transactions`
const ALLOWED_PAYMENT_STATUSES = ['pending', 'approved', 'released', 'refunded'];
// Estados válidos del ciclo de vida de un reclamo/garantía en `service_disputes`
const ALLOWED_DISPUTE_STATUSES = ['open', 'in_review', 'resolved', 'rejected'];

/**
 * Asegura de forma idempotente que la tabla `transactions` disponga de las columnas necesarias
 * para operar en modo dual (`mock` / `mercadopago`): identificador de preferencia (`preference_id`),
 * URL de redirección (`checkout_url`), modo de pasarela (`gateway_mode`), estado crudo devuelto por
 * el proveedor externo (`gateway_raw_status`) y marca de actualización (`updated_at`).
 *
 * @returns {Promise<void>}
 */
const ensureTransactionGatewayColumns = async () => {
  await db.query(`
    ALTER TABLE public.transactions
      ADD COLUMN IF NOT EXISTS preference_id VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS checkout_url TEXT NULL,
      ADD COLUMN IF NOT EXISTS gateway_mode VARCHAR(30) NOT NULL DEFAULT 'mock',
      ADD COLUMN IF NOT EXISTS gateway_raw_status VARCHAR(60) NULL,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW();
  `);
};

/**
 * Asegura de forma idempotente el esquema requerido para el cierre con conformidad del residente
 * (`completed_at`, `completion_notes` en `service_contracts`) y la tabla `service_disputes`
 * destinada a registrar reclamos/garantías post-servicio con evidencias y resolución de Ops.
 *
 * @returns {Promise<void>}
 */
const ensureCompletionAndDisputesSchema = async () => {
  await db.query(`
    ALTER TABLE public.service_contracts
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITHOUT TIME ZONE NULL,
      ADD COLUMN IF NOT EXISTS completion_notes TEXT NULL,
      ADD COLUMN IF NOT EXISTS visit_request_id INTEGER NULL;
  `);
  await db.query(`
    ALTER TABLE public.access_passes
      ADD COLUMN IF NOT EXISTS visit_request_id INTEGER NULL;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.service_disputes (
      id SERIAL PRIMARY KEY,
      contract_id INTEGER NOT NULL REFERENCES public.service_contracts(id) ON DELETE CASCADE,
      opened_by_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      reason VARCHAR(120) NOT NULL,
      details TEXT NOT NULL,
      evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      resolution_notes TEXT NULL,
      resolved_by INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMP WITHOUT TIME ZONE NULL
    );
  `);
};

/**
 * Devuelve la configuración pública de la pasarela de pagos activa (`mock` o `mercadopago`),
 * indicando si Mercado Pago está configurado, si opera en sandbox y el porcentaje de comisión
 * (Take Rate, por defecto 7%) sin exponer secretos ni tokens privados.
 * GET /api/v1/payments/config
 *
 * @param {import('express').Request} req - Solicitud HTTP entrante.
 * @param {import('express').Response} res - Respuesta HTTP con parámetros públicos de la pasarela.
 * @returns {Promise<import('express').Response>}
 */
const getPaymentGatewayPublicConfig = async (req, res) => {
  const config = getGatewayConfig();
  return res.status(200).json({
    gateway_mode: config.mode,
    mp_configured: config.mpConfigured,
    sandbox: config.sandbox,
    platform_fee_percent: config.platformFeePercent,
  });
};

/**
 * Valida la autenticidad de un webhook de pagos mediante comparación segura en tiempo constante
 * (`safeTimingEqual`) aceptando tres estrategias en orden de prioridad:
 * 1) Secreto compartido directo en header `x-webhook-secret`,
 * 2) Firma oficial de Mercado Pago (`x-signature: ts=...,v1=...`) cruzada con `x-request-id` y `data.id`,
 * 3) Firma HMAC-SHA256 del cuerpo crudo (`req.rawBody`) enviada en `x-webhook-signature` o `x-signature`.
 *
 * @param {import('express').Request} req - Solicitud HTTP del webhook entrante.
 * @returns {{ ok: true, mode: 'shared_secret'|'mp_x_signature'|'hmac_sha256' } | { ok: false, status: number, error: string }}
 */
const verifyWebhookAuth = (req) => {
  // Etapa 1: Verificar que exista un secreto de webhook configurado en variables de entorno
  const expectedSecret = String(
    process.env.PAYMENT_WEBHOOK_SECRET || process.env.MP_WEBHOOK_SECRET || ''
  ).trim();

  if (!expectedSecret) {
    return {
      ok: false,
      status: 503,
      error: 'Webhook de pagos no configurado en el servidor (defina PAYMENT_WEBHOOK_SECRET).',
    };
  }

  // Etapa 2: Estrategia 1 — comparación en tiempo constante del header `x-webhook-secret`
  const providedSecret = String(req.headers['x-webhook-secret'] || '').trim();
  if (providedSecret && safeTimingEqual(providedSecret, expectedSecret)) {
    return { ok: true, mode: 'shared_secret' };
  }

  // Etapa 3: Estrategia 2 — firma oficial de Mercado Pago (`x-signature: ts=...,v1=...`)
  const mpSignatureHeader = String(req.headers['x-signature'] || '').trim();
  if (mpSignatureHeader && mpSignatureHeader.includes('v1=')) {
    const dataId =
      req.query?.['data.id'] ||
      req.body?.data?.id ||
      req.body?.gateway_payment_id ||
      '';
    const xRequestId = String(req.headers['x-request-id'] || '').trim();
    if (
      verifyMercadoPagoXSignature({
        xSignatureHeader: mpSignatureHeader,
        xRequestId,
        dataId,
        secret: expectedSecret,
      })
    ) {
      return { ok: true, mode: 'mp_x_signature' };
    }
  }

  // Etapa 4: Estrategia 3 — verificación HMAC-SHA256 del payload crudo (`req.rawBody` o JSON de respaldo)
  const rawSignatureHeader = String(
    req.headers['x-webhook-signature'] || req.headers['x-signature'] || ''
  ).trim();

  if (rawSignatureHeader) {
    const cleanSig = rawSignatureHeader.replace(/^sha256=/i, '').trim().toLowerCase();
    const rawPayload = req.rawBody
      ? req.rawBody
      : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    const expectedHmac = crypto
      .createHmac('sha256', expectedSecret)
      .update(rawPayload)
      .digest('hex')
      .toLowerCase();

    if (safeTimingEqual(cleanSig, expectedHmac)) {
      return { ok: true, mode: 'hmac_sha256' };
    }
  }

  // Etapa 5: Rechazar cuando ningún método de autenticación coincide
  return {
    ok: false,
    status: 401,
    error: 'Firma o secreto de webhook de pagos inválido o ausente.',
  };
};

/**
 * Lista todos los contratos de servicio pertenecientes al residente autenticado (`owner_id`),
 * enriquecidos con datos del prestador, estado de conformidad y resumen de reclamos/disputas.
 * GET /api/v1/contracts
 *
 * @param {import('express').Request} req - Solicitud HTTP del residente autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con el historial de contratos.
 * @returns {Promise<import('express').Response>}
 */
const listMyContracts = async (req, res) => {
  try {
    await ensureCompletionAndDisputesSchema();
    const owner_id = req.user.userId;

    // Consulta principal: une `service_contracts` con `providers` y `users`, e incluye
    // subconsultas correlacionadas para contar disputas abiertas y conocer el último estado de reclamo
    const query = `
      SELECT
        sc.id,
        sc.country_id,
        sc.owner_id,
        sc.provider_id,
        sc.pass_id,
        COALESCE(sc.visit_request_id, ap.visit_request_id) AS visit_request_id,
        sc.description,
        sc.agreed_amount,
        sc.status,
        sc.created_at,
        sc.completed_at,
        sc.completion_notes,
        u.first_name,
        u.last_name,
        TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS provider_name,
        COALESCE(p.specialty, 'Profesional Verificado') AS specialty,
        p.rating_avg,
        p.status AS provider_status,
        (
          SELECT COUNT(*)::int
          FROM public.service_disputes sd
          WHERE sd.contract_id = sc.id AND sd.status IN ('open', 'in_review')
        ) AS open_disputes_count,
        (
          SELECT sd.status
          FROM public.service_disputes sd
          WHERE sd.contract_id = sc.id
          ORDER BY sd.id DESC
          LIMIT 1
        ) AS latest_dispute_status
      FROM service_contracts sc
      LEFT JOIN access_passes ap ON sc.pass_id = ap.id
      JOIN providers p ON sc.provider_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE sc.owner_id = $1
      ORDER BY sc.created_at DESC, sc.id DESC;
    `;

    const result = await db.query(query, [owner_id]);

    return res.status(200).json({
      count: result.rows.length,
      contracts: result.rows,
    });
  } catch (error) {
    console.error('Error al listar contratos del residente:', error);
    return res.status(500).json({ error: 'Error interno del servidor al consultar contratos.' });
  }
};

/**
 * Crea un nuevo contrato / orden de servicio en estado `'pending'` para el residente autenticado,
 * pudiendo vincularlo opcionalmente a un pase QR existente (`pass_id`) del cual hereda
 * `provider_id` y `country_id` si no fueron informados explícitamente.
 * POST /api/v1/contracts
 *
 * @param {import('express').Request} req - Solicitud HTTP con `description`, `agreed_amount`, `provider_id` y/o `pass_id`.
 * @param {import('express').Response} res - Respuesta HTTP con el contrato creado (201).
 * @returns {Promise<import('express').Response>}
 */
const createContract = async (req, res) => {
  try {
    await ensureCompletionAndDisputesSchema();
    // Etapa 1: Validar descripción obligatoria y monto acordado estrictamente mayor a cero
    const ownerId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const { provider_id, pass_id, visit_request_id, description, agreed_amount } = req.body || {};

    const cleanDescription = String(description || '').trim();
    const numericAmount = Number(agreed_amount);

    if (!cleanDescription || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: 'Indicá la descripción del trabajo y un monto acordado mayor a cero.',
      });
    }

    let resolvedProviderId = provider_id ? Number(provider_id) : null;
    let resolvedPassId = pass_id ? Number(pass_id) : null;
    let resolvedVisitRequestId =
      visit_request_id && !Number.isNaN(Number(visit_request_id))
        ? Number(visit_request_id)
        : null;
    let effectiveCountryId = req.user.countryId ? Number(req.user.countryId) : null;

    // Etapa 2: Si se vincula a un pase QR, validar existencia, propiedad del residente y heredar prestador/comunidad/visita
    if (resolvedPassId) {
      const passRes = await db.query(
        'SELECT id, owner_id, provider_id, country_id, visit_request_id FROM access_passes WHERE id = $1 LIMIT 1',
        [resolvedPassId]
      );
      if (passRes.rows.length === 0) {
        return res.status(404).json({ error: 'El pase QR seleccionado no existe.' });
      }
      const passRow = passRes.rows[0];
      if (userRole !== 'superadmin' && Number(passRow.owner_id) !== ownerId) {
        return res.status(403).json({
          error: 'No tenés permisos para generar una orden con un pase de otro residente.',
        });
      }
      resolvedProviderId = resolvedProviderId || Number(passRow.provider_id);
      effectiveCountryId = effectiveCountryId || (passRow.country_id ? Number(passRow.country_id) : null);
      resolvedVisitRequestId =
        resolvedVisitRequestId || (passRow.visit_request_id ? Number(passRow.visit_request_id) : null);
    }

    // Etapa 2.5: Si viene vinculado a una solicitud de visita, validar pertenencia y heredar prestador si faltara
    if (resolvedVisitRequestId) {
      const vrRes = await db
        .query(
          'SELECT id, owner_id, provider_id, country_id FROM visit_requests WHERE id = $1 LIMIT 1',
          [resolvedVisitRequestId]
        )
        .catch(() => ({ rows: [] }));
      if (vrRes.rows.length > 0) {
        const vrRow = vrRes.rows[0];
        if (userRole !== 'superadmin' && Number(vrRow.owner_id) !== ownerId) {
          resolvedVisitRequestId = null;
        } else {
          resolvedProviderId = resolvedProviderId || Number(vrRow.provider_id);
          effectiveCountryId =
            effectiveCountryId || (vrRow.country_id ? Number(vrRow.country_id) : null);
        }
      } else {
        resolvedVisitRequestId = null;
      }
    }

    // Etapa 3: Validar existencia del prestador y resolver `country_id` de respaldo desde su usuario
    if (!resolvedProviderId || Number.isNaN(resolvedProviderId)) {
      return res.status(400).json({ error: 'Debe indicar un prestador válido.' });
    }

    const providerCheck = await db.query(
      `SELECT p.id, u.country_id
       FROM providers p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1
       LIMIT 1`,
      [resolvedProviderId]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
    }

    effectiveCountryId =
      effectiveCountryId ||
      (providerCheck.rows[0].country_id ? Number(providerCheck.rows[0].country_id) : null);

    // Etapa 4: Insertar la orden de servicio en estado `'pending'` con monto normalizado a 2 decimales
    const insertRes = await db.query(
      `INSERT INTO service_contracts (
         country_id, owner_id, provider_id, pass_id, visit_request_id, description, agreed_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [
        effectiveCountryId,
        ownerId,
        resolvedProviderId,
        resolvedPassId,
        resolvedVisitRequestId,
        cleanDescription,
        Number(numericAmount.toFixed(2)),
      ]
    );

    return res.status(201).json({
      message: 'Orden de contratación generada correctamente. Ya podés aprobar y pagar.',
      contract: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al crear contrato de servicio:', error);
    return res.status(500).json({ error: 'Error interno al crear la orden de contratación.' });
  }
};

/**
 * Obtiene únicamente los contratos en estado `'pending'` (pendientes de pago) del residente autenticado,
 * ordenados del más reciente al más antiguo para el flujo de checkout.
 * Roles permitidos: `'owner'`, `'family'`, `'superadmin'`.
 * GET /api/v1/payments/pending
 *
 * @param {import('express').Request} req - Solicitud HTTP del residente autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con los contratos pendientes de cobro.
 * @returns {Promise<import('express').Response>}
 */
const getPendingContracts = async (req, res) => {
  try {
    const owner_id = req.user.userId;

    // Consulta de contratos pendientes del titular con datos visibles del prestador asignado
    const query = `
      SELECT
        sc.id,
        sc.country_id,
        sc.owner_id,
        sc.provider_id,
        sc.pass_id,
        sc.description,
        sc.agreed_amount,
        sc.status,
        sc.created_at,
        u.first_name,
        u.last_name,
        TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS provider_name,
        COALESCE(p.specialty, 'Profesional Verificado') AS specialty,
        p.rating_avg,
        p.status AS provider_status
      FROM service_contracts sc
      JOIN providers p ON sc.provider_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE sc.owner_id = $1 AND sc.status = 'pending'
      ORDER BY sc.created_at DESC, sc.id DESC;
    `;

    const result = await db.query(query, [owner_id]);

    return res.status(200).json({
      count: result.rows.length,
      contracts: result.rows
    });
  } catch (error) {
    console.error('Error al obtener contratos pendientes:', error);
    return res.status(500).json({ error: 'Error interno del servidor al consultar contratos.' });
  }
};

/**
 * Procesa el checkout de un contrato pendiente aplicando el split financiero (Take Rate
 * configurable, por defecto 7% comisión TrustLink / 93% liquidación neta al prestador).
 * Soporta modo dual de pasarela:
 * - `mercadopago`: crea una preferencia real en Checkout Pro, guarda la transacción `'pending'`
 *   con `MP-PREF-<id>` y responde `requires_redirect: true` junto a `checkout_url`.
 * - `mock`: acredita instantáneamente la transacción como `'approved'` y transiciona el contrato
 *   a `'in_progress'` para entornos piloto o pruebas locales.
 * Soporta POST /api/v1/payments/checkout y POST /api/v1/contracts/:id/pay.
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` o `body.contract_id`.
 * @param {import('express').Response} res - Respuesta HTTP con transacción y datos de redirección o acreditación.
 * @returns {Promise<import('express').Response>}
 */
const checkoutContractPayment = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas de pasarela, leer configuración activa y validar ID del contrato
    await ensureTransactionGatewayColumns();
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const contractId = Number(req.params.id || req.body?.contract_id);
    const gatewayProvider = String(req.body?.payment_method || 'mercadopago').trim() || 'mercadopago';
    const config = getGatewayConfig();

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un contrato válido para abonar.' });
    }

    // Etapa 2: Consultar el contrato y validar existencia, titularidad, estado 'pending' y monto positivo
    const contractRes = await db.query(
      `SELECT id, owner_id, provider_id, agreed_amount, status, description
       FROM service_contracts
       WHERE id = $1
       LIMIT 1`,
      [contractId]
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato de servicio no encontrado.' });
    }

    const contract = contractRes.rows[0];
    if (userRole !== 'superadmin' && Number(contract.owner_id) !== userId) {
      return res.status(403).json({ error: 'No tenés permisos para abonar este contrato.' });
    }

    if (String(contract.status).toLowerCase() !== 'pending') {
      return res.status(400).json({
        error: `El contrato #${contractId} no está pendiente de pago (estado actual: ${contract.status}).`,
      });
    }

    const totalAmount = Number(contract.agreed_amount);
    if (Number.isNaN(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ error: 'El monto del contrato es inválido.' });
    }

    // Etapa 3: Calcular el split financiero (7% comisión TrustLink / 93% neto prestador por defecto)
    const { platformFee, providerPayout, feePercent } = calculateSplit(
      totalAmount,
      config.platformFeePercent
    );

    // Etapa 4A (Modo `mercadopago`): generar preferencia Checkout Pro y persistir transacción 'pending'
    if (config.mode === 'mercadopago') {
      const preference = await createCheckoutPreference(
        {
          contractId,
          description: contract.description,
          totalAmount,
          platformFee,
          payerEmail: req.user?.email || null,
        },
        { config }
      );

      const pendingGatewayId = `MP-PREF-${preference.preferenceId}`;
      const txResult = await db.query(
        `INSERT INTO transactions (
           contract_id, gateway_provider, gateway_payment_id,
           preference_id, checkout_url, gateway_mode, gateway_raw_status,
           total_amount, platform_fee, provider_payout, status
         )
         VALUES ($1, 'mercadopago', $2, $3, $4, 'mercadopago', 'preference_created', $5, $6, $7, 'pending')
         RETURNING id, contract_id, gateway_provider, gateway_payment_id, preference_id, checkout_url, gateway_mode, total_amount, platform_fee, provider_payout, status, created_at`,
        [
          contractId,
          pendingGatewayId,
          preference.preferenceId,
          preference.checkoutUrl,
          totalAmount,
          platformFee,
          providerPayout,
        ]
      );

      return res.status(200).json({
        message: 'Preferencia de Mercado Pago generada. Redirigiendo al checkout seguro...',
        gateway_mode: 'mercadopago',
        requires_redirect: true,
        checkout_url: preference.checkoutUrl,
        preference_id: preference.preferenceId,
        contract,
        transaction: txResult.rows[0],
      });
    }

    // Etapa 4B (Modo `mock`): acreditar instantáneamente la transacción y pasar el contrato a 'in_progress'
    const mockGatewayId = `MP-PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const txResult = await db.query(
      `INSERT INTO transactions (
         contract_id, gateway_provider, gateway_payment_id,
         gateway_mode, gateway_raw_status,
         total_amount, platform_fee, provider_payout, status
       )
       VALUES ($1, $2, $3, 'mock', 'approved_mock', $4, $5, $6, 'approved')
       RETURNING id, contract_id, gateway_provider, gateway_payment_id, gateway_mode, total_amount, platform_fee, provider_payout, status, created_at`,
      [contractId, gatewayProvider, mockGatewayId, totalAmount, platformFee, providerPayout]
    );

    const updatedContract = await db.query(
      `UPDATE service_contracts
       SET status = 'in_progress'::contract_status
       WHERE id = $1
       RETURNING *`,
      [contractId]
    );

    return res.status(200).json({
      message: `Pago acreditado correctamente. Comisión de plataforma (${feePercent}%) y liquidación (${100 - feePercent}%) registradas.`,
      gateway_mode: 'mock',
      requires_redirect: false,
      contract: updatedContract.rows[0],
      transaction: txResult.rows[0],
    });
  } catch (error) {
    console.error('Error al procesar checkout del contrato:', error);
    return res.status(500).json({
      error: error.message || 'Error interno al procesar el pago del contrato.',
    });
  }
};

/**
 * Registra o actualiza el presupuesto acordado in situ (`agreed_amount`) sobre un contrato
 * existente y genera una nueva orden de pago `'pending'` con split 7%/93% (configurable),
 * emitiendo enlace simulado (`mock`) o preferencia Checkout Pro (`mercadopago`).
 * Roles permitidos: `'provider'`, `'owner'`, `'family'`, `'superadmin'`.
 * POST /api/v1/payments/quote
 *
 * @param {import('express').Request} req - Solicitud HTTP con `contract_id` y `agreed_amount`.
 * @param {import('express').Response} res - Respuesta HTTP con `checkout_url` y transacción creada (201).
 * @returns {Promise<import('express').Response>}
 */
const createOrUpdateQuote = async (req, res) => {
  try {
    // Etapa 1: Validar parámetros de cotización y verificar que el usuario sea participante del contrato
    await ensureTransactionGatewayColumns();
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const { contract_id, agreed_amount } = req.body;
    const config = getGatewayConfig();

    if (!contract_id || !agreed_amount || Number(agreed_amount) <= 0) {
      return res.status(400).json({ error: 'Datos inválidos. Especifique un contrato y un monto acordado válido.' });
    }

    const ownershipCheck = await db.query(
      `SELECT sc.id, sc.owner_id, p.user_id AS provider_user_id
       FROM service_contracts sc
       LEFT JOIN providers p ON p.id = sc.provider_id
       WHERE sc.id = $1
       LIMIT 1`,
      [contract_id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato de servicio no encontrado.' });
    }

    const existing = ownershipCheck.rows[0];
    const isParticipant =
      userRole === 'superadmin' ||
      Number(existing.owner_id) === userId ||
      Number(existing.provider_user_id) === userId;

    if (!isParticipant) {
      return res.status(403).json({ error: 'No tenés permisos para cotizar este contrato.' });
    }

    // Etapa 2: Actualizar monto acordado en `service_contracts` (estado 'pending') y calcular split 7%/93%
    const updateQuery = `
      UPDATE service_contracts
      SET agreed_amount = $1, status = 'pending'
      WHERE id = $2
      RETURNING id, owner_id, provider_id, description, agreed_amount, status;
    `;

    const contractResult = await db.query(updateQuery, [agreed_amount, contract_id]);

    const contract = contractResult.rows[0];
    const { totalAmount, platformFee, providerPayout } = calculateSplit(
      Number(contract.agreed_amount),
      config.platformFeePercent
    );

    // Etapa 3: Construir enlace de checkout según modo activo (simulado en mock o preferencia real en MP)
    let gatewayPaymentId = `MP-TX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let preferenceId = null;
    let checkoutUrl = `https://checkout.mercadopago.com/simulate/${gatewayPaymentId}`;

    if (config.mode === 'mercadopago') {
      const preference = await createCheckoutPreference(
        {
          contractId: contract.id,
          description: contract.description,
          totalAmount,
          platformFee,
          payerEmail: req.user?.email || null,
        },
        { config }
      );
      preferenceId = preference.preferenceId;
      gatewayPaymentId = `MP-PREF-${preference.preferenceId}`;
      checkoutUrl = preference.checkoutUrl;
    }

    // Etapa 4: Registrar la orden de pago `'pending'` en `transactions` y retornar URL de checkout
    const insertTx = `
      INSERT INTO transactions (
        contract_id, gateway_provider, gateway_payment_id,
        preference_id, checkout_url, gateway_mode,
        total_amount, platform_fee, provider_payout, status
      )
      VALUES ($1, 'mercadopago', $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id, gateway_payment_id, preference_id, checkout_url, gateway_mode, total_amount, platform_fee, provider_payout, status;
    `;

    const txResult = await db.query(insertTx, [
      contract_id,
      gatewayPaymentId,
      preferenceId,
      checkoutUrl,
      config.mode,
      totalAmount,
      platformFee,
      providerPayout,
    ]);

    return res.status(201).json({
      message: 'Orden de pago generada con éxito.',
      gateway_mode: config.mode,
      checkout_url: checkoutUrl,
      preference_id: preferenceId,
      transaction: txResult.rows[0]
    });
  } catch (error) {
    console.error('Error al procesar la cotización:', error);
    return res.status(500).json({ error: error.message || 'Error interno al procesar la cotización.' });
  }
};

/**
 * Procesa confirmaciones asíncronas de pago vía webhook firmado (secreto compartido,
 * `x-signature` oficial de Mercado Pago o HMAC-SHA256).
 * Soporta tanto payloads directos (`{ gateway_payment_id, status }`) como notificaciones
 * reales de Mercado Pago (`{ type: 'payment', data: { id } }`), aplicando idempotencia,
 * protección contra regresión de estados y transición automática de `service_contracts`.
 * POST /api/v1/payments/webhook
 *
 * @param {import('express').Request} req - Solicitud HTTP firmada desde la pasarela de pagos.
 * @param {import('express').Response} res - Respuesta HTTP confirmando procesamiento o idempotencia.
 * @returns {Promise<import('express').Response>}
 */
const confirmPayment = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas de pasarela y autenticar la firma/secreto del webhook
    await ensureTransactionGatewayColumns();
    const authCheck = verifyWebhookAuth(req);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }

    // Etapa 2: Extraer datos del evento; si es notificación oficial de MP, consultar detalle real vía API
    const eventType = String(req.body?.type || req.query?.type || '').trim().toLowerCase();
    const mpDataId = req.body?.data?.id || req.query?.['data.id'] || null;

    let gatewayPaymentId = req.body?.gateway_payment_id
      ? String(req.body.gateway_payment_id).trim()
      : null;
    let normalizedStatus = String(req.body?.status || '').trim().toLowerCase();
    let gatewayRawStatus = normalizedStatus || null;
    let resolvedContractId = null;

    // Notificación oficial de Mercado Pago: { type: 'payment', data: { id: '123456' } }
    if (!gatewayPaymentId && eventType === 'payment' && mpDataId) {
      const mpPayment = await fetchMercadoPagoPayment(mpDataId);
      gatewayPaymentId = mpPayment.paymentId;
      normalizedStatus = mpPayment.mappedStatus;
      gatewayRawStatus = mpPayment.rawStatus;
      resolvedContractId = mpPayment.contractId;
    }

    // Etapa 3: Validar obligatoriedad de identificador/estado y pertenencia a la lista blanca
    if (!gatewayPaymentId || !normalizedStatus) {
      return res.status(400).json({ error: 'Faltan datos de la pasarela de pagos.' });
    }

    if (!ALLOWED_PAYMENT_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Estado de pago inválido. Valores permitidos: ${ALLOWED_PAYMENT_STATUSES.join(', ')}.`,
      });
    }

    // Etapa 4: Localizar la transacción por `gateway_payment_id` o por último registro del `contract_id`
    let existingTxRes = await db.query(
      'SELECT id, contract_id, status, gateway_payment_id FROM transactions WHERE gateway_payment_id = $1 LIMIT 1',
      [gatewayPaymentId]
    );

    // Si vino desde Mercado Pago por primera vez (la fila se creó con MP-PREF-<id>), buscamos por contract_id
    if (existingTxRes.rows.length === 0 && resolvedContractId) {
      existingTxRes = await db.query(
        `SELECT id, contract_id, status, gateway_payment_id
         FROM transactions
         WHERE contract_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [resolvedContractId]
      );
    }

    if (existingTxRes.rows.length === 0) {
      return res.status(404).json({ error: 'Transacción no encontrada.' });
    }

    // Etapa 5: Garantizar idempotencia ante reintentos y bloquear regresiones inválidas de estado
    const currentTx = existingTxRes.rows[0];
    const currentStatus = String(currentTx.status || '').toLowerCase();

    if (currentStatus === normalizedStatus && currentTx.gateway_payment_id === gatewayPaymentId) {
      return res.status(200).json({
        message: `Transacción ya registrada en estado: ${normalizedStatus}`,
        transaction_id: currentTx.id,
        idempotent: true,
        verification_mode: authCheck.mode,
      });
    }

    if (['released', 'refunded'].includes(currentStatus) && normalizedStatus === 'pending') {
      return res.status(409).json({
        error: `No se puede revertir una transacción desde '${currentStatus}' a 'pending'.`,
      });
    }

    // Etapa 6: Actualizar la transacción y propagar la transición correspondiente al contrato
    const updateTx = `
      UPDATE transactions
      SET status = $1::payment_status,
          gateway_payment_id = $2,
          gateway_raw_status = COALESCE($3, gateway_raw_status),
          updated_at = NOW()
      WHERE id = $4
      RETURNING id, contract_id, gateway_payment_id, status;
    `;

    const txResult = await db.query(updateTx, [
      normalizedStatus,
      gatewayPaymentId,
      gatewayRawStatus,
      currentTx.id,
    ]);
    const transaction = txResult.rows[0];

    // Reglas de sincronización contrato <-> pago:
    // - `approved` (fondos acreditados/en escrow) -> pasa contrato de 'pending' a 'in_progress'
    // - `released` (fondos liberados al prestador) -> marca contrato como 'completed'
    if (normalizedStatus === 'approved') {
      await db.query(
        `UPDATE service_contracts
         SET status = 'in_progress'::contract_status
         WHERE id = $1 AND status = 'pending'::contract_status`,
        [transaction.contract_id]
      );
    } else if (normalizedStatus === 'released') {
      await db.query(
        `UPDATE service_contracts
         SET status = 'completed'::contract_status
         WHERE id = $1 AND status IN ('pending'::contract_status, 'in_progress'::contract_status)`,
        [transaction.contract_id]
      );
    }

    return res.status(200).json({
      message: `Transacción procesada con estado: ${normalizedStatus}`,
      transaction_id: transaction.id,
      verification_mode: authCheck.mode,
    });
  } catch (error) {
    console.error('Error al confirmar pago:', error);
    return res.status(500).json({ error: error.message || 'Error interno al confirmar el pago.' });
  }
};

/**
 * Registra la conformidad final del residente titular sobre un contrato de servicio:
 * marca el contrato como `'completed'` con timestamp y notas de cierre, y libera
 * automáticamente los fondos en escrow pasando transacciones `'approved'` a `'released'`.
 * PATCH /api/v1/contracts/:id/complete
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` y `body.completion_notes` opcional.
 * @param {import('express').Response} res - Respuesta HTTP con el contrato cerrado y cantidad de pagos liberados.
 * @returns {Promise<import('express').Response>}
 */
const completeContract = async (req, res) => {
  try {
    // Etapa 1: Asegurar esquemas dependientes, validar `contractId` y normalizar notas de conformidad
    await Promise.all([ensureTransactionGatewayColumns(), ensureCompletionAndDisputesSchema()]);
    const contractId = Number(req.params.id);
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const completionNotes = req.body?.completion_notes
      ? String(req.body.completion_notes).trim()
      : null;

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'ID de contrato inválido.' });
    }

    // Etapa 2: Validar existencia, titularidad del residente (o superadmin) y reglas de estado
    const contractRes = await db.query(
      'SELECT id, owner_id, provider_id, status, completed_at, completion_notes FROM service_contracts WHERE id = $1 LIMIT 1',
      [contractId]
    );
    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato de servicio no encontrado.' });
    }

    const contract = contractRes.rows[0];
    if (userRole !== 'superadmin' && Number(contract.owner_id) !== userId) {
      return res.status(403).json({ error: 'Solo el residente titular puede dar conformidad a este contrato.' });
    }

    const currentStatus = String(contract.status || '').toLowerCase();
    if (currentStatus === 'cancelled') {
      return res.status(400).json({ error: 'No se puede completar un contrato cancelado.' });
    }

    // Respuesta idempotente si la conformidad ya había sido registrada previamente
    if (currentStatus === 'completed') {
      return res.status(200).json({
        message: `El contrato #${contractId} ya se encontraba completado con conformidad.`,
        contract,
        released_transactions_count: 0,
        idempotent: true,
      });
    }

    // Etapa 3: Cerrar formalmente el contrato registrando `completed_at` y notas de conformidad
    const updatedRes = await db.query(
      `UPDATE service_contracts
       SET status = 'completed'::contract_status,
           completed_at = NOW(),
           completion_notes = COALESCE($1, completion_notes)
       WHERE id = $2
       RETURNING *`,
      [completionNotes, contractId]
    );

    // Etapa 4: Liberación de escrow — pasar todas las transacciones acreditadas ('approved') a 'released'
    const releasedTxRes = await db.query(
      `UPDATE transactions
       SET status = 'released'::payment_status,
           updated_at = NOW()
       WHERE contract_id = $1 AND status = 'approved'::payment_status
       RETURNING id`,
      [contractId]
    );

    return res.status(200).json({
      message: 'Conformidad registrada. El servicio quedó completado y el respaldo del hogar está disponible.',
      contract: updatedRes.rows[0],
      released_transactions_count: releasedTxRes.rows.length,
    });
  } catch (error) {
    console.error('Error al completar contrato con conformidad:', error);
    return res.status(500).json({ error: 'Error interno al registrar la conformidad del servicio.' });
  }
};

/**
 * Genera y devuelve el Comprobante del Hogar auditable para un contrato específico,
 * consolidando los datos de la comunidad, el residente, el prestador (con estado de compliance
 * y vigencias documentales), el pase QR enmascarado, el desglose financiero (real o proyectado
 * si aún no tiene transacción) y el historial de disputas/garantías.
 * Acceso permitido: residente titular, prestador asignado, `admin` o `superadmin`.
 * GET /api/v1/contracts/:id/receipt
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id`.
 * @param {import('express').Response} res - Respuesta HTTP con el objeto `receipt` auditable.
 * @returns {Promise<import('express').Response>}
 */
const getContractReceipt = async (req, res) => {
  try {
    // Etapa 1: Asegurar esquemas dependientes y validar `contractId`
    await Promise.all([ensureTransactionGatewayColumns(), ensureCompletionAndDisputesSchema()]);
    const contractId = Number(req.params.id);
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'ID de contrato inválido.' });
    }

    // Etapa 2: Consultar vista integral del contrato (comunidad, titular, prestador/compliance y pase QR)
    const detailRes = await db.query(
      `SELECT
         sc.id,
         sc.country_id,
         sc.owner_id,
         sc.provider_id,
         sc.pass_id,
         sc.description,
         sc.agreed_amount,
         sc.status,
         sc.created_at,
         sc.completed_at,
         sc.completion_notes,
         c.name AS country_name,
         TRIM(CONCAT(COALESCE(u_own.first_name, ''), ' ', COALESCE(u_own.last_name, ''))) AS owner_name,
         u_own.dni AS owner_dni,
         u_own.email AS owner_email,
         u_own.fraction_number AS owner_fraction,
         u_own.lot_number AS owner_lot,
         p.user_id AS provider_user_id,
         p.specialty AS provider_specialty,
         p.status AS provider_compliance_status,
         p.criminal_record_expiry AS provider_criminal_record_expiry,
         p.insurance_expiry AS provider_insurance_expiry,
         TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
         u_prov.dni AS provider_dni,
         u_prov.phone AS provider_phone,
         ap.qr_token AS pass_qr_token,
         ap.status AS pass_status,
         ap.fraction_number AS pass_fraction,
         ap.lot_number AS pass_lot,
         ap.start_time AS pass_start_time,
         ap.end_time AS pass_end_time
       FROM service_contracts sc
       LEFT JOIN countries c ON c.id = sc.country_id
       JOIN users u_own ON u_own.id = sc.owner_id
       JOIN providers p ON p.id = sc.provider_id
       JOIN users u_prov ON u_prov.id = p.user_id
       LEFT JOIN access_passes ap ON ap.id = sc.pass_id
       WHERE sc.id = $1
       LIMIT 1`,
      [contractId]
    );

    if (detailRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }

    // Etapa 3: Validar permisos de lectura (solo participantes del contrato o equipo administrativo)
    const row = detailRes.rows[0];
    const isAuthorized =
      ['admin', 'superadmin'].includes(userRole) ||
      Number(row.owner_id) === userId ||
      Number(row.provider_user_id) === userId;

    if (!isAuthorized) {
      return res.status(403).json({ error: 'No tenés permisos para consultar el comprobante de este contrato.' });
    }

    // Etapa 4: Consultar en paralelo la transacción más reciente y todas las disputas del contrato
    const [txRes, disputesRes] = await Promise.all([
      db.query(
        `SELECT id, gateway_provider, gateway_payment_id, gateway_mode,
                total_amount, platform_fee, provider_payout, status, created_at, updated_at
         FROM transactions
         WHERE contract_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [contractId]
      ),
      db.query(
        `SELECT id, reason, details, status, resolution_notes, created_at, resolved_at
         FROM public.service_disputes
         WHERE contract_id = $1
         ORDER BY id DESC`,
        [contractId]
      ),
    ]);

    // Etapa 5: Calcular split de respaldo (para acuerdos sin transacción registrada), enmascarar token QR
    // y ensamblar el Comprobante del Hogar con código identificador `TLK-REC-XXXXXX`
    const config = getGatewayConfig();
    const tx = txRes.rows[0] || null;
    const fallbackSplit = calculateSplit(Number(row.agreed_amount || 0), config.platformFeePercent);
    const maskedQr = row.pass_qr_token
      ? `${String(row.pass_qr_token).slice(0, 8)}...${String(row.pass_qr_token).slice(-6)}`
      : null;

    return res.status(200).json({
      receipt: {
        receipt_code: `TLK-REC-${String(row.id).padStart(6, '0')}`,
        issued_at: new Date().toISOString(),
        contract: {
          id: row.id,
          description: row.description,
          agreed_amount: Number(row.agreed_amount || 0),
          status: row.status,
          created_at: row.created_at,
          completed_at: row.completed_at,
          completion_notes: row.completion_notes,
        },
        community: {
          id: row.country_id,
          name: row.country_name || 'Comunidad TrustLink',
        },
        resident: {
          name: row.owner_name,
          dni: row.owner_dni,
          email: row.owner_email,
          fraction: row.pass_fraction || row.owner_fraction || null,
          lot: row.pass_lot || row.owner_lot || null,
        },
        provider: {
          id: row.provider_id,
          name: row.provider_name,
          dni: row.provider_dni,
          phone: row.provider_phone,
          specialty: row.provider_specialty,
          compliance_status: row.provider_compliance_status,
          criminal_record_expiry: row.provider_criminal_record_expiry,
          insurance_expiry: row.provider_insurance_expiry,
        },
        access_pass: row.pass_id
          ? {
              id: row.pass_id,
              qr_token_masked: maskedQr,
              status: row.pass_status,
              start_time: row.pass_start_time,
              end_time: row.pass_end_time,
            }
          : null,
        payment: tx
          ? {
              transaction_id: tx.id,
              gateway_provider: tx.gateway_provider,
              gateway_mode: tx.gateway_mode,
              gateway_payment_id: tx.gateway_payment_id,
              status: tx.status,
              total_amount: Number(tx.total_amount),
              platform_fee: Number(tx.platform_fee),
              provider_payout: Number(tx.provider_payout),
              paid_at: tx.created_at,
            }
          : {
              transaction_id: null,
              gateway_provider: 'acuerdo_directo',
              gateway_mode: 'offline_or_pending',
              status: 'unpaid',
              total_amount: fallbackSplit.totalAmount,
              platform_fee: fallbackSplit.platformFee,
              provider_payout: fallbackSplit.providerPayout,
              paid_at: null,
            },
        disputes: disputesRes.rows,
      },
    });
  } catch (error) {
    console.error('Error al generar comprobante del contrato:', error);
    return res.status(500).json({ error: 'Error interno al generar el comprobante del servicio.' });
  }
};

/**
 * Abre un reclamo o solicitud de garantía post-servicio sobre un contrato existente.
 * Solo puede iniciarlo el residente titular (o `superadmin`), admite hasta 5 URLs de evidencia
 * y bloquea duplicados si ya existe una disputa activa (`open` o `in_review`) en el mismo contrato.
 * POST /api/v1/contracts/:id/dispute
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id`, `reason`, `details` y `evidence_urls`.
 * @param {import('express').Response} res - Respuesta HTTP con el reclamo creado (201).
 * @returns {Promise<import('express').Response>}
 */
const createContractDispute = async (req, res) => {
  try {
    // Etapa 1: Asegurar esquema, sanitizar entradas (hasta 5 evidencias) y validar campos obligatorios
    await ensureCompletionAndDisputesSchema();
    const contractId = Number(req.params.id);
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const reason = String(req.body?.reason || '').trim();
    const details = String(req.body?.details || '').trim();
    const evidenceUrls = Array.isArray(req.body?.evidence_urls)
      ? req.body.evidence_urls.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 5)
      : [];

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'ID de contrato inválido.' });
    }
    if (!reason || !details) {
      return res.status(400).json({ error: 'Indicá el motivo y el detalle del reclamo o garantía.' });
    }

    // Etapa 2: Validar existencia del contrato y que el solicitante sea su residente titular
    const contractRes = await db.query(
      'SELECT id, owner_id, status FROM service_contracts WHERE id = $1 LIMIT 1',
      [contractId]
    );
    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato de servicio no encontrado.' });
    }
    if (userRole !== 'superadmin' && Number(contractRes.rows[0].owner_id) !== userId) {
      return res.status(403).json({ error: 'Solo el residente titular puede abrir un reclamo sobre este contrato.' });
    }

    // Etapa 3: Prevenir disputas concurrentes sobre un mismo contrato (409 Conflict)
    const openCheck = await db.query(
      `SELECT id FROM public.service_disputes
       WHERE contract_id = $1 AND status IN ('open', 'in_review')
       LIMIT 1`,
      [contractId]
    );
    if (openCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'Ya existe un reclamo abierto o en revisión para este contrato.',
      });
    }

    // Etapa 4: Persistir el reclamo en `service_disputes` con estado inicial `'open'`
    const insertRes = await db.query(
      `INSERT INTO public.service_disputes (
         contract_id, opened_by_user_id, reason, details, evidence_urls, status
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, 'open')
       RETURNING *`,
      [contractId, userId, reason.slice(0, 120), details, JSON.stringify(evidenceUrls)]
    );

    return res.status(201).json({
      message: 'Reclamo post-servicio registrado. El equipo de Operaciones de TrustLink revisará el caso.',
      dispute: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al crear reclamo de contrato:', error);
    return res.status(500).json({ error: 'Error interno al registrar el reclamo.' });
  }
};

/**
 * Lista reclamos/disputas de contratos priorizando casos activos (`open` -> `in_review` -> cerrados),
 * con visibilidad segmentada según rol:
 * - `admin` / `superadmin`: visualiza todos los reclamos del sistema (con filtro opcional `?status=`).
 * - `owner` / `provider`: visualiza únicamente reclamos de contratos donde participa.
 * GET /api/v1/contracts/disputes
 *
 * @param {import('express').Request} req - Solicitud HTTP con filtro opcional `query.status`.
 * @param {import('express').Response} res - Respuesta HTTP con hasta 100 reclamos enriquecidos.
 * @returns {Promise<import('express').Response>}
 */
const listContractDisputes = async (req, res) => {
  try {
    // Etapa 1: Construir condiciones dinámicas por rol y filtro de estado (`ALLOWED_DISPUTE_STATUSES`)
    await ensureCompletionAndDisputesSchema();
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const isOps = ['admin', 'superadmin'].includes(userRole);
    const statusFilter = String(req.query?.status || 'all').trim().toLowerCase();

    const conditions = [];
    const params = [];

    if (!isOps) {
      params.push(userId);
      conditions.push(`(sc.owner_id = $${params.length} OR p.user_id = $${params.length})`);
    }
    if (statusFilter !== 'all' && ALLOWED_DISPUTE_STATUSES.includes(statusFilter)) {
      params.push(statusFilter);
      conditions.push(`sd.status = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Etapa 2: Consultar disputas con contexto de contrato, residente y prestador, priorizando casos abiertos
    const result = await db.query(
      `SELECT
         sd.id,
         sd.contract_id,
         sd.opened_by_user_id,
         sd.reason,
         sd.details,
         sd.evidence_urls,
         sd.status,
         sd.resolution_notes,
         sd.resolved_by,
         sd.created_at,
         sd.resolved_at,
         sc.description AS contract_description,
         sc.agreed_amount,
         sc.status AS contract_status,
         TRIM(CONCAT(COALESCE(u_own.first_name, ''), ' ', COALESCE(u_own.last_name, ''))) AS owner_name,
         u_own.email AS owner_email,
         TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
         p.specialty AS provider_specialty
       FROM public.service_disputes sd
       JOIN service_contracts sc ON sc.id = sd.contract_id
       JOIN users u_own ON u_own.id = sc.owner_id
       JOIN providers p ON p.id = sc.provider_id
       JOIN users u_prov ON u_prov.id = p.user_id
       ${whereClause}
       ORDER BY
         CASE sd.status WHEN 'open' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END ASC,
         sd.id DESC
       LIMIT 100`,
      params
    );

    return res.status(200).json({
      count: result.rows.length,
      disputes: result.rows,
    });
  } catch (error) {
    console.error('Error al listar reclamos de contratos:', error);
    return res.status(500).json({ error: 'Error interno al consultar los reclamos.' });
  }
};

/**
 * Actualiza el estado de un reclamo desde Operaciones (`admin` / `superadmin`):
 * permite pasarlo a `'in_review'` o cerrarlo como `'resolved'` / `'rejected'` (exigiendo
 * obligatoriamente `resolution_notes` y registrando auditoría `resolved_by` y `resolved_at`).
 * PATCH /api/v1/contracts/disputes/:disputeId/resolve
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.disputeId`, `status` y `resolution_notes`.
 * @param {import('express').Response} res - Respuesta HTTP con la disputa actualizada.
 * @returns {Promise<import('express').Response>}
 */
const resolveContractDispute = async (req, res) => {
  try {
    // Etapa 1: Validar ID de reclamo, transición permitida y obligatoriedad de nota en cierres definitivos
    await ensureCompletionAndDisputesSchema();
    const disputeId = Number(req.params.disputeId);
    const resolverId = Number(req.user.userId);
    const nextStatus = String(req.body?.status || 'resolved').trim().toLowerCase();
    const resolutionNotes = String(req.body?.resolution_notes || '').trim();

    if (!Number.isInteger(disputeId) || disputeId <= 0) {
      return res.status(400).json({ error: 'ID de reclamo inválido.' });
    }
    if (!['in_review', 'resolved', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({
        error: 'Estado inválido. Valores permitidos: in_review, resolved, rejected.',
      });
    }
    if (['resolved', 'rejected'].includes(nextStatus) && !resolutionNotes) {
      return res.status(400).json({
        error: 'Indicá una nota de resolución para cerrar o desestimar el reclamo.',
      });
    }

    // Etapa 2: Persistir estado, nota y sello de cierre (`resolved_by` / `resolved_at` solo si cierra)
    const isClosed = ['resolved', 'rejected'].includes(nextStatus);
    const updatedRes = await db.query(
      `UPDATE public.service_disputes
       SET status = $1,
           resolution_notes = COALESCE(NULLIF($2, ''), resolution_notes),
           resolved_by = CASE WHEN $3 THEN $4 ELSE resolved_by END,
           resolved_at = CASE WHEN $3 THEN NOW() ELSE resolved_at END
       WHERE id = $5
       RETURNING *`,
      [nextStatus, resolutionNotes, isClosed, resolverId, disputeId]
    );

    if (updatedRes.rows.length === 0) {
      return res.status(404).json({ error: 'Reclamo no encontrado.' });
    }

    return res.status(200).json({
      message: `Reclamo #${disputeId} actualizado a estado: ${nextStatus}.`,
      dispute: updatedRes.rows[0],
    });
  } catch (error) {
    console.error('Error al resolver reclamo de contrato:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el reclamo.' });
  }
};

/**
 * Lista todos los contratos asignados a los perfiles del prestador autenticado junto con
 * su estado de pago, disputas abiertas y un resumen consolidado (`summary`) de ingresos brutos
 * y liquidaciones netas estimadas/reales (93% por defecto tras descontar el Take Rate de TrustLink).
 * GET /api/v1/contracts/provider
 *
 * @param {import('express').Request} req - Solicitud HTTP del prestador autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con `summary` financiero y detalle de contratos.
 * @returns {Promise<import('express').Response>}
 */
const listProviderContracts = async (req, res) => {
  try {
    // Etapa 1: Consultar contratos del prestador con `LEFT JOIN LATERAL` hacia su última transacción
    // y conteo de reclamos activos para el tablero de ingresos del prestador
    await Promise.all([ensureTransactionGatewayColumns(), ensureCompletionAndDisputesSchema()]);
    const userId = Number(req.user.userId);
    const config = getGatewayConfig();

    const query = `
      SELECT
        sc.id,
        sc.country_id,
        sc.owner_id,
        sc.provider_id,
        sc.pass_id,
        sc.description,
        sc.agreed_amount,
        sc.status,
        sc.created_at,
        sc.completed_at,
        sc.completion_notes,
        p.specialty,
        TRIM(CONCAT(COALESCE(u_own.first_name, ''), ' ', COALESCE(u_own.last_name, ''))) AS owner_name,
        u_own.phone AS owner_phone,
        u_own.fraction_number,
        u_own.lot_number,
        tx.status AS payment_status,
        tx.platform_fee,
        tx.provider_payout,
        tx.gateway_provider,
        (
          SELECT COUNT(*)::int
          FROM public.service_disputes sd
          WHERE sd.contract_id = sc.id AND sd.status IN ('open', 'in_review')
        ) AS open_disputes_count
      FROM service_contracts sc
      JOIN providers p ON p.id = sc.provider_id
      JOIN users u_own ON u_own.id = sc.owner_id
      LEFT JOIN LATERAL (
        SELECT status, platform_fee, provider_payout, gateway_provider
        FROM transactions
        WHERE contract_id = sc.id
        ORDER BY id DESC
        LIMIT 1
      ) tx ON TRUE
      WHERE p.user_id = $1
      ORDER BY sc.created_at DESC, sc.id DESC;
    `;

    // Etapa 2: Normalizar importes y proyectar split 7%/93% cuando aún no existe transacción registrada
    const result = await db.query(query, [userId]);
    const contracts = result.rows.map((row) => {
      const agreed = Number(row.agreed_amount || 0);
      const fallback = calculateSplit(agreed, config.platformFeePercent);
      return {
        ...row,
        agreed_amount: agreed,
        platform_fee: row.platform_fee !== null && row.platform_fee !== undefined ? Number(row.platform_fee) : fallback.platformFee,
        provider_payout: row.provider_payout !== null && row.provider_payout !== undefined ? Number(row.provider_payout) : fallback.providerPayout,
        payment_status: row.payment_status || 'unpaid',
      };
    });

    // Etapa 3: Consolidar KPIs operativos y totales brutos/netos (excluyendo contratos cancelados)
    const summary = contracts.reduce(
      (acc, c) => {
        acc.total_contracts += 1;
        const st = String(c.status || '').toLowerCase();
        if (st === 'completed') acc.completed_count += 1;
        if (st === 'pending') acc.pending_count += 1;
        if (st === 'in_progress') acc.in_progress_count += 1;
        acc.open_disputes_count += Number(c.open_disputes_count || 0);
        if (st !== 'cancelled') {
          acc.total_gross = Number((acc.total_gross + c.agreed_amount).toFixed(2));
          acc.total_net_payout = Number((acc.total_net_payout + c.provider_payout).toFixed(2));
        }
        return acc;
      },
      {
        total_contracts: 0,
        completed_count: 0,
        in_progress_count: 0,
        pending_count: 0,
        open_disputes_count: 0,
        total_gross: 0,
        total_net_payout: 0,
      }
    );

    return res.status(200).json({
      count: contracts.length,
      summary,
      contracts,
    });
  } catch (error) {
    console.error('Error al listar contratos del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar los contratos del prestador.' });
  }
};

module.exports = {
  getPaymentGatewayPublicConfig,
  listMyContracts,
  listProviderContracts,
  createContract,
  getPendingContracts,
  checkoutContractPayment,
  createOrUpdateQuote,
  confirmPayment,
  completeContract,
  getContractReceipt,
  createContractDispute,
  listContractDisputes,
  resolveContractDispute,
};