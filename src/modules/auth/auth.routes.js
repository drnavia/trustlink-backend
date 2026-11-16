/**
 * @file auth.routes.js
 * @description Enrutador para las operaciones de autenticación y gestión de accesos maestros.
 * @location /trustlink-backend/src/modules/auth/auth.routes.js
 */
const { Router } = require('express');
const { register, login, getPrivilegedUsers } = require('./auth.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const router = Router();

// Ruta de Registro Público: POST /api/v1/auth/register
router.post('/register', register);

// Ruta de Login: POST /api/v1/auth/login
router.post('/login', login);

// Ruta protegida para listar usuarios con privilegios (Exclusivo Superadmin): GET /api/v1/auth/users/privileged
router.get('/users/privileged', verifyToken, verifyRole(['superadmin']), getPrivilegedUsers);

module.exports = router;