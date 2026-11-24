/**
 * @file reviews.routes.js
 * @description Enrutador montado en `/api/v1/reviews` para el sistema de reputación bidireccional
 * (Residente <-> Prestador): consulta de contratos elegibles, calificación mutua tras el servicio
 * y consulta pública/autenticada de reseñas verificadas de cada prestador.
 * @location /trustlink-backend/src/modules/reviews/reviews.routes.js
 */

const { Router } = require('express');
const {
  getContractsForReviews,
  createProviderReview,
  createOwnerReview,
  getProviderReviewsById
} = require('./reviews.controller');
const { verifyToken, verifyRoleOrPortal } = require('../../middlewares/auth.middleware');

const router = Router();

// ============================================================================
// GESTIÓN Y CONSULTA DE RESEÑAS CRUZADAS (Requiere JWT válido)
// ============================================================================
// Listar contratos del usuario autenticado indicando qué reseñas ya fueron emitidas o están pendientes
router.get('/contracts', verifyToken, verifyRoleOrPortal(['owner', 'family', 'provider', 'superadmin'], 'resident'), getContractsForReviews);

// Residente califica al prestador por un contrato finalizado (recalcula `rating_avg` en `providers`)
router.post('/provider', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createProviderReview);

// Prestador califica al residente/propietario en `owner_reviews` (reputación cruzada)
router.post('/owner', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), createOwnerReview);

// Consultar historial de reseñas verificadas asociadas a un prestador por su ID
router.get('/provider/:providerId', verifyToken, getProviderReviewsById);

module.exports = router;