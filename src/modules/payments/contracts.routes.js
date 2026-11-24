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
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

router.get('/', verifyToken, verifyRole(['owner', 'family', 'superadmin']), listMyContracts);
router.post('/', verifyToken, verifyRole(['owner', 'family', 'superadmin']), createContract);
router.post('/:id/pay', verifyToken, verifyRole(['owner', 'family', 'superadmin']), checkoutContractPayment);

module.exports = router;
