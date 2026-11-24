/**
 * @file account.routes.js
 * @description Enrutador montado en `/api/v1/account` con rutas protegidas por JWT para consultar
 * y actualizar "Mi Cuenta / Mi Perfil", ubicación residencial normalizada, capacidades de identidad
 * dual, Portal Principal preferido y cambio de contraseña del usuario autenticado.
 * @location /trustlink-backend/src/modules/auth/account.routes.js
 */

const { Router } = require('express');
const { verifyToken } = require('../../middlewares/auth.middleware');
const {
  getMyAccount,
  updateMyProfile,
  updatePrimaryPortal,
  changeMyPassword,
} = require('./account.controller');

const router = Router();

// ============================================================================
// AUTOGESTIÓN DE CUENTA DEL USUARIO AUTENTICADO (Requiere JWT válido)
// ============================================================================
// Obtener perfil completo, comunidad asignada, lote/manzana y portales habilitados
router.get('/me', verifyToken, getMyAccount);

// Actualizar datos personales, ubicación residencial normalizada y banderas de portal dual
router.patch('/profile', verifyToken, updateMyProfile);

// Definir el portal principal de aterrizaje tras iniciar sesión ('resident' o 'provider')
router.patch('/primary-portal', verifyToken, updatePrimaryPortal);

// Cambiar contraseña validando previamente la contraseña actual del usuario
router.patch('/password', verifyToken, changeMyPassword);

module.exports = router;