/**
 * @file passes.routes.js
 * @description Rutas de pases QR para residentes (emitir, consultar, editar, cancelar),
 * prestadores (consultar pases asignados) y garita (validar).
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  createPass,
  getMyPasses,
  listProviderPasses,
  updatePass,
  cancelPass,
  verifyPassByQR,
} = require('./passes.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);
router.get('/my', verifyToken, verifyRole(['owner', 'family']), getMyPasses);
router.get('/provider', verifyToken, verifyRole(['provider', 'superadmin']), listProviderPasses);
router.patch('/:id', verifyToken, verifyRole(['owner', 'family']), updatePass);
router.patch('/:id/cancel', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), cancelPass);
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;