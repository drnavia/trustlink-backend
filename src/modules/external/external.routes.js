/**
 * @file external.routes.js
 * @description Enrutador montado en `/api/v1/external` para integración perimetral (garitas externas),
 * diagnóstico técnico del backend, administración de comunidades (countries) y su licenciamiento B2B,
 * gestión de claves API por comunidad, control de pases QR recientes y auditoría de accesos/transacciones.
 * @location /trustlink-backend/src/modules/external/external.routes.js
 */

const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');
const {
  getExternalDiagnostics,
  listCountries,
  createCountry,
  updateCountry,
  toggleCountryStatus,
  updateCountryBilling,
  getMyCommunityBilling,
  listCommunityIntegrations,
  createCommunityIntegration,
  rotateCommunityIntegrationKey,
  toggleCommunityIntegrationStatus,
  listRecentPasses,
  cancelPassById,
  getAuditOverview,
  verifyExternalPassByQR
} = require('./external.controller');

const router = Router();

/**
 * Middleware de autenticación JWT opcional diseñado para el endpoint híbrido `POST /passes/verify`.
 *
 * Comportamiento:
 * - Si la petición trae `Authorization: Bearer <token>`, intenta verificarlo con `JWT_SECRET`:
 *   - Si es válido, inyecta el payload en `req.user` y continúa (modo sesión interna admin/security/superadmin).
 *   - Si es inválido o expiró, corta inmediatamente con HTTP 403 (`INVALID_BEARER_TOKEN`).
 * - Si NO trae cabecera `Bearer`, no bloquea la petición y delega en el controlador, que exigirá
 *   autenticación mediante `X-API-Key` de una integración comunitaria activa (`country_integrations`).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const optionalJwtAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(403).json({
        authorized: false,
        code: 'INVALID_BEARER_TOKEN',
        error: 'Token Bearer inválido o expirado.'
      });
    }
  }
  next();
};

// ============================================================================
// 1. DIAGNÓSTICO TÉCNICO DEL SISTEMA (Exclusivo Superadmin)
// ============================================================================
// Devuelve estado de DB, entorno activo y métricas básicas de conectividad externa
router.get('/status', verifyToken, verifyRole(['superadmin']), getExternalDiagnostics);

// ============================================================================
// 2. GESTIÓN DE COMUNIDADES / COUNTRIES Y LICENCIAMIENTO B2B (Exclusivo Superadmin)
// ============================================================================
// Alta, edición de ficha postal, activación/desactivación y configuración de plan/cuota QR
router.get('/countries', verifyToken, verifyRole(['superadmin']), listCountries);
router.post('/countries', verifyToken, verifyRole(['superadmin']), createCountry);
router.patch('/countries/:id', verifyToken, verifyRole(['superadmin']), updateCountry);
router.patch('/countries/:id/toggle', verifyToken, verifyRole(['superadmin']), toggleCountryStatus);
router.patch('/countries/:id/billing', verifyToken, verifyRole(['superadmin']), updateCountryBilling);

// ============================================================================
// 3. CONSULTA DE LICENCIA B2B Y CONSUMO MENSUAL DE QR (Admin local / Superadmin)
// ============================================================================
// Permite a la administración del barrio ver su plan activo, vencimiento y pases emitidos del mes
router.get('/my-community/billing', verifyToken, verifyRole(['admin', 'superadmin']), getMyCommunityBilling);

// ============================================================================
// 4. INTEGRACIONES Y API KEYS DE GARITA POR COMUNIDAD (Exclusivo Superadmin)
// ============================================================================
// Listado, emisión de clave API (mostrada una sola vez), rotación segura y encendido/apagado
router.get('/integrations', verifyToken, verifyRole(['superadmin']), listCommunityIntegrations);
router.post('/integrations', verifyToken, verifyRole(['superadmin']), createCommunityIntegration);
router.patch('/integrations/:id/rotate', verifyToken, verifyRole(['superadmin']), rotateCommunityIntegrationKey);
router.patch('/integrations/:id/toggle', verifyToken, verifyRole(['superadmin']), toggleCommunityIntegrationStatus);

// ============================================================================
// 5. SUPERVISIÓN Y REVOCACIÓN DE PASES QR RECIENTES (Exclusivo Superadmin)
// ============================================================================
// Inspección global de pases emitidos en la plataforma y cancelación administrativa por ID
router.get('/passes', verifyToken, verifyRole(['superadmin']), listRecentPasses);
router.patch('/passes/:id/cancel', verifyToken, verifyRole(['superadmin']), cancelPassById);

// ============================================================================
// 6. AUDITORÍA Y TRAZABILIDAD DE ACCESOS Y TRANSACCIONES (Exclusivo Superadmin)
// ============================================================================
// Consolida logs de garita (`gate_access_logs`) y movimientos financieros para control operativo
router.get('/audit', verifyToken, verifyRole(['superadmin']), getAuditOverview);

// ============================================================================
// 7. VALIDACIÓN EXTERNA DE PASE QR EN GARITA (JWT opcional o API Key de comunidad)
// ============================================================================
// Punto de entrada para sistemas de control de acceso de terceros o consolas autorizadas;
// valida estado del pase, vencimientos documentales, cuadrilla, suspensiones y registra auditoría.
router.post('/passes/verify', optionalJwtAuth, verifyExternalPassByQR);

module.exports = router;