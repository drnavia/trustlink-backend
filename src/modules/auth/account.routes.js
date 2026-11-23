/**
 * @file account.routes.js
 * @description Rutas protegidas para consultar y actualizar "Mi Cuenta / Mi Perfil",
 * ubicación residencial normalizada y Portal Principal del usuario autenticado.
 * @location /trustlink-backend/src/modules/auth/account.routes.js
 */

const { Router } = require('express');
const { verifyToken } = require('../../middlewares/auth.middleware');
const {
  getMyAccount,
  updateMyProfile,
  updatePrimaryPortal,
} = require('./account.controller');

const router = Router();

router.get('/me', verifyToken, getMyAccount);
router.patch('/profile', verifyToken, updateMyProfile);
router.patch('/primary-portal', verifyToken, updatePrimaryPortal);

module.exports = router;