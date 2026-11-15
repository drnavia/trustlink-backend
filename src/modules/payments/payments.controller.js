/**
 * @file payments.controller.js
 * @description Lógica de negocio para el registro de cotizaciones presenciales, procesamiento de pagos,
 * cálculo automático del Take Rate y liberación de fondos al prestador.
 * @location /trustlink-backend/src/modules/payments/payments.controller.js
 */

const db = require('../../config/db');

/**
 * Registra o actualiza el monto final acordado en domicilio por el prestador y genera la orden de pago.
 * Roles permitidos: 'provider', 'owner', 'family'
 */
const createOrUpdateQuote = async (req, res) => {
  try {
    const { contract_id, agreed_amount } = req.body;

    if (!contract_id || !agreed_amount || agreed_amount <= 0) {
      return res.status(400).json({ error: 'Datos inválidos. Especifique un contrato y un monto acordado válido.' });
    }

    // 1. Actualizar el monto acordado en el contrato de servicio
    const updateQuery = `
      UPDATE service_contracts 
      SET agreed_amount = $1, status = 'pending'
      WHERE id = $2 
      RETURNING id, owner_id, provider_id, description, agreed_amount, status;
    `;

    const contractResult = await db.query(updateQuery, [agreed_amount, contract_id]);

    if (contractResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }

    // 2. Calcular comisiones (Take Rate institucional del 7%)
    const totalAmount = Number(agreed_amount);
    const platformFee = Number((totalAmount * 0.07).toFixed(2)); // Comisión TrustLink
    const providerPayout = Number((totalAmount - platformFee).toFixed(2)); // Neto prestador

    const mockGatewayId = `MP-TX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // 3. Registrar la transacción pendiente
    const insertTx = `
      INSERT INTO transactions (contract_id, gateway_provider, gateway_payment_id, total_amount, platform_fee, provider_payout, status)
      VALUES ($1, 'mercadopago', $2, $3, $4, $5, 'pending')
      RETURNING id, gateway_payment_id, total_amount, platform_fee, provider_payout, status;
    `;

    const txResult = await db.query(insertTx, [contract_id, mockGatewayId, totalAmount, platformFee, providerPayout]);

    return res.status(201).json({
      message: 'Cotización in situ registrada y orden de pago generada con éxito.',
      checkout_url: `https://checkout.mercadopago.com/pay/${mockGatewayId}`,
      transaction: txResult.rows[0]
    });

  } catch (error) {
    console.error('Error al registrar cotización y pago:', error);
    return res.status(500).json({ error: 'Error interno al procesar la cotización.' });
  }
};

/**
 * Simula la aprobación del pago por parte del propietario (Webhook o confirmación de pasarela).
 * Cambia el estado del contrato a 'in_progress' si el pago es aprobado.
 */
const confirmPayment = async (req, res) => {
  try {
    const { gateway_payment_id, status } = req.body; // status: 'approved', 'rejected'

    if (!gateway_payment_id || !status) {
      return res.status(400).json({ error: 'Faltan datos de la pasarela de pagos.' });
    }

    // 1. Actualizar estado de la transacción
    const txUpdate = `
      UPDATE transactions 
      SET status = $1 
      WHERE gateway_payment_id = $2 
      RETURNING id, contract_id, provider_payout, status;
    `;

    const txResult = await db.query(txUpdate, [status, gateway_payment_id]);

    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transacción de pago no encontrada.' });
    }

    const transaction = txResult.rows[0];

    // 2. Si el pago es aprobado, el contrato queda fondeado / en proceso de ejecución
    if (status === 'approved') {
      await db.query(
        "UPDATE service_contracts SET status = 'in_progress' WHERE id = $1",
        [transaction.contract_id]
      );
    }

    // CORRECCIÓN: Devolvemos 'received: true' para que coincida exactamente con la validación del test
    return res.status(200).json({
      received: true,
      transaction_status: status,
      message: `Transacción procesada con estado: ${status}`,
      transaction_id: transaction.id,
      payout_to_provider: transaction.provider_payout
    });

  } catch (error) {
    console.error('Error al confirmar pago:', error);
    return res.status(500).json({ error: 'Error interno al confirmar el pago.' });
  }
};

module.exports = {
  createOrUpdateQuote,
  confirmPayment
};