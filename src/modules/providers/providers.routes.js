/**
 * @file providers.routes.js
 * @description Enrutador para la gestión de perfiles de prestadores, compliance y vehículos.
 * @location /trustlink-backend/src/modules/providers/providers.routes.js
 */
const { Router } = require('express');
const {
  updateProviderProfile,
  addVehicle,
  listAllProvidersForOps,
  updateComplianceStatus,
  getMyProviderProfile,
  listVerifiedProviders
} = require('./providers.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const router = Router();

// Perfil y vehículos del prestador
router.get('/me', verifyToken, verifyRole(['provider', 'superadmin']), getMyProviderProfile);
router.post('/profile', verifyToken, verifyRole(['provider']), updateProviderProfile);
router.post('/vehicle', verifyToken, verifyRole(['provider']), addVehicle);

// Endpoints exclusivos para Ops TrustLink / Superadmin
router.get('/all', verifyToken, verifyRole(['superadmin']), listAllProvidersForOps);
router.patch('/compliance', verifyToken, verifyRole(['superadmin']), updateComplianceStatus);

// Directorio para residentes
router.get('/directory', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), listVerifiedProviders);

module.exports = router;