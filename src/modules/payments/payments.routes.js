/**
 * @file payments.routes.js
 * @description Enrutador montado en `/api/v1/payments` para consultar la configuración activa
 * de la pasarela, listar contratos pendientes de pago, registrar cotizaciones con cálculo de
 * Take Rate (7% TrustLink / 93% Neto Prestador), ejecutar checkout y recibir webhooks externos.
 * @location /trustlink-backend/src/modules/payments/payments.routes.js
 */

const { Router } = require('express');
const {
  getPaymentGatewayPublicConfig,
  getPendingContracts,
  checkoutContractPayment,
  createOrUpdateQuote,
  confirmPayment,
} = require('./payments.controller');
const { verifyToken, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// ============================================================================
// 1. CONFIGURACIÓN DE PASARELA Y FLUJO DE PAGO AUTENTICADO
// ============================================================================
// Consultar configuración pública de la pasarela (modo mock / mercadopago y Take Rate vigente)
router.get('/config', verifyToken, getPaymentGatewayPublicConfig);

// Consultar contratos pendientes de pago del residente (o usuario con portal residente habilitado)
router.get('/pending', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), getPendingContracts);

// Procesar pago de contrato pendiente con desglose Take Rate 7% / Neto Prestador 93%
router.post('/checkout', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), checkoutContractPayment);

// Registrar o actualizar cotización de servicio y generar orden de pago vinculada
router.post('/quote', verifyToken, verifyRoleOrPortal(['provider', 'owner', 'family', 'superadmin'], 'resident'), createOrUpdateQuote);

// ============================================================================
// 2. WEBHOOK ASÍNCRONO DE PASARELA DE PAGOS (Sin JWT; validado en controlador)
// ============================================================================
// Recibe notificaciones de confirmación/estado desde Mercado Pago o el simulador interno
router.post('/webhook', confirmPayment);

module.exports = router;