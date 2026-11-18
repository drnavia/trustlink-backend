/**
 * @file passes.routes.js
 * @description Enrutador para la emisión de pases QR por residentes y validación perimetral en garita.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const { createPass, verifyPassByQR } = require('./passes.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Generar pase de acceso con QR (Roles: owner, family)
router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);

// Validar pase QR en garita o tótem (Roles: security, admin, superadmin)
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;