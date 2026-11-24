/**
 * @file payments.controller.js
 * @description Lógica de negocio para el Módulo de Pagos y Contratos de TrustLink.
 * Consulta los contratos pendientes reales de la base de datos y procesa la pasarela con Take Rate.
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

const ALLOWED_PAYMENT_STATUSES = ['pending', 'approved', 'released', 'refunded'];
const ALLOWED_DISPUTE_STATUSES = ['open', 'in_review', 'resolved', 'rejected'];

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

const ensureCompletionAndDisputesSchema = async () => {
  await db.query(`
    ALTER TABLE public.service_contracts
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITHOUT TIME ZONE NULL,
      ADD COLUMN IF NOT EXISTS completion_notes TEXT NULL;
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
 * Devuelve la configuración pública de la pasarela activa (modo mock/mercadopago y Take Rate).
 * GET /api/v1/payments/config
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
 * Valida la autenticidad del webhook de pagos mediante:
 * 1) Secreto compartido (`x-webhook-secret`),
 * 2) Firma oficial de Mercado Pago (`x-signature: ts=...,v1=...`), o
 * 3) Firma HMAC-SHA256 del cuerpo crudo (`x-webhook-signature` / `x-signature`).
 */
const verifyWebhookAuth = (req) => {
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

  const providedSecret = String(req.headers['x-webhook-secret'] || '').trim();
  if (providedSecret && safeTimingEqual(providedSecret, expectedSecret)) {
    return { ok: true, mode: 'shared_secret' };
  }

  // Firma oficial Mercado Pago: x-signature: ts=...,v1=...
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

  return {
    ok: false,
    status: 401,
    error: 'Firma o secreto de webhook de pagos inválido o ausente.',
  };
};

/**
 * Obtiene todos los contratos de servicio del residente autenticado.
 * GET /api/v1/contracts
 */
const listMyContracts = async (req, res) => {
  try {
    await ensureCompletionAndDisputesSchema();
    const owner_id = req.user.userId;

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
 * Crea un contrato / orden de servicio a partir de una visita o pase QR.
 * POST /api/v1/contracts
 */
const createContract = async (req, res) => {
  try {
    const ownerId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const { provider_id, pass_id, description, agreed_amount } = req.body || {};

    const cleanDescription = String(description || '').trim();
    const numericAmount = Number(agreed_amount);

    if (!cleanDescription || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: 'Indicá la descripción del trabajo y un monto acordado mayor a cero.',
      });
    }

    let resolvedProviderId = provider_id ? Number(provider_id) : null;
    let resolvedPassId = pass_id ? Number(pass_id) : null;
    let effectiveCountryId = req.user.countryId ? Number(req.user.countryId) : null;

    if (resolvedPassId) {
      const passRes = await db.query(
        'SELECT id, owner_id, provider_id, country_id FROM access_passes WHERE id = $1 LIMIT 1',
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
    }

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

    const insertRes = await db.query(
      `INSERT INTO service_contracts (
         country_id, owner_id, provider_id, pass_id, description, agreed_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [
        effectiveCountryId,
        ownerId,
        resolvedProviderId,
        resolvedPassId,
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
 * Obtiene los contratos pendientes de pago para el residente autenticado.
 * Roles permitidos: 'owner', 'family', 'superadmin'
 */
const getPendingContracts = async (req, res) => {
  try {
    const owner_id = req.user.userId;

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
 * Procesa el pago de un contrato pendiente con Take Rate parametrizable (default 7% / Neto Prestador 93%).
 * Soporta modo dual:
 * - `mock`: acreditación instantánea para piloto/tests locales.
 * - `mercadopago`: crea preferencia real de Checkout Pro y devuelve `checkout_url` para redirección.
 * Soporta POST /api/v1/payments/checkout y POST /api/v1/contracts/:id/pay.
 */
const checkoutContractPayment = async (req, res) => {
  try {
    await ensureTransactionGatewayColumns();
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const contractId = Number(req.params.id || req.body?.contract_id);
    const gatewayProvider = String(req.body?.payment_method || 'mercadopago').trim() || 'mercadopago';
    const config = getGatewayConfig();

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un contrato válido para abonar.' });
    }

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

    const { platformFee, providerPayout, feePercent } = calculateSplit(
      totalAmount,
      config.platformFeePercent
    );

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
 * Registra o actualiza el monto acordado in situ y genera la orden de pago (Take Rate configurable).
 * Roles permitidos: 'provider', 'owner', 'family', 'superadmin'
 */
const createOrUpdateQuote = async (req, res) => {
  try {
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
 * Procesa confirmación de pago por webhook de pasarela con validación HMAC-SHA256 / x-signature oficial de MP
 * y soporte tanto para payloads directos (`{ gateway_payment_id, status }`)
 * como para notificaciones reales de Mercado Pago (`{ type: 'payment', data: { id } }`).
 */
const confirmPayment = async (req, res) => {
  try {
    await ensureTransactionGatewayColumns();
    const authCheck = verifyWebhookAuth(req);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }

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

    if (!gatewayPaymentId || !normalizedStatus) {
      return res.status(400).json({ error: 'Faltan datos de la pasarela de pagos.' });
    }

    if (!ALLOWED_PAYMENT_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Estado de pago inválido. Valores permitidos: ${ALLOWED_PAYMENT_STATUSES.join(', ')}.`,
      });
    }

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
 * Registra la conformidad final del residente sobre un contrato (cierre formal + liberación escrow).
 * PATCH /api/v1/contracts/:id/complete
 */
const completeContract = async (req, res) => {
  try {
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

    if (currentStatus === 'completed') {
      return res.status(200).json({
        message: `El contrato #${contractId} ya se encontraba completado con conformidad.`,
        contract,
        released_transactions_count: 0,
        idempotent: true,
      });
    }

    const updatedRes = await db.query(
      `UPDATE service_contracts
       SET status = 'completed'::contract_status,
           completed_at = NOW(),
           completion_notes = COALESCE($1, completion_notes)
       WHERE id = $2
       RETURNING *`,
      [completionNotes, contractId]
    );

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
 * Devuelve el Comprobante del Hogar auditable (contrato + compliance del prestador + pase QR + finanzas + disputas).
 * GET /api/v1/contracts/:id/receipt
 */
const getContractReceipt = async (req, res) => {
  try {
    await Promise.all([ensureTransactionGatewayColumns(), ensureCompletionAndDisputesSchema()]);
    const contractId = Number(req.params.id);
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'ID de contrato inválido.' });
    }

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

    const row = detailRes.rows[0];
    const isAuthorized =
      ['admin', 'superadmin'].includes(userRole) ||
      Number(row.owner_id) === userId ||
      Number(row.provider_user_id) === userId;

    if (!isAuthorized) {
      return res.status(403).json({ error: 'No tenés permisos para consultar el comprobante de este contrato.' });
    }

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
 * Abre un reclamo / garantía post-servicio sobre un contrato.
 * POST /api/v1/contracts/:id/dispute
 */
const createContractDispute = async (req, res) => {
  try {
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
 * Lista reclamos/disputas.
 * - admin / superadmin: ve todos los reclamos (con filtro opcional ?status=).
 * - owner / provider: ve los reclamos de los contratos donde participa.
 * GET /api/v1/contracts/disputes
 */
const listContractDisputes = async (req, res) => {
  try {
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
 * Resuelve o actualiza el estado de un reclamo desde Operaciones (admin / superadmin).
 * PATCH /api/v1/contracts/disputes/:disputeId/resolve
 */
const resolveContractDispute = async (req, res) => {
  try {
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
 * Lista todos los contratos asignados al prestador autenticado junto con resumen de ingresos netos (93%).
 * GET /api/v1/contracts/provider
 */
const listProviderContracts = async (req, res) => {
  try {
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