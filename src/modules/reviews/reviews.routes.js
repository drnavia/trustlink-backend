/**
 * @file reviews.routes.js
 * @description Enrutador para consulta de contratos y emisión de reseñas cruzadas (Residente <-> Prestador).
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

// Listar contratos del residente o prestador con estado de reseñas cruzadas
router.get('/contracts', verifyToken, verifyRoleOrPortal(['owner', 'family', 'provider', 'superadmin'], 'resident'), getContractsForReviews);

// Residente califica al prestador (y recalcula rating_avg en providers)
router.post('/provider', verifyToken, verifyRoleOrPortal(['owner', 'family', 'superadmin'], 'resident'), createProviderReview);

// Prestador califica al residente/propietario
router.post('/owner', verifyToken, verifyRoleOrPortal(['provider', 'superadmin'], 'provider'), createOwnerReview);

// Consultar reseñas públicas/verificadas de un prestador
router.get('/provider/:providerId', verifyToken, getProviderReviewsById);

module.exports = router;