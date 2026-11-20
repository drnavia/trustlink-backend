/**
 * @file server.js
 * @description Punto de entrada principal del backend de TrustLink. Configura Express,
 * middlewares globales de seguridad y el enrutamiento modular por dominios.
 * @location /trustlink-backend/src/server.js
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./modules/auth/auth.routes');
const passesRoutes = require('./modules/passes/passes.routes');
const providersRoutes = require('./modules/providers/providers.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const externalRoutes = require('./modules/external/external.routes');
const reviewsRoutes = require('./modules/reviews/reviews.routes');
const brandingRoutes = require('./modules/branding/branding.routes');

const app = express();
const PORT = process.env.PORT || 4000;

// MIDDLEWARES GLOBALES
app.use(cors());
// Límite ampliado a 3mb para admitir logos SVG/PNG/JPG codificados en base64
app.use(express.json({ limit: '3mb' }));

// RUTAS MODULARES DE LA API (v1)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/passes', passesRoutes);
app.use('/api/v1/providers', providersRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/external', externalRoutes);
app.use('/api/v1/reviews', reviewsRoutes);
app.use('/api/v1/branding', brandingRoutes);

// ENDPOINT DE SALUD DEL SERVIDOR
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ONLINE',
    architecture: 'Modular Domain-Based',
    service: 'TrustLink API Backend',
    timestamp: new Date().toISOString(),
  });
});

// INICIO DEL SERVIDOR
app.listen(PORT, () => {
  console.log(`🚀 Servidor modular de TrustLink corriendo en el puerto ${PORT}`);
});