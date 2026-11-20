/**
 * @file branding.routes.js
 * @description Enrutador modular para consulta y actualización (exclusivo superadmin)
 * de la configuración de apariencia de TrustLink.
 * @location /trustlink-backend/src/modules/branding/branding.routes.js
 */

const { Router } = require('express');
const { getBranding, updateBranding } = require('./branding.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Consulta pública de apariencia activa al cargar la plataforma
router.get('/', getBranding);

// Actualización protegida para el rol superadmin
router.put('/', verifyToken, verifyRole(['superadmin']), updateBranding);

module.exports = router;