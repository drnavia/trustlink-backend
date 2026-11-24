/**
 * @file server.js
 * @description Punto de entrada principal del backend de TrustLink. Configura Express,
 * CORS adaptable (local y externo), middlewares globales y enrutamiento modular.
 * @location /trustlink-backend/src/server.js
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./modules/auth/auth.routes');
const passesRoutes = require('./modules/passes/passes.routes');
const providersRoutes = require('./modules/providers/providers.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const contractsRoutes = require('./modules/payments/contracts.routes');
const externalRoutes = require('./modules/external/external.routes');
const reviewsRoutes = require('./modules/reviews/reviews.routes');
const brandingRoutes = require('./modules/branding/branding.routes');
const accountRoutes = require('./modules/auth/account.routes');
const { ensureEvolutionSchema } = require('./config/ensureEvolutionSchema');

const app = express();
const PORT = process.env.PORT || 4000;

// CONFIGURACIÓN DE CORS (LOCAL + EXTERNO)
// Si se define CORS_ORIGINS (ej: "https://tu-app.vercel.app,http://localhost:5173"),
// se valida contra esa lista; si no está definida, permite cualquier origen para facilitar pruebas.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Peticiones sin cabecera Origin (curl, Postman, healthchecks internos)
    if (!origin || allowedOrigins.length === 0) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true,
};

// MIDDLEWARES GLOBALES
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// RUTAS MODULARES DE LA API (v1)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/passes', passesRoutes);
app.use('/api/v1/providers', providersRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/contracts', contractsRoutes);
app.use('/api/v1/external', externalRoutes);
app.use('/api/v1/reviews', reviewsRoutes);
app.use('/api/v1/branding', brandingRoutes);
app.use('/api/v1/account', accountRoutes);

// ENDPOINT DE SALUD DEL SERVIDOR
app.get('/health', (req, res) => {
  const runtimeEnv =
    process.env.RENDER || process.env.NODE_ENV === 'production' ? 'external' : 'local';

  res.status(200).json({
    status: 'ONLINE',
    architecture: 'Modular Domain-Based',
    service: 'TrustLink API Backend',
    runtime_mode: runtimeEnv,
    timestamp: new Date().toISOString(),
  });
});

// INICIO DEL SERVIDOR
app.listen(PORT, () => {
  console.log(`🚀 Servidor modular de TrustLink corriendo en el puerto ${PORT}`);
  ensureEvolutionSchema().catch((err) => {
    console.warn('⚠️ Aviso al inicializar esquema evolutivo en arranque:', err.message);
  });
});