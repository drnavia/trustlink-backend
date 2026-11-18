/**
 * @file payments.routes.js
 * @description Enrutador completo para cotizaciones presenciales, consulta de contratos pendientes,
 * órdenes de pago y pasarela.
 * @location /trustlink-backend/src/modules/payments/payments.routes.js
 */

const { Router } = require('express');
const { getPendingContracts, createOrUpdateQuote, confirmPayment } = require('./payments.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Endpoint para que el residente consulte sus contratos pendientes de pago (Rol: owner, family)
router.get('/pending', verifyToken, verifyRole(['owner', 'family']), getPendingContracts);

// Endpoint para que el prestador cargue el presupuesto acordado in situ (Rol: provider)
router.post('/quote', verifyToken, verifyRole(['provider']), createOrUpdateQuote);

// Endpoint webhook o confirmación de pago de la pasarela (Público con validación de pasarela)
router.post('/webhook', confirmPayment);

module.exports = router;