/**
 * @file auth.routes.js
 * @description Enrutador para autenticación y gestión maestra de usuarios privilegiados.
 * @location /trustlink-backend/src/modules/auth/auth.routes.js
 */

const { Router } = require('express');
const {
  listPublicCountries,
  register,
  login,
  forgotPassword,
  resetPassword,
  createPrivilegedUser,
  getPrivilegedUsers,
  updatePrivilegedUser,
} = require('./auth.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const { createRateLimiter } = require('../../middlewares/security.middleware');

const router = Router();

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyPrefix: 'auth-login',
  message: 'Demasiados intentos de inicio de sesión. Esperá unos minutos.',
});

const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyPrefix: 'auth-register',
  message: 'Demasiados intentos de registro desde esta dirección. Esperá unos minutos.',
});

const resetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'auth-reset',
  message: 'Demasiadas solicitudes de recuperación de contraseña. Esperá unos minutos.',
});

// Catálogo público de comunidades activas para el formulario de registro
router.get('/countries', listPublicCountries);

// Registro público (solo roles no administrativos), inicio de sesión y recuperación
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);

// Gestión de usuarios privilegiados (Exclusivo superadmin)
router.get('/users/privileged', verifyToken, verifyRole(['superadmin']), getPrivilegedUsers);
router.post('/users/privileged', verifyToken, verifyRole(['superadmin']), createPrivilegedUser);
router.patch('/users/privileged/:id', verifyToken, verifyRole(['superadmin']), updatePrivilegedUser);

module.exports = router;