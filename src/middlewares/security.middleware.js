/**
 * @file security.middleware.js
 * @description Middlewares de seguridad HTTP (cabeceras defensivas equivalentes a Helmet)
 * y limitación de tasa (rate limiting en memoria por IP y prefijo de ruta) para proteger
 * endpoints sensibles de autenticación frente a ataques de fuerza bruta o abuso.
 * @location /trustlink-backend/src/middlewares/security.middleware.js
 */

/**
 * Inyecta cabeceras HTTP defensivas estándar en todas las respuestas salientes:
 * - `X-Content-Type-Options: nosniff`: evita inferencia MIME peligrosa.
 * - `X-Frame-Options: DENY`: previene clickjacking impidiendo embebido en iframes.
 * - `Referrer-Policy: no-referrer`: evita fuga de URLs sensibles en cabeceras Referer.
 * - `X-XSS-Protection: 0`: desactiva filtros XSS legacy obsoletos en navegadores.
 * - `Permissions-Policy`: restringe acceso no solicitado a geolocalización y micrófono.
 * - `Strict-Transport-Security` (HSTS): se añade únicamente bajo HTTPS/proxy seguro o producción.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');

  // Detecta conexión segura directa, terminación TLS en proxy o entorno de producción
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ||
    process.env.NODE_ENV === 'production';

  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
};

/**
 * Crea un middleware de rate limiting de ventana fija en memoria segmentado por `keyPrefix:clientIp`.
 * Soporta sobreescritura global del tope mediante `RATE_LIMIT_MAX_OVERRIDE` (útil en tests E2E)
 * e informa cabeceras estándar `X-RateLimit-*` y `Retry-After` ante respuestas HTTP 429.
 * @param {{ windowMs?: number, max?: number, keyPrefix?: string, message?: string }} [options]
 * @returns {import('express').RequestHandler}
 */
const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  max = 20,
  keyPrefix = 'rl',
  message = 'Demasiados intentos. Esperá unos minutos antes de volver a intentar.',
} = {}) => {
  // Almacén en memoria: Map<clave, { count: number, resetAt: number }>
  const hits = new Map();

  // Limpieza periódica de entradas vencidas (con unref() para no impedir el apagado limpio de Node)
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }, Math.min(windowMs, 5 * 60 * 1000));
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return (req, res, next) => {
    // Permite ajustar el límite sin cambiar código mediante variable de entorno
    const overrideMax = Number(process.env.RATE_LIMIT_MAX_OVERRIDE || 0);
    const effectiveMax = overrideMax > 0 ? overrideMax : max;

    // Resuelve la IP real priorizando el primer salto de X-Forwarded-For
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIp = forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${clientIp}`;
    const now = Date.now();

    // Inicializa o reinicia la ventana de conteo si expiró
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, effectiveMax - entry.count);
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    // Expone metadatos de cuota en las cabeceras de respuesta
    res.setHeader('X-RateLimit-Limit', String(effectiveMax));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > effectiveMax) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: message,
        retry_after_seconds: retryAfterSec,
      });
    }

    return next();
  };
};

module.exports = {
  securityHeaders,
  createRateLimiter,
};
