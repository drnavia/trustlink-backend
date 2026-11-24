/**
 * @file auth.middleware.js
 * @description Middleware para la verificación de tokens JWT y control de acceso basado en roles (RBAC).
 * @location /trustlink-backend/src/middlewares/auth.middleware.js
 */

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ensureEvolutionSchema } = require('../config/ensureEvolutionSchema');

/**
 * Valida si la petición incluye un token Bearer válido en los headers.
 */
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado o formato inválido.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Inyecta la carga útil del token en el objeto de la petición
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido o expirado.' });
  }
};

/**
 * Restringe el acceso a la ruta según los roles autorizados.
 * @param {Array<string>} allowedRoles - Lista de roles permitidos
 */
const verifyRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'No tienes los permisos necesarios para ejecutar esta acción.' 
      });
    }
    next();
  };
};

/**
 * Permite el acceso si el rol base está en `allowedRoles` O si el usuario tiene habilitada
 * la capacidad de portal correspondiente (`can_use_resident` o `can_use_provider`) en PostgreSQL.
 * @param {Array<string>} allowedRoles
 * @param {'resident'|'provider'} portal
 */
const verifyRoleOrPortal = (allowedRoles, portal) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    if (allowedRoles.includes(req.user.role)) {
      return next();
    }

    const userId = Number(req.user.userId || req.user.id);
    if (!userId || !['resident', 'provider'].includes(portal)) {
      return res.status(403).json({
        error: 'No tienes los permisos necesarios para ejecutar esta acción.',
      });
    }

    try {
      await ensureEvolutionSchema();
      const col = portal === 'provider' ? 'can_use_provider' : 'can_use_resident';
      const result = await db.query(
        `SELECT ${col} AS allowed FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
        [userId]
      );

      if (result.rows[0]?.allowed) {
        return next();
      }
    } catch (err) {
      console.error('[auth.middleware] Error verificando capacidad dual:', err.message);
    }

    return res.status(403).json({
      error: 'No tienes los permisos necesarios para ejecutar esta acción.',
    });
  };
};

module.exports = {
  verifyToken,
  verifyRole,
  verifyRoleOrPortal,
};