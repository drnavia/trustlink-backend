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
const { verifyToken, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// Consultar contratos pendientes de pago del residente (o usuario con portal residente habilitado)
router.get('/pending', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), getPendingContracts);

// Procesar pago de contrato pendiente con Take Rate 7% / Neto Prestador 93%
router.post('/checkout', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), checkoutContractPayment);

// Registrar o actualizar cotización y generar orden de pago
router.post('/quote', verifyToken, verifyRoleOrPortal(['provider', 'owner', 'family', 'superadmin'], 'resident'), createOrUpdateQuote);

// Confirmación / webhook de pasarela de pagos
router.post('/webhook', confirmPayment);

module.exports = router;