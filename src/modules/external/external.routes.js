/**
 * @file external.routes.js
 * @description Enrutador para endpoints de consumo externo, diagnóstico técnico,
 * gestión de pases QR y administración de comunidades para superadmin.
 * @location /trustlink-backend/src/modules/external/external.routes.js
 */

const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const {
  getExternalDiagnostics,
  listCountries,
  createCountry,
  toggleCountryStatus,
  listRecentPasses,
  cancelPassById,
  verifyExternalPassByQR
} = require('./external.controller');

const router = Router();

/**
 * Middleware opcional: si se envía Authorization Bearer JWT válido, adjunta req.user;
 * si no, deja pasar para validar x-api-key en el controlador.
 */
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

// Endpoint de diagnóstico técnico (Exclusivo superadmin)
router.get('/status', verifyToken, verifyRole(['superadmin']), getExternalDiagnostics);

// Gestión de comunidades / countries (Exclusivo superadmin)
router.get('/countries', verifyToken, verifyRole(['superadmin']), listCountries);
router.post('/countries', verifyToken, verifyRole(['superadmin']), createCountry);
router.patch('/countries/:id/toggle', verifyToken, verifyRole(['superadmin']), toggleCountryStatus);

// Listado y cancelación de pases QR recientes (Exclusivo superadmin)
router.get('/passes', verifyToken, verifyRole(['superadmin']), listRecentPasses);
router.patch('/passes/:id/cancel', verifyToken, verifyRole(['superadmin']), cancelPassById);

// Endpoint para validación de pase QR desde aplicaciones de barrios privados
router.post('/passes/verify', optionalJwtAuth, verifyExternalPassByQR);

module.exports = router;