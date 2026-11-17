/**
 * @file providers.routes.js
 * @description Enrutador para la gestión de perfiles, compliance histórico y vehículos de prestadores.
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

router.get('/me', verifyToken, verifyRole(['provider', 'superadmin']), getMyProviderProfile);
router.post('/profile', verifyToken, verifyRole(['provider']), updateProviderProfile);
router.patch('/profile/:id', verifyToken, verifyRole(['provider']), editProviderProfile);
router.post('/vehicle', verifyToken, verifyRole(['provider']), addVehicle);
router.patch('/vehicle/:id', verifyToken, verifyRole(['provider']), editVehicle);

router.get('/all', verifyToken, verifyRole(['superadmin']), listAllProvidersForOps);
router.patch('/compliance', verifyToken, verifyRole(['superadmin']), updateComplianceStatus);
router.get('/directory', verifyToken, verifyRole(['owner', 'family', 'admin', 'superadmin']), listVerifiedProviders);

// Exports
module.exports = router;