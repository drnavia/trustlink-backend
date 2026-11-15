/**
 * @file passes.routes.js
 * @description Enrutador completo para la gestión y validación de pases de acceso (QR).
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const { createPass, verifyPassByQR } = require('./passes.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Endpoint para que un residente genere un pase (Requiere token y rol 'owner' o 'family')
router.post('/create', verifyToken, verifyRole(['owner', 'family']), createPass);

// Endpoint universal para la garita / tótem de validación (Requiere token y rol 'security', 'admin' o 'superadmin')
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;