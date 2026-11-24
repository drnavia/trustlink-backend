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

const PRIVILEGED_ROLES = new Set(['superadmin', 'admin', 'security']);

/**
 * Permite el acceso si:
 * - El usuario tiene un rol privilegiado autorizado en `allowedRoles` (ej. superadmin/admin/security), O
 * - Es un usuario estándar (owner/family/resident/provider) cuya cuenta activa tiene habilitada
 *   en PostgreSQL la capacidad del portal correspondiente (`can_use_resident` o `can_use_provider`).
 * De este modo, si un prestador desactiva el Portal Prestador para ser solo residente (o viceversa),
 * pierde acceso de inmediato a los endpoints del portal desactivado.
 * @param {Array<string>} allowedRoles
 * @param {'resident'|'provider'} portal
 */
const verifyRoleOrPortal = (allowedRoles, portal) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    const tokenRole = String(req.user.role || '').toLowerCase();
    if (PRIVILEGED_ROLES.has(tokenRole) && allowedRoles.includes(tokenRole)) {
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
        `SELECT role, ${col} AS allowed FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
        [userId]
      );

      const row = result.rows[0];
      if (!row) {
        return res.status(403).json({
          error: 'Cuenta inactiva o inexistente.',
        });
      }

      const dbRole = String(row.role || '').toLowerCase();
      if ((PRIVILEGED_ROLES.has(dbRole) && allowedRoles.includes(dbRole)) || row.allowed) {
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