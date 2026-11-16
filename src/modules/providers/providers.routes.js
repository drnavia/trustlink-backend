/**
 * @file providers.routes.js
 * @description Enrutador completo para la gestión de perfiles de prestadores, compliance y vehículos,
 * con control de acceso basado en roles globales de TrustLink.
 * @location /trustlink-backend/src/modules/providers/providers.routes.js
 */

const { Router } = require('express');
const {
  updateProviderProfile,
  addVehicle,
  updateComplianceStatus,
  listVerifiedProviders
} = require('./providers.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Endpoint para que un prestador actualice su perfil y documentación (Rol: provider)
router.post('/profile', verifyToken, verifyRole(['provider']), updateProviderProfile);

// Endpoint para que un prestador registre un vehículo (Rol: provider)
router.post('/vehicle', verifyToken, verifyRole(['provider']), addVehicle);

// Endpoint exclusivo para el equipo de Operaciones / Superadmin central de TrustLink
router.patch('/compliance', verifyToken, verifyRole(['superadmin']), updateComplianceStatus);

// Endpoint para listar prestadores verificados en el directorio del country (Roles: owner, family, admin, superadmin)
router.get('/directory', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), listVerifiedProviders);

module.exports = router;