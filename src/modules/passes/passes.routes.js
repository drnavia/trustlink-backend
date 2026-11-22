/**
 * @file passes.routes.js
 * @description Rutas para emisión, consulta y edición de pases QR vigentes
 * por residentes/familia y validación en garita.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  createPass,
  getMyPasses,
  updatePass,
  verifyPassByQR
} = require('./passes.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);
router.get('/my', verifyToken, verifyRole(['owner', 'family']), getMyPasses);
router.patch('/:id', verifyToken, verifyRole(['owner', 'family']), updatePass);
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;