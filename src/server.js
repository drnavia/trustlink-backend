/**
 * @file server.js
 * @description Punto de entrada principal del backend de TrustLink. Configura Express,
 * middlewares globales de seguridad y el enrutamiento modular de todos los dominios.
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

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/passes', passesRoutes);
app.use('/api/v1/providers', providersRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/external', externalRoutes);
app.use('/api/v1/reviews', reviewsRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'trustlink-backend' });
});

app.listen(PORT, () => {
  console.log(`Servidor TrustLink ejecutándose en http://localhost:${PORT}`);
});