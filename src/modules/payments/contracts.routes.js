/**
 * @file contracts.routes.js
 * @description Enrutador para alta, consulta y pago de contratos de servicio (/api/v1/contracts).
 * @location /trustlink-backend/src/modules/payments/contracts.routes.js
 */

const { Router } = require('express');
const {
  listMyContracts,
  createContract,
  checkoutContractPayment,
} = require('./payments.controller');
const { verifyToken, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

router.get('/', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), listMyContracts);
router.post('/', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createContract);
router.post('/:id/pay', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), checkoutContractPayment);

module.exports = router;
