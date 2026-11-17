/**
 * @file auth.routes.js
 * @description Enrutador para operaciones de autenticación y gestión maestra de accesos (Ops Master).
 * @location /trustlink-backend/src/modules/auth/auth.routes.js
 */
const { Router } = require('express');
const { register, login, getPrivilegedUsers, updatePrivilegedUser } = require('./auth.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const router = Router();

router.post('/register', register);
router.post('/login', login);

// Endpoints protegidos para Ops TrustLink / Ops Master (Exclusivo Superadmin)
router.get('/users/privileged', verifyToken, verifyRole(['superadmin']), getPrivilegedUsers);
router.patch('/users/privileged/:id', verifyToken, verifyRole(['superadmin']), updatePrivilegedUser);

module.exports = router;