/**
 * @file server.js
 * @description Punto de entrada principal del backend de TrustLink. Configura Express,
 * middlewares de seguridad y enrutamiento modular por dominios.
 * @location /trustlink-backend/src/server.js
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Importar rutas modulares
const authRoutes = require('./modules/auth/auth.routes');
const passesRoutes = require('./modules/passes/passes.routes'); // 🚀 Nuevo Módulo
const providersRoutes = require('./modules/providers/providers.routes'); // 🚀 Nuevo Módulo
const reviewsRoutes = require('./modules/reviews/reviews.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');

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

// Endpoint de salud (Health Check)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ONLINE', 
    architecture: 'Modular Domain-Based',
    service: 'TrustLink API Backend',
    timestamp: new Date().toISOString() 
  });
});

// Levantar el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor modular de TrustLink corriendo exitosamente en el puerto ${PORT}`);
});