/**
 * @file auth.routes.js
 * @description Enrutador montado en `/api/v1/auth` para catálogo público de comunidades,
 * registro, inicio de sesión, recuperación de contraseña con rate limiting y gestión
 * maestra de usuarios privilegiados (`admin`, `security`, `superadmin`).
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

// ============================================================================
// LIMITADORES DE TASA (PROTECCIÓN ANTI FUERZA BRUTA POR IP)
// ============================================================================
// Máximo 25 intentos de login cada 15 minutos por IP
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyPrefix: 'auth-login',
  message: 'Demasiados intentos de inicio de sesión. Esperá unos minutos.',
});

// Máximo 15 registros cada 15 minutos por IP
const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyPrefix: 'auth-register',
  message: 'Demasiados intentos de registro desde esta dirección. Esperá unos minutos.',
});

// Máximo 10 solicitudes de recuperación/restablecimiento cada 15 minutos por IP
const resetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'auth-reset',
  message: 'Demasiadas solicitudes de recuperación de contraseña. Esperá unos minutos.',
});

// ============================================================================
// ENDPOINTS PÚBLICOS DE ONBOARDING Y AUTENTICACIÓN
// ============================================================================
// Catálogo público de comunidades activas para el selector del formulario de registro
router.get('/countries', listPublicCountries);

// Registro público (solo roles estándar), inicio de sesión JWT y flujo de recuperación
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);

// ============================================================================
// GESTIÓN DE USUARIOS PRIVILEGIADOS (Exclusivo Superadmin)
// ============================================================================
// Alta, listado y actualización de cuentas administrativas y de seguridad perimetral
router.get('/users/privileged', verifyToken, verifyRole(['superadmin']), getPrivilegedUsers);
router.post('/users/privileged', verifyToken, verifyRole(['superadmin']), createPrivilegedUser);
router.patch('/users/privileged/:id', verifyToken, verifyRole(['superadmin']), updatePrivilegedUser);

module.exports = router;