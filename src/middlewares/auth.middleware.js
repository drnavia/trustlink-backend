/**
 * @file auth.middleware.js
 * @description Middleware para la verificación de tokens JWT y control de acceso basado en roles (RBAC).
 * @location /trustlink-backend/src/middlewares/auth.middleware.js
 */

const jwt = require('jsonwebtoken');

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

module.exports = {
  verifyToken,
  verifyRole
};