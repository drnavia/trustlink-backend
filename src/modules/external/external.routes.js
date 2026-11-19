/**
 * @file external.routes.js
 * @description Enrutador para endpoints de consumo externo, diagnóstico técnico,
 * gestión de pases QR, administración de comunidades, integraciones por comunidad
 * y auditoría de accesos y transacciones (Punto 5).
 * @location /trustlink-backend/src/modules/external/external.routes.js
 */

const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const {
  getExternalDiagnostics,
  listCountries,
  createCountry,
  updateCountry,
  toggleCountryStatus,
  listCommunityIntegrations,
  createCommunityIntegration,
  rotateCommunityIntegrationKey,
  toggleCommunityIntegrationStatus,
  listRecentPasses,
  cancelPassById,
  getAuditOverview,
  verifyExternalPassByQR
} = require('./external.controller');

const router = Router();

const optionalJwtAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(403).json({
        authorized: false,
        code: 'INVALID_BEARER_TOKEN',
        error: 'Token Bearer inválido o expirado.'
      });
    }
  }
  next();
};

// Diagnóstico técnico (Exclusivo superadmin)
router.get('/status', verifyToken, verifyRole(['superadmin']), getExternalDiagnostics);

// Gestión de comunidades (Exclusivo superadmin)
router.get('/countries', verifyToken, verifyRole(['superadmin']), listCountries);
router.post('/countries', verifyToken, verifyRole(['superadmin']), createCountry);
router.patch('/countries/:id', verifyToken, verifyRole(['superadmin']), updateCountry);
router.patch('/countries/:id/toggle', verifyToken, verifyRole(['superadmin']), toggleCountryStatus);

// Integraciones y claves API por comunidad (Exclusivo superadmin)
router.get('/integrations', verifyToken, verifyRole(['superadmin']), listCommunityIntegrations);
router.post('/integrations', verifyToken, verifyRole(['superadmin']), createCommunityIntegration);
router.patch('/integrations/:id/rotate', verifyToken, verifyRole(['superadmin']), rotateCommunityIntegrationKey);
router.patch('/integrations/:id/toggle', verifyToken, verifyRole(['superadmin']), toggleCommunityIntegrationStatus);

// Gestión de pases QR recientes (Exclusivo superadmin)
router.get('/passes', verifyToken, verifyRole(['superadmin']), listRecentPasses);
router.patch('/passes/:id/cancel', verifyToken, verifyRole(['superadmin']), cancelPassById);

// Punto 5: Trazabilidad de eventos y auditoría de accesos y transacciones (Exclusivo superadmin)
router.get('/audit', verifyToken, verifyRole(['superadmin']), getAuditOverview);

// Validación externa de pase QR
router.post('/passes/verify', optionalJwtAuth, verifyExternalPassByQR);

module.exports = router;