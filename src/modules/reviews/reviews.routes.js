/**
 * @file reviews.routes.js
 * @description Enrutador completo para la gestión de contratos y calificaciones cruzadas.
 * @location /trustlink-backend/src/modules/reviews/reviews.routes.js
 */

const { Router } = require('express');
const { createContract, completeContract, createReview } = require('./reviews.controller');
const { verifyToken, verifyRole } = require('../../middlewares/auth.middleware');

const router = Router();

// Endpoint para registrar un contrato de servicio (Rol: owner, family)
router.post('/contract', verifyToken, verifyRole(['owner', 'family']), createContract);

// Endpoint para marcar un contrato como completado (Rol: owner, family, admin)
router.patch('/contract/complete', verifyToken, verifyRole(['owner', 'family', 'admin']), completeContract);

// Endpoint para emitir reseña y calificación (Rol: owner, family)
router.post('/review', verifyToken, verifyRole(['owner', 'family']), createReview);

module.exports = router;