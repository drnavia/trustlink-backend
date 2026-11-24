/**
 * @file passes.routes.js
 * @description Rutas para agenda online del prestador, coordinación bidireccional de visitas,
 * emisión/consulta/edición/cancelación de pases QR y validación perimetral.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  getProviderSchedule,
  createScheduleBlock,
  deleteScheduleBlock,
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

router.get('/schedule/provider', verifyToken, verifyRole(['provider', 'superadmin']), getProviderSchedule);
router.post('/schedule/blocks', verifyToken, verifyRole(['provider', 'superadmin']), createScheduleBlock);
router.delete('/schedule/blocks/:blockId', verifyToken, verifyRole(['provider', 'superadmin']), deleteScheduleBlock);

router.post('/visit-requests', verifyToken, verifyRole(['owner', 'family', 'superadmin']), createVisitCoordination);
router.get('/visit-requests/my', verifyToken, verifyRole(['owner', 'family', 'superadmin']), listMyVisitRequests);
router.get('/visit-requests/provider', verifyToken, verifyRole(['provider', 'superadmin']), listProviderVisitRequests);
router.post('/visit-requests/:id/messages', verifyToken, verifyRole(['owner', 'family', 'provider', 'admin', 'superadmin']), addVisitRequestMessage);
router.patch('/visit-requests/:id/respond', verifyToken, verifyRole(['provider', 'superadmin']), respondVisitRequest);

router.post('/create', verifyToken, verifyRole(['owner', 'family', 'superadmin']), createPass);
router.get('/my', verifyToken, verifyRole(['owner', 'family', 'superadmin']), getMyPasses);
router.get('/provider', verifyToken, verifyRole(['provider', 'superadmin']), listProviderPasses);
router.patch('/:id', verifyToken, verifyRole(['owner', 'family', 'superadmin']), updatePass);
router.patch('/:id/cancel', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), cancelPass);
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;