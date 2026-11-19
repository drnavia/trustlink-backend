/**
 * @file external.routes.js
 * @description Enrutador para endpoints de consumo externo por aplicaciones de barrios privados.
 * @location /trustlink-backend/src/modules/external/external.routes.js
 */

const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { verifyExternalPassByQR } = require('./external.controller');

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

// Endpoint para validación de pase QR desde aplicaciones de barrios privados
router.post('/passes/verify', optionalJwtAuth, verifyExternalPassByQR);

module.exports = router;