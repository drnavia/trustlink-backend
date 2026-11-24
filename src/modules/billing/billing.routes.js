/**
 * @file billing.routes.js
 * @description Enrutador montado en `/api/v1/billing` para la gestión de membresías
 * "Socio Verificado" de prestadores: autogestión desde el Portal Prestador (consulta y
 * suscripción/renovación) y administración global desde Operaciones por Superadmin.
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

// ============================================================================
// AUTOGESTIÓN DEL PORTAL PRESTADOR (Rol provider/superadmin o capacidad dual)
// ============================================================================
// Consultar estado vigente de la membresía "Socio Verificado", historial y planes disponibles
router.get(
  '/provider/me',
  verifyToken,
  verifyRoleOrPortal(['provider', 'superadmin'], 'provider'),
  getMyProviderMembership
);

// Activar o renovar la suscripción mensual/anual de "Socio Verificado"
router.post(
  '/provider/subscribe',
  verifyToken,
  verifyRoleOrPortal(['provider', 'superadmin'], 'provider'),
  subscribeProviderMembership
);

// ============================================================================
// ADMINISTRACIÓN CENTRALIZADA EN OPERACIONES (Exclusivo Superadmin)
// ============================================================================
// Listar todas las membresías activas/vencidas de prestadores para seguimiento comercial
router.get('/providers', verifyToken, verifyRole(['superadmin']), listProviderMembershipsForOps);

// Otorgar, extender, pausar o cancelar manualmente la membresía de un prestador por `userId`
router.patch(
  '/provider/:userId',
  verifyToken,
  verifyRole(['superadmin']),
  adminManageProviderMembership
);

module.exports = router;
