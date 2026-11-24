/**
 * @file providers.routes.js
 * @description Enrutador montado en `/api/v1/providers` para la gestión integral de prestadores:
 * autogestión de especialidades, documentación de compliance, flota vehicular y cuadrilla;
 * auditoría centralizada en Ops TrustLink; directorio verificado para residentes; y control
 * operativo local por comunidad (suspensiones locales y alertas de vencimientos documentales).
 * @location /trustlink-backend/src/modules/providers/providers.routes.js
 */

const { Router } = require('express');
const {
  updateProviderProfile,
  editProviderProfile,
  toggleSpecialtyVisibility,
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

// ============================================================================
// 1. AUTOGESTIÓN DEL PORTAL PRESTADOR (Perfil, Compliance, Flota y Cuadrilla)
// ============================================================================
// Obtener credenciales/perfiles, especialidades, documentos y flota vehicular del prestador autenticado
router.get('/me', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), getMyProviderProfile);

// Registrar una nueva especialidad y subir documentación inicial de compliance (antecedentes/ART)
router.post('/profile', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), updateProviderProfile);

// Editar una credencial/especialidad de compliance existente por ID (actualiza fechas/certificados)
router.patch('/profile/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), editProviderProfile);

// Mostrar u ocultar una especialidad en el directorio sin afectar el estado de compliance aprobado
router.patch('/profile/:id/visibility', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), toggleSpecialtyVisibility);

// Asociar un nuevo vehículo (con patente y póliza de seguro) a la flota del prestador
router.post('/vehicle', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), addVehicle);

// Editar datos o renovar seguro de un vehículo existente por ID
router.patch('/vehicle/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), editVehicle);

// CRUD de ayudantes / cuadrilla vinculados al prestador (con control individual de póliza ART)
router.get('/employees', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), listProviderEmployees);
router.post('/employees', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), addProviderEmployee);
router.patch('/employees/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), updateProviderEmployee);
router.delete('/employees/:id', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), deleteProviderEmployee);

// ============================================================================
// 2. AUDITORÍA CENTRALIZADA DE COMPLIANCE — OPS TRUSTLINK (Exclusivo Superadmin)
// ============================================================================
// Listar todos los prestadores registrados con su documentación y estados de validación
router.get('/all', verifyToken, verifyRole(['superadmin']), listAllProvidersForOps);

// Aprobar, rechazar o pasar a pendiente el estado de compliance global de un prestador
router.patch('/compliance', verifyToken, verifyRole(['superadmin']), updateComplianceStatus);

// ============================================================================
// 3. DIRECTORIO UNIFICADO DE PRESTADORES VERIFICADOS (Portal Residente / Admin)
// ============================================================================
// Devuelve prestadores aprobados, visibles y sin suspensión activa en la comunidad del solicitante
router.get(
  '/directory',
  verifyToken,
  verifyRoleOrPortal(['owner', 'family', 'admin', 'superadmin'], 'resident'),
  listVerifiedProviders
);

// ============================================================================
// 4. CONTROL OPERATIVO LOCAL POR COMUNIDAD (Roles: admin, superadmin)
// ============================================================================
// Listar reportes y suspensiones locales de prestadores dentro de la comunidad
router.get(
  '/local-suspensions',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  listLocalSuspensions
);

// Crear una suspensión operativa local (bloquea emisión/validación de QR solo en esa comunidad)
router.post(
  '/local-suspensions',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  createLocalSuspension
);

// Levantar una suspensión local activa registrando fecha de rehabilitación (`lifted_at`)
router.patch(
  '/local-suspensions/:id/lift',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  liftLocalSuspension
);

// Alertas proactivas de documentación vencida o próxima a vencer (ART, antecedentes, vehículos y cuadrilla)
router.get(
  '/expiry-alerts',
  verifyToken,
  verifyRole(['admin', 'superadmin']),
  listExpiryAlertsForAdmin
);

module.exports = router;