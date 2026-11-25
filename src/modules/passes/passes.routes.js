/**
 * @file passes.routes.js
 * @description Enrutador montado en `/api/v1/passes` que cubre tres flujos operativos:
 * 1. Agenda online y bloqueos horarios del prestador.
 * 2. Coordinación bidireccional de visitas (solicitudes, mensajería y respuestas).
 * 3. Emisión, consulta, edición, cancelación y validación en garita de pases QR.
 * @location /trustlink-backend/src/modules/passes/passes.routes.js
 */

const { Router } = require('express');
const {
  getProviderSchedule,
  saveProviderAvailabilityRules,
  getProviderPublicAvailability,
  createScheduleBlock,
  deleteScheduleBlock,
  createVisitCoordination,
  listMyVisitRequests,
  listProviderVisitRequests,
  addVisitRequestMessage,
  respondVisitRequest,
  createPass,
  getMyPasses,
  listProviderPasses,
  updatePass,
  cancelPass,
  verifyPassByQR,
} = require('./passes.controller');
const { verifyToken, verifyRole, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// ============================================================================
// 1. AGENDA VIVA, JORNADA SEMANAL Y BLOQUEOS HORARIOS (Prestador <-> Residente)
// ============================================================================
// Consultar agenda combinada (jornada semanal, calendario vivo cada 30 min, bloqueos y pases) del prestador
router.get('/schedule/provider', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), getProviderSchedule);

// Guardar configuración semanal del prestador (días laborables, desde/hasta e intervalo 30/60 min)
router.put('/schedule/rules', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), saveProviderAvailabilityRules);

// Consultar disponibilidad viva (libre/ocupado sin exponer datos privados) de un prestador para residentes
router.get('/schedule/availability/:providerUserId', verifyToken, verifyRoleOrPortal(['owner', 'family', 'admin', 'superadmin'], 'resident'), getProviderPublicAvailability);

// Crear un bloqueo de no disponibilidad o visita externa en la agenda del prestador
router.post('/schedule/blocks', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), createScheduleBlock);

// Eliminar un bloqueo horario propio por ID
router.delete('/schedule/blocks/:blockId', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), deleteScheduleBlock);

// ============================================================================
// 2. COORDINACIÓN BIDIRECCIONAL DE VISITAS (Residente <-> Prestador)
// ============================================================================
// Residente inicia una solicitud de coordinación de visita con un prestador verificado
router.post('/visit-requests', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createVisitCoordination);

// Residente consulta sus solicitudes de visita emitidas y su historial de mensajes
router.get('/visit-requests/my', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), listMyVisitRequests);

// Prestador consulta las solicitudes de visita recibidas pendientes o confirmadas
router.get('/visit-requests/provider', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), listProviderVisitRequests);

// Agregar un mensaje al hilo de coordinación de una visita (participantes autorizados y admin)
router.post('/visit-requests/:id/messages', verifyToken, verifyRole(['owner', 'family', 'provider', 'admin', 'superadmin']), addVisitRequestMessage);

// Prestador acepta, propone alternativa o rechaza una solicitud de visita
router.patch('/visit-requests/:id/respond', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), respondVisitRequest);

// ============================================================================
// 3. CICLO DE VIDA DE PASES QR Y VALIDACIÓN PERIMETRAL EN GARITA
// ============================================================================
// Residente emite un nuevo pase QR (valida compliance, vencimientos, cuota comunitaria y cuadrilla)
router.post('/create', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createPass);

// Residente lista los pases QR emitidos para su lote
router.get('/my', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), getMyPasses);

// Prestador lista los pases QR donde figura autorizado para ingresar
router.get('/provider', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), listProviderPasses);

// Residente actualiza ventana horaria, vehículo o ayudantes de un pase vigente
router.patch('/:id', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), updatePass);

// Residente o administración revoca/cancela un pase QR existente
router.patch('/:id/cancel', verifyToken, verifyRoleOrPortal(['owner', 'family', 'admin', 'superadmin'], 'resident'), cancelPass);

// Garita / Seguridad interna valida un código QR (registro de ingreso y auditoría)
router.post('/verify', verifyToken, verifyRole(['security', 'admin', 'superadmin']), verifyPassByQR);

module.exports = router;