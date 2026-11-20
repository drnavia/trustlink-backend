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
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Listar contratos del residente o prestador con estado de reseñas cruzadas
router.get('/contracts', verifyToken, verifyRole(['owner', 'family', 'provider', 'superadmin']), getContractsForReviews);

// Residente califica al prestador (y recalcula rating_avg en providers)
router.post('/provider', verifyToken, verifyRole(['owner', 'family']), createProviderReview);

// Prestador califica al residente/propietario
router.post('/owner', verifyToken, verifyRole(['provider']), createOwnerReview);

// Consultar reseñas públicas/verificadas de un prestador
router.get('/provider/:providerId', verifyToken, getProviderReviewsById);

module.exports = router;