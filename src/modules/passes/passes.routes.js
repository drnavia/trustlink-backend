/**
 * @file passes.routes.js
 * @description Enrutador para emisión de pases QR por residentes, consulta de pases propios,
 * cancelación segura y validación perimetral en garita.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  createPass,
  listMyPasses,
  cancelPass,
  verifyPassByQR
} = require('./passes.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Generar pase de acceso con QR (Roles: owner, family)
router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);

// Consultar historial de pases QR generados por el residente autenticado (Roles: owner, family)
router.get('/my', verifyToken, verifyRole(['owner', 'family']), listMyPasses);

// Cancelar un pase QR pendiente propio o por rol administrativo
router.patch('/:id/cancel', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), cancelPass);

// Validar pase QR en garita / tótem (Roles: security, admin, superadmin)
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;