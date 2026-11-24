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
const { verifyToken, verifyRole, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

router.get('/schedule/provider', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), getProviderSchedule);
router.post('/schedule/blocks', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), createScheduleBlock);
router.delete('/schedule/blocks/:blockId', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), deleteScheduleBlock);

router.post('/visit-requests', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createVisitCoordination);
router.get('/visit-requests/my', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), listMyVisitRequests);
router.get('/visit-requests/provider', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), listProviderVisitRequests);
router.post('/visit-requests/:id/messages', verifyToken, verifyRole(['owner', 'family', 'provider', 'admin', 'superadmin']), addVisitRequestMessage);
router.patch('/visit-requests/:id/respond', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), respondVisitRequest);

router.post('/create', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createPass);
router.get('/my', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), getMyPasses);
router.get('/provider', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), listProviderPasses);
router.patch('/:id', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), updatePass);
router.patch('/:id/cancel', verifyToken, verifyRoleOrPortal(['owner', 'family', 'admin', 'superadmin'], 'resident'), cancelPass);
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;