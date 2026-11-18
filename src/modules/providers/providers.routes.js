/**
 * @file providers.routes.js
 * @description Enrutador para perfiles de prestadores, vehículos, directorio y compliance centralizado.
 * @location /trustlink-backend/src/modules/providers/providers.routes.js
 */

const { Router } = require('express');
const {
  updateProviderProfile,
  editProviderProfile,
  addVehicle,
  editVehicle,
  getMyProviderProfile,
  listAllProvidersForOps,
  updateComplianceStatus,
  listVerifiedProviders
} = require('./providers.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Perfil y flota del prestador autenticado
router.get('/me', verifyToken, verifyRole(['provider', 'superadmin']), getMyProviderProfile);
router.post('/profile', verifyToken, verifyRole(['provider']), updateProviderProfile);
router.patch('/profile/:id', verifyToken, verifyRole(['provider']), editProviderProfile);
router.post('/vehicle', verifyToken, verifyRole(['provider']), addVehicle);
router.patch('/vehicle/:id', verifyToken, verifyRole(['provider']), editVehicle);

// Auditoría global y certificación de compliance (Exclusivo superadmin / Ops TrustLink)
router.get('/all', verifyToken, verifyRole(['superadmin']), listAllProvidersForOps);
router.patch('/compliance', verifyToken, verifyRole(['superadmin']), updateComplianceStatus);

// Directorio de prestadores verificados
router.get('/directory', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), listVerifiedProviders);

module.exports = router;