/**
 * @file payments.routes.js
 * @description Enrutador completo para cotizaciones presenciales, órdenes de pago y pasarela.
 * @location /trustlink-backend/src/modules/payments/payments.routes.js
 */

const { Router } = require('express');
const { createOrUpdateQuote, confirmPayment } = require('./payments.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Endpoint para que el prestador cargue el presupuesto acordado in situ (Rol: provider)
router.post('/quote', verifyToken, verifyRole(['provider']), createOrUpdateQuote);

// Endpoint webhook o confirmación de pago de la pasarela (Roles permitidos o público con firma)
router.post('/webhook', confirmPayment);

module.exports = router;