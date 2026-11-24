/**
 * @file server.js
 * @description Punto de entrada principal del backend de TrustLink. Configura Express,
 * cabeceras defensivas, política CORS adaptable (local y externo), parseo JSON con captura
 * de rawBody para webhooks, enrutamiento modular v1 y verificación evolutiva de esquema al arranque.
 * @location /trustlink-backend/src/server.js
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Importación de enrutadores por dominio de negocio
const authRoutes = require('./modules/auth/auth.routes');
const passesRoutes = require('./modules/passes/passes.routes');
const providersRoutes = require('./modules/providers/providers.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const contractsRoutes = require('./modules/payments/contracts.routes');
const externalRoutes = require('./modules/external/external.routes');
const reviewsRoutes = require('./modules/reviews/reviews.routes');
const brandingRoutes = require('./modules/branding/branding.routes');
const accountRoutes = require('./modules/auth/account.routes');
const billingRoutes = require('./modules/billing/billing.routes');
const { ensureEvolutionSchema } = require('./config/ensureEvolutionSchema');
const { securityHeaders } = require('./middlewares/security.middleware');

// Inicialización de la instancia Express y endurecimiento básico de cabeceras/proxy
const app = express();
const PORT = process.env.PORT || 4000;
app.disable('x-powered-by'); // Oculta la firma tecnológica de Express en respuestas HTTP
app.set('trust proxy', 1); // Respeta X-Forwarded-For / X-Forwarded-Proto detrás de proxies (Render, Nginx)

// CONFIGURACIÓN DE CORS (LOCAL + EXTERNO)
// Si se define CORS_ORIGINS (ej: "https://tu-app.vercel.app,http://localhost:5173"),
// se valida contra esa lista; si no está definida, permite cualquier origen para facilitar pruebas.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  /**
   * Valida el encabezado Origin de cada solicitud entrante contra la lista blanca configurada.
   * @param {string|undefined} origin
   * @param {(err: Error|null, allow?: boolean) => void} callback
   */
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
// 1) Cabeceras defensivas HTTP, 2) CORS, 3) Parseo JSON de hasta 10 MB (soporta adjuntos base64)
//    preservando `req.rawBody` para validación de firmas en webhooks externos (ej. Mercado Pago).
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// RUTAS MODULARES DE LA API (v1)
app.use('/api/v1/auth', authRoutes);           // Autenticación, registro, reset y usuarios privilegiados
app.use('/api/v1/passes', passesRoutes);       // Agenda del prestador, visitas y pases QR
app.use('/api/v1/providers', providersRoutes); // Perfiles, compliance, flota, cuadrilla y directorio
app.use('/api/v1/payments', paymentsRoutes);   // Configuración de pasarela, checkout y webhooks
app.use('/api/v1/contracts', contractsRoutes); // Ciclo de vida de contratos, recibos y disputas
app.use('/api/v1/external', externalRoutes);   // API externa de garitas, comunidades, API keys y auditoría
app.use('/api/v1/reviews', reviewsRoutes);     // Reseñas cruzadas Residente <-> Prestador
app.use('/api/v1/branding', brandingRoutes);   // Configuración visual white-label
app.use('/api/v1/account', accountRoutes);     // Mi Cuenta, perfil, portal principal y contraseña
app.use('/api/v1/billing', billingRoutes);     // Membresías "Socio Verificado" de prestadores

// ENDPOINT DE SALUD DEL SERVIDOR
// Utilizado por monitores externos y verificaciones de despliegue (Render / CI).
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
// Levanta el listener HTTP y ejecuta en segundo plano la verificación idempotente del esquema evolutivo.
app.listen(PORT, () => {
  console.log(`🚀 Servidor modular de TrustLink corriendo en el puerto ${PORT}`);
  ensureEvolutionSchema().catch((err) => {
    console.warn('⚠️ Aviso al inicializar esquema evolutivo en arranque:', err.message);
  });
});