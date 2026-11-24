/**
 * @file providers.routes.js
 * @description Enrutador completo para perfiles de prestadores, compliance, flota vehicular,
 * directorio unificado para residentes, auditoría centralizada en Ops TrustLink
 * y reportes/suspensiones operativas locales por comunidad (admin / superadmin).
 * @location /trustlink-backend/src/modules/providers/providers.routes.js
 */

const { Router } = require('express');
const {
  updateProviderProfile,
  editProviderProfile,
  addVehicle,
  editVehicle,
  listProviderEmployees,
  addProviderEmployee,
  updateProviderEmployee,
  deleteProviderEmployee,
  getMyProviderProfile,
  listAllProvidersForOps,
  updateComplianceStatus,
  listVerifiedProviders,
  listLocalSuspensions,
  createLocalSuspension,
  liftLocalSuspension,
  listExpiryAlertsForAdmin
} = require('./providers.controller');
const { verifyToken, verifyRole, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// Obtener credenciales/perfiles y flota vehicular del prestador autenticado
router.get('/me', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), getMyProviderProfile);

// Registrar una nueva especialidad y documentación de compliance
router.post('/profile', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), updateProviderProfile);

// Editar una credencial de compliance existente por ID
router.patch('/profile/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), editProviderProfile);

// Asociar un nuevo vehículo a la flota del prestador
router.post('/vehicle', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), addVehicle);

// Editar un vehículo existente por ID
router.patch('/vehicle/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), editVehicle);

// Gestión de ayudantes / cuadrilla del prestador
router.get('/employees', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), listProviderEmployees);
router.post('/employees', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), addProviderEmployee);
router.patch('/employees/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), updateProviderEmployee);
router.delete('/employees/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), deleteProviderEmployee);

// Listar todos los prestadores registrados para auditoría centralizada en Ops TrustLink
router.get('/all', verifyToken, verifyRole(['superadmin']), listAllProvidersForOps);

// Aprobar, rechazar o dejar pendiente el estado de compliance global de un prestador
router.patch('/compliance', verifyToken, verifyRole(['superadmin']), updateComplianceStatus);

// Directorio unificado de prestadores verificados para residentes y roles autorizados
router.get(
  '/directory',
  verifyToken,
  verifyRoleOrPortal(['owner', 'family', 'admin', 'superadmin'], 'resident'),
  listVerifiedProviders
);

// Reportes y suspensiones operativas locales por comunidad (Roles: admin, superadmin)
router.get(
  '/local-suspensions',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  listLocalSuspensions
);

router.post(
  '/local-suspensions',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  createLocalSuspension
);

router.patch(
  '/local-suspensions/:id/lift',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  liftLocalSuspension
);

// Alertas proactivas de vencimiento documental (ART, antecedentes, seguro vehicular y cuadrilla)
router.get(
  '/expiry-alerts',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  listExpiryAlertsForAdmin
);

module.exports = router;