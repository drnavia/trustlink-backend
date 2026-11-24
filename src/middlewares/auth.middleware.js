/**
 * @file auth.middleware.js
 * @description Middlewares de autenticación JWT y control de acceso basado en roles (RBAC)
 * y capacidades de identidad dual (Portal Residente / Portal Prestador).
 * @location /trustlink-backend/src/middlewares/auth.middleware.js
 */

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ensureEvolutionSchema } = require('../config/ensureEvolutionSchema');

/**
 * Middleware de autenticación JWT.
 * Valida la cabecera `Authorization: Bearer <token>`, verifica su firma con `JWT_SECRET`
 * e inyecta el payload decodificado en `req.user`.
 * Responde 401 si falta el token y 403 si es inválido o expiró.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
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
 * Fábrica de middleware RBAC estricto.
 * Restringe el acceso a la ruta únicamente a los roles incluidos en `allowedRoles`.
 * Debe ejecutarse siempre después de `verifyToken`.
 * @param {Array<string>} allowedRoles - Lista de roles permitidos (ej. `['superadmin']`).
 * @returns {import('express').RequestHandler}
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

// Roles administrativos/operativos que se autorizan por rol sin requerir banderas de portal dual
const PRIVILEGED_ROLES = new Set(['superadmin', 'admin', 'security']);

/**
 * Fábrica de middleware de autorización híbrida (rol privilegiado o capacidad de portal dual).
 * Permite el acceso si:
 * - El usuario tiene un rol privilegiado autorizado en `allowedRoles` (ej. `superadmin`/`admin`/`security`), O
 * - Es un usuario estándar (`owner`/`family`/`resident`/`provider`) cuya cuenta activa tiene habilitada
 *   en PostgreSQL la capacidad del portal correspondiente (`can_use_resident` o `can_use_provider`).
 *
 * Al consultar el estado vigente en DB, si un prestador desactiva el Portal Prestador para operar
 * solo como residente (o viceversa), pierde acceso de inmediato sin esperar a que expire su JWT.
 *
 * @param {Array<string>} allowedRoles - Roles privilegiados o estándar contemplados para la ruta.
 * @param {'resident'|'provider'} portal - Portal funcional requerido por el endpoint.
 * @returns {import('express').RequestHandler}
 */
const verifyRoleOrPortal = (allowedRoles, portal) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    // Paso 1: Vía rápida para roles privilegiados autorizados directamente en el JWT
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

    // Paso 2: Verificación en vivo contra PostgreSQL de cuenta activa y bandera del portal solicitado
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