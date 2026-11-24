/**
 * @file payments.routes.js
 * @description Enrutador para consulta de contratos pendientes, cotizaciones con Take Rate y webhooks de pago.
 * @location /trustlink-backend/src/modules/payments/payments.routes.js
 */

const { Router } = require('express');
const {
  getPendingContracts,
  checkoutContractPayment,
  createOrUpdateQuote,
  confirmPayment,
} = require('./payments.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Consultar contratos pendientes de pago del residente (Roles: owner, family, superadmin)
router.get('/pending', verifyToken, verifyRole(['owner', 'family', 'superadmin']), getPendingContracts);

// Procesar pago de contrato pendiente con Take Rate 7% / Neto Prestador 93%
router.post('/checkout', verifyToken, verifyRole(['owner', 'family', 'superadmin']), checkoutContractPayment);

// Registrar o actualizar cotización y generar orden de pago (Roles: provider, owner, family, superadmin)
router.post('/quote', verifyToken, verifyRole(['provider', 'owner', 'family', 'superadmin']), createOrUpdateQuote);

// Confirmación / webhook de pasarela de pagos
router.post('/webhook', confirmPayment);

module.exports = router;