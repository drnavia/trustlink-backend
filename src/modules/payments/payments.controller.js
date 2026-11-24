/**
 * @file payments.controller.js
 * @description Lógica de negocio para el Módulo de Pagos y Contratos de TrustLink.
 * Consulta los contratos pendientes reales de la base de datos y procesa la pasarela con Take Rate.
 * @location /trustlink-backend/src/modules/payments/payments.controller.js
 */

const crypto = require('crypto');
const db = require('../../config/db');

const ALLOWED_PAYMENT_STATUSES = ['pending', 'approved', 'released', 'refunded'];

const safeTimingEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Valida la autenticidad del webhook de pagos mediante secreto compartido (`x-webhook-secret`)
 * o firma HMAC-SHA256 (`x-webhook-signature`, con o sin prefijo `sha256=`) contra PAYMENT_WEBHOOK_SECRET.
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
 * Procesa el pago simulado de un contrato pendiente con Take Rate 7% / Neto Prestador 93%.
 * Soporta POST /api/v1/payments/checkout y POST /api/v1/contracts/:id/pay.
 */
const checkoutContractPayment = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const contractId = Number(req.params.id || req.body?.contract_id);
    const gatewayProvider = String(req.body?.payment_method || 'mercadopago').trim() || 'mercadopago';

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

    const platformFee = Number((totalAmount * 0.07).toFixed(2));
    const providerPayout = Number((totalAmount - platformFee).toFixed(2));
    const mockGatewayId = `MP-PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const txResult = await db.query(
      `INSERT INTO transactions (
         contract_id, gateway_provider, gateway_payment_id,
         total_amount, platform_fee, provider_payout, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'approved')
       RETURNING id, contract_id, gateway_provider, gateway_payment_id, total_amount, platform_fee, provider_payout, status, created_at`,
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
      message: 'Pago acreditado correctamente. Comisión de plataforma (7%) y liquidación (93%) registradas.',
      contract: updatedContract.rows[0],
      transaction: txResult.rows[0],
    });
  } catch (error) {
    console.error('Error al procesar checkout del contrato:', error);
    return res.status(500).json({ error: 'Error interno al procesar el pago del contrato.' });
  }
};

/**
 * Registra o actualiza el monto acordado in situ y genera la orden de pago (Take Rate 7%).
 * Roles permitidos: 'provider', 'owner', 'family', 'superadmin'
 */
const createOrUpdateQuote = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const userRole = String(req.user.role || '').toLowerCase();
    const { contract_id, agreed_amount } = req.body;

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
    const totalAmount = Number(contract.agreed_amount);
    const platformFee = Number((totalAmount * 0.07).toFixed(2)); // 7% Take Rate institucional
    const providerPayout = Number((totalAmount - platformFee).toFixed(2)); // 93% para el prestador

    const mockGatewayId = `MP-TX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const insertTx = `
      INSERT INTO transactions (contract_id, gateway_provider, gateway_payment_id, total_amount, platform_fee, provider_payout, status)
      VALUES ($1, 'mercadopago', $2, $3, $4, $5, 'pending')
      RETURNING id, gateway_payment_id, total_amount, platform_fee, provider_payout, status;
    `;

    const txResult = await db.query(insertTx, [contract_id, mockGatewayId, totalAmount, platformFee, providerPayout]);

    return res.status(201).json({
      message: 'Orden de pago generada con éxito.',
      checkout_url: `https://checkout.mercadopago.com/simulate/${mockGatewayId}`,
      transaction: txResult.rows[0]
    });
  } catch (error) {
    console.error('Error al procesar la cotización:', error);
    return res.status(500).json({ error: 'Error interno al procesar la cotización.' });
  }
};

/**
 * Procesa confirmación de pago por webhook de pasarela con validación HMAC-SHA256 / secreto
 * y control de transiciones válidas de estado.
 */
const confirmPayment = async (req, res) => {
  try {
    const authCheck = verifyWebhookAuth(req);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }

    const { gateway_payment_id, status } = req.body || {};
    const normalizedStatus = String(status || '').trim().toLowerCase();

    if (!gateway_payment_id || !normalizedStatus) {
      return res.status(400).json({ error: 'Faltan datos de la pasarela de pagos.' });
    }

    if (!ALLOWED_PAYMENT_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Estado de pago inválido. Valores permitidos: ${ALLOWED_PAYMENT_STATUSES.join(', ')}.`,
      });
    }

    const existingTxRes = await db.query(
      'SELECT id, contract_id, status FROM transactions WHERE gateway_payment_id = $1 LIMIT 1',
      [String(gateway_payment_id).trim()]
    );

    if (existingTxRes.rows.length === 0) {
      return res.status(404).json({ error: 'Transacción no encontrada.' });
    }

    const currentTx = existingTxRes.rows[0];
    const currentStatus = String(currentTx.status || '').toLowerCase();

    if (currentStatus === normalizedStatus) {
      return res.status(200).json({
        message: `Transacción ya registrada en estado: ${normalizedStatus}`,
        transaction_id: currentTx.id,
        idempotent: true,
      });
    }

    if (['released', 'refunded'].includes(currentStatus) && normalizedStatus === 'pending') {
      return res.status(409).json({
        error: `No se puede revertir una transacción desde '${currentStatus}' a 'pending'.`,
      });
    }

    const updateTx = `
      UPDATE transactions
      SET status = $1::payment_status
      WHERE id = $2
      RETURNING id, contract_id, status;
    `;

    const txResult = await db.query(updateTx, [normalizedStatus, currentTx.id]);
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
    return res.status(500).json({ error: 'Error interno al confirmar el pago.' });
  }
};

module.exports = {
  listMyContracts,
  createContract,
  getPendingContracts,
  checkoutContractPayment,
  createOrUpdateQuote,
  confirmPayment
};