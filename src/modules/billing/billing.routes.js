/**
 * @file billing.routes.js
 * @description Rutas para gestión de membresías "Socio Verificado" de prestadores
 * (consulta propia, suscripción/renovación y administración centralizada por Superadmin).
 * @location /trustlink-backend/src/modules/billing/billing.routes.js
 */

const { Router } = require('express');
const {
  getMyProviderMembership,
  subscribeProviderMembership,
  adminManageProviderMembership,
  listProviderMembershipsForOps,
} = require('./billing.controller');
const { verifyToken, verifyRole, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// Portal Prestador: consultar estado de membresía y planes disponibles
router.get(
  '/provider/me',
  verifyToken,
  verifyRoleOrPortal(['provider', 'superadmin'], 'provider'),
  getMyProviderMembership
);

// Portal Prestador: activar o renovar plan Socio Verificado
router.post(
  '/provider/subscribe',
  verifyToken,
  verifyRoleOrPortal(['provider', 'superadmin'], 'provider'),
  subscribeProviderMembership
);

// Operaciones / Superadmin: listado global y gestión manual de membresías
router.get('/providers', verifyToken, verifyRole(['superadmin']), listProviderMembershipsForOps);
router.patch(
  '/provider/:userId',
  verifyToken,
  verifyRole(['superadmin']),
  adminManageProviderMembership
);

module.exports = router;
