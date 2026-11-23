/**
 * @file passes.routes.js
 * @description Rutas para coordinación previa de visitas, emisión/consulta/edición/cancelación
 * de pases QR por residentes, consulta por prestadores y validación en garita.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  createVisitCoordination,
  createPass,
  getMyPasses,
  listProviderPasses,
  updatePass,
  cancelPass,
  verifyPassByQR,
} = require('./passes.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

router.post('/visit-requests', verifyToken, verifyRole(['owner', 'family']), createVisitCoordination);
router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);
router.get('/my', verifyToken, verifyRole(['owner', 'family']), getMyPasses);
router.get('/provider', verifyToken, verifyRole(['provider', 'superadmin']), listProviderPasses);
router.patch('/:id', verifyToken, verifyRole(['owner', 'family']), updatePass);
router.patch('/:id/cancel', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), cancelPass);
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;