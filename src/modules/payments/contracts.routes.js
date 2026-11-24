/**
 * @file contracts.routes.js
 * @description Enrutador para alta, consulta y pago de contratos de servicio (/api/v1/contracts).
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

// Listado de contratos/ingresos para Portal Prestador y reclamos/disputas (antes de /:id)
router.get(
  '/provider',
  verifyToken,
  verifyRoleOrPortal(['provider', 'superadmin'], 'provider'),
  listProviderContracts
);
router.get('/disputes', verifyToken, listContractDisputes);
router.patch(
  '/disputes/:disputeId/resolve',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  resolveContractDispute
);

router.get('/', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), listMyContracts);
router.post('/', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createContract);
router.post('/:id/pay', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), checkoutContractPayment);
router.patch('/:id/complete', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), completeContract);
router.get('/:id/receipt', verifyToken, getContractReceipt);
router.post('/:id/dispute', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createContractDispute);

module.exports = router;
