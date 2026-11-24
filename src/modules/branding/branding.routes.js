/**
 * @file branding.routes.js
 * @description Enrutador montado en `/api/v1/branding` para la consulta pública y la
 * actualización protegida (exclusivo Superadmin) de la apariencia white-label de TrustLink
 * (nombre, subtítulo, paleta cromática, logo y modo oscuro/claro).
 * @location /trustlink-backend/src/modules/branding/branding.routes.js
 */

const { Router } = require('express');
const { getBranding, updateBranding } = require('./branding.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Consulta pública sin autenticación para aplicar identidad visual desde la pantalla de login
router.get('/', getBranding);

// Actualización de la paleta, textos institucionales y logo (Exclusivo Superadmin)
router.put('/', verifyToken, verifyRole(['superadmin']), updateBranding);

module.exports = router;