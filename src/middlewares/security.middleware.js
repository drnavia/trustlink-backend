/**
 * @file security.middleware.js
 * @description Middlewares de seguridad HTTP (cabeceras defensivas equivalentes a Helmet)
 * y limitación de tasa (rate limiting en memoria) para endpoints sensibles de autenticación.
 * @location /trustlink-backend/src/middlewares/security.middleware.js
 */

/**
 * Inyecta cabeceras HTTP defensivas estándar en todas las respuestas.
 */
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');

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
 * Crea un middleware de rate limiting por IP + clave de ruta.
 * @param {{ windowMs?: number, max?: number, keyPrefix?: string, message?: string }} options
 */
const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  max = 20,
  keyPrefix = 'rl',
  message = 'Demasiados intentos. Esperá unos minutos antes de volver a intentar.',
} = {}) => {
  const hits = new Map();

  // Limpieza periódica de entradas vencidas (sin bloquear el cierre del proceso)
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
    const overrideMax = Number(process.env.RATE_LIMIT_MAX_OVERRIDE || 0);
    const effectiveMax = overrideMax > 0 ? overrideMax : max;

    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIp = forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${clientIp}`;
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, effectiveMax - entry.count);
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

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
