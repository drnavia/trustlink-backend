/**
 * @file payments.controller.js
 * @description Lógica de negocio para el Módulo de Pagos y Contratos de TrustLink.
 * Consulta los contratos pendientes reales de la base de datos y procesa la pasarela con Take Rate.
 * @location /trustlink-backend/src/modules/payments/payments.controller.js
 */

const db = require('../../config/db');

/**
 * Obtiene los contratos pendientes de pago para el residente autenticado.
 * Roles permitidos: 'owner', 'family'
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
        sc.description,
        sc.agreed_amount,
        sc.status,
        sc.created_at,
        u.first_name || ' ' || u.last_name AS provider_name
      FROM service_contracts sc
      JOIN providers p ON sc.provider_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE sc.owner_id = $1 AND sc.status = 'pending'
      ORDER BY sc.created_at DESC;
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
 * Registra o actualiza el monto acordado in situ y genera la orden de pago (Take Rate 7%).
 * Roles permitidos: 'provider', 'owner', 'family'
 */
const createOrUpdateQuote = async (req, res) => {
  try {
    const { contract_id, agreed_amount } = req.body;

    if (!contract_id || !agreed_amount || agreed_amount <= 0) {
      return res.status(400).json({ error: 'Datos inválidos. Especifique un contrato y un monto acordado válido.' });
    }

    const updateQuery = `
      UPDATE service_contracts
      SET agreed_amount = $1, status = 'pending'
      WHERE id = $2
      RETURNING id, owner_id, provider_id, description, agreed_amount, status;
    `;

    const contractResult = await db.query(updateQuery, [agreed_amount, contract_id]);

    if (contractResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato de servicio no encontrado.' });
    }

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
 * Simula la confirmación de pago por webhook de pasarela.
 */
const confirmPayment = async (req, res) => {
  try {
    const { gateway_payment_id, status } = req.body;

    if (!gateway_payment_id || !status) {
      return res.status(400).json({ error: 'Faltan datos de la pasarela de pagos.' });
    }

    const updateTx = `
      UPDATE transactions
      SET status = $1
      WHERE gateway_payment_id = $2
      RETURNING id, contract_id, status;
    `;

    const txResult = await db.query(updateTx, [status, gateway_payment_id]);

    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transacción no encontrada.' });
    }

    const transaction = txResult.rows[0];

    if (status === 'approved') {
      await db.query(
        "UPDATE service_contracts SET status = 'in_progress' WHERE id = $1",
        [transaction.contract_id]
      );
    }

    return res.status(200).json({
      message: `Transacción procesada con estado: ${status}`,
      transaction_id: transaction.id
    });
  } catch (error) {
    console.error('Error al confirmar pago:', error);
    return res.status(500).json({ error: 'Error interno al confirmar el pago.' });
  }
};

module.exports = {
  getPendingContracts,
  createOrUpdateQuote,
  confirmPayment
};