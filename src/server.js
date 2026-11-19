/**
 * @file server.js
 * @description Punto de entrada principal del backend de TrustLink. Configura Express,
 * middlewares de seguridad y enrutamiento modular por dominios.
 * @location /trustlink-backend/src/server.js
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Importar rutas modulares
const authRoutes = require('./modules/auth/auth.routes');
const passesRoutes = require('./modules/passes/passes.routes'); // 🚀 Nuevo Módulo
const providersRoutes = require('./modules/providers/providers.routes'); // 🚀 Nuevo Módulo
const reviewsRoutes = require('./modules/reviews/reviews.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const externalRoutes = require('./modules/external/external.routes');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares globales
app.use(cors());
app.use(express.json());

// REGISTRO DE MÓDULOS DE LA API
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/passes', passesRoutes); // 🚀 Nuevo endpoint base /api/v1/passes
app.use('/api/v1/providers', providersRoutes); // 🚀 Nuevo endpoint base /api/v1/providers
app.use('/api/v1/reviews', reviewsRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/external', externalRoutes);

// Endpoint de salud (Health Check)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'TrustLink API Backend' });
});

// Levantar el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor TrustLink ejecutándose en http://localhost:${PORT}`);
});


