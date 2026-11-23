/**
 * @file passes.routes.js
 * @description Rutas para coordinación bidireccional de visitas, emisión/consulta/edición/cancelación
 * de pases QR por residentes, consulta por prestadores y validación en garita.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  createVisitCoordination,
  listMyVisitRequests,
  listProviderVisitRequests,
  addVisitRequestMessage,
  respondVisitRequest,
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
router.get('/visit-requests/my', verifyToken, verifyRole(['owner', 'family']), listMyVisitRequests);
router.get('/visit-requests/provider', verifyToken, verifyRole(['provider', 'superadmin']), listProviderVisitRequests);
router.post('/visit-requests/:id/messages', verifyToken, verifyRole(['owner', 'family', 'provider', 'admin', 'superadmin']), addVisitRequestMessage);
router.patch('/visit-requests/:id/respond', verifyToken, verifyRole(['provider', 'superadmin']), respondVisitRequest);

router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);
router.get('/my', verifyToken, verifyRole(['owner', 'family']), getMyPasses);
router.get('/provider', verifyToken, verifyRole(['provider', 'superadmin']), listProviderPasses);
router.patch('/:id', verifyToken, verifyRole(['owner', 'family']), updatePass);
router.patch('/:id/cancel', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), cancelPass);
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;