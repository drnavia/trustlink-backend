/**
 * @file auth.routes.js
 * @description Enrutador para autenticación y gestión maestra de usuarios privilegiados.
 * @location /trustlink-backend/src/modules/auth/auth.routes.js
 */

const { Router } = require('express');
const { register, login, getPrivilegedUsers, updatePrivilegedUser } = require('./auth.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Registro e inicio de sesión
router.post('/register', register);
router.post('/login', login);

// Gestión de usuarios privilegiados (Exclusivo superadmin)
router.get('/users/privileged', verifyToken, verifyRole(['superadmin']), getPrivilegedUsers);
router.patch('/users/privileged/:id', verifyToken, verifyRole(['superadmin']), updatePrivilegedUser);

module.exports = router;