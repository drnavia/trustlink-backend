/**
 * @file auth.routes.js
 * @description Enrutador para las operaciones de autenticación (registro y login).
 * @location /trustlink-backend/src/modules/auth/auth.routes.js
 */

const { Router } = require('express');
const { register, login } = require('./auth.controller');

const router = Router();

// Endpoint de Registro: POST /api/v1/auth/register
router.post('/register', register);

// Endpoint de Login: POST /api/v1/auth/login
router.post('/login', login);

module.exports = router;