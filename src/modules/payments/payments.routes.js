/**
 * @file payments.routes.js
 * @description Enrutador para consulta de contratos pendientes, cotizaciones con Take Rate y webhooks de pago.
 * @location /trustlink-backend/src/modules/payments/payments.routes.js
 */

const { Router } = require('express');
const { getPendingContracts, createOrUpdateQuote, confirmPayment } = require('./payments.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Consultar contratos pendientes de pago del residente (Roles: owner, family)
router.get('/pending', verifyToken, verifyRole(['owner', 'family']), getPendingContracts);

// Registrar o actualizar cotización y generar orden de pago (Roles: provider, owner, family)
router.post('/quote', verifyToken, verifyRole(['provider', 'owner', 'family']), createOrUpdateQuote);

// Confirmación / webhook de pasarela de pagos
router.post('/webhook', confirmPayment);

module.exports = router;