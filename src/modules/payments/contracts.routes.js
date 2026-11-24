/**
 * @file contracts.routes.js
 * @description Enrutador montado en `/api/v1/contracts` para el ciclo de vida completo de
 * contratos de servicio: alta, consulta (Residente y Prestador), checkout/pago, conformidad
 * de finalización, comprobante/recibo y gestión de reclamos/disputas por garantía.
 * @location /trustlink-backend/src/modules/payments/contracts.routes.js
 */

const { Router } = require('express');
const {
  listMyContracts,
  listProviderContracts,
  createContract,
  checkoutContractPayment,
  completeContract,
  getContractReceipt,
  createContractDispute,
  listContractDisputes,
  resolveContractDispute,
} = require('./payments.controller');
const { verifyToken, verifyRole, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// ============================================================================
// 1. RUTAS ESTÁTICAS DE PRESTADOR Y DISPUTAS (Registradas antes de `/:id` para evitar colisión)
// ============================================================================
// Portal Prestador: listar contratos asignados y resumen de ingresos netos
router.get(
  '/provider',
  verifyToken,
  verifyRoleOrPortal(['provider', 'superadmin'], 'provider'),
  listProviderContracts
);

// Consultar disputas visibles según el rol del usuario autenticado (residente, prestador o admin)
router.get('/disputes', verifyToken, listContractDisputes);

// Mediación y cierre de una disputa abierta (Exclusivo admin / superadmin)
router.patch(
  '/disputes/:disputeId/resolve',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  resolveContractDispute
);

// ============================================================================
// 2. CICLO DE VIDA DE CONTRATOS DEL RESIDENTE Y COMPROBANTES
// ============================================================================
// Listar todos los contratos del residente autenticado
router.get('/', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), listMyContracts);

// Crear un nuevo contrato de servicio con un prestador verificado
router.post('/', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createContract);

// Iniciar o ejecutar el pago del contrato (modo mock o Mercado Pago Checkout Pro)
router.post('/:id/pay', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), checkoutContractPayment);

// Registrar conformidad final de obra/servicio completado por el residente
router.patch('/:id/complete', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), completeContract);

// Descargar/consultar comprobante detallado del contrato (partes involucradas o admin)
router.get('/:id/receipt', verifyToken, getContractReceipt);

// Abrir un reclamo/disputa por garantía asociado al contrato indicado
router.post('/:id/dispute', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createContractDispute);

module.exports = router;
