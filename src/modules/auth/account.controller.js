/**
 * @file account.controller.js
 * @description Controlador para gestión de "Mi Cuenta / Mi Perfil", ubicación residencial normalizada
 * (Manzana / Fracción / N/A + número, y Lote solo número) y cambio de Portal Principal
 * ('resident' | 'provider') manteniendo compatibilidad total con la sesión JWT existente.
 * @location /trustlink-backend/src/modules/auth/account.controller.js
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/db');
const { ensureEvolutionSchema } = require('../../config/ensureEvolutionSchema');

// Conjunto de roles estándar cuyo rol operativo se sincroniza automáticamente con el Portal Principal
const STANDARD_USER_ROLES = new Set(['owner', 'family', 'resident', 'provider']);

/**
 * Emite un nuevo token JWT de sesión (vigencia 8 horas) a partir de una fila actualizada de `users`.
 * Se utiliza al cambiar comunidad, perfil o portal principal para que el frontend refleje
 * inmediatamente el nuevo `role` y `countryId` sin exigir relogueo.
 *
 * @param {{ id: number, country_id: number|null, role: string, email: string }} userRow - Registro del usuario.
 * @returns {string|null} Token JWT firmado o `null` si `JWT_SECRET` no está configurado.
 */
function signSessionToken(userRow) {
  if (!process.env.JWT_SECRET) return null;
  return jwt.sign(
    {
      userId: userRow.id,
      countryId: userRow.country_id,
      role: userRow.role,
      email: userRow.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

/**
 * Calcula el rol efectivo sincronizado al cambiar el Portal Principal (`'resident'` | `'provider'`).
 * Regla de negocio:
 *  - Los roles privilegiados (`admin`, `superadmin`, `security`) nunca se modifican.
 *  - Si el portal elegido es `'provider'`, el rol pasa a `'provider'`.
 *  - Si el portal elegido es `'resident'`, conserva `'family'` si ya era familiar o asigna `'owner'`.
 *
 * @param {string} currentRole - Rol actual persistido en `users`.
 * @param {'resident'|'provider'} nextPrimaryPortal - Portal principal objetivo.
 * @returns {string} Rol resultante a guardar en base de datos.
 */
function resolveSyncedRole(currentRole, nextPrimaryPortal) {
  const normalized = String(currentRole || '').toLowerCase();
  if (!STANDARD_USER_ROLES.has(normalized)) {
    return currentRole; // Nunca altera roles privilegiados (admin, superadmin, security)
  }
  if (nextPrimaryPortal === 'provider') {
    return 'provider';
  }
  return normalized === 'family' ? 'family' : 'owner';
}

/**
 * Normaliza y valida la ubicación residencial del usuario.
 * Reglas:
 *  - `fractionType`: `'manzana'` | `'fraccion'` | `'na'`
 *  - Si `fractionType` es `'manzana'` o `'fraccion'`: `fractionNumber` es obligatorio y debe ser numérico
 *    (solo dígitos, sin textos ni símbolos).
 *  - Si `fractionType` es `'na'`: `fractionNumber` queda en `null`.
 *  - `lotNumber`: cuando se envía o se exige para residente (`requireLocation = true`),
 *    debe ser únicamente numérico (ej. `"14"`, `"102"`).
 *
 * @param {{ fractionType?: string, fractionNumber?: string|number|null, lotNumber?: string|number|null }} input - Datos crudos de ubicación.
 * @param {boolean} [requireLocation=false] - Si es `true`, exige obligatoriamente `lotNumber`.
 * @returns {{ fractionType?: string, fractionNumber?: string|null, lotNumber?: string|null, error?: string }}
 */
function normalizeLocationInput({ fractionType, fractionNumber, lotNumber }, requireLocation = false) {
  // 1. Validar tipo de área permitido ('manzana', 'fraccion' o 'na')
  const normalizedType = String(fractionType || 'na').trim().toLowerCase();
  if (!['manzana', 'fraccion', 'na'].includes(normalizedType)) {
    return {
      error: 'Tipo de Manzana/Fracción inválido. Use "manzana", "fraccion" o "na".',
    };
  }

  // 2. Validar número de Manzana/Fracción (obligatorio y solo dígitos cuando el tipo no es 'na')
  const rawFractionNum =
    fractionNumber === undefined || fractionNumber === null
      ? ''
      : String(fractionNumber).trim();

  let cleanFractionNumber = null;
  if (normalizedType === 'manzana' || normalizedType === 'fraccion') {
    if (!rawFractionNum) {
      return {
        error: `Debe ingresar el número de ${normalizedType === 'manzana' ? 'Manzana' : 'Fracción'}.`,
      };
    }
    if (!/^\d+$/.test(rawFractionNum)) {
      return {
        error: `El número de ${normalizedType === 'manzana' ? 'Manzana' : 'Fracción'} debe contener solo dígitos numéricos.`,
      };
    }
    cleanFractionNumber = rawFractionNum;
  }

  // 3. Validar número de Lote (solo dígitos; obligatorio si el usuario opera con Portal Residente)
  const rawLotNum =
    lotNumber === undefined || lotNumber === null ? '' : String(lotNumber).trim();

  let cleanLotNumber = null;
  if (rawLotNum) {
    if (!/^\d+$/.test(rawLotNum)) {
      return {
        error: 'El Lote debe contener únicamente el número de lote (solo dígitos numéricos).',
      };
    }
    cleanLotNumber = rawLotNum;
  } else if (requireLocation) {
    return {
      error: 'Debe ingresar el número de Lote (solo dígitos numéricos).',
    };
  }

  return {
    fractionType: normalizedType,
    fractionNumber: cleanFractionNumber,
    lotNumber: cleanLotNumber,
  };
}

/**
 * Obtiene los datos de cuenta, perfil, capacidades de portal, ubicación residencial
 * y catálogo de comunidades activas del usuario autenticado.
 * GET /api/v1/account/me
 *
 * @param {import('express').Request} req - Petición HTTP con sesión JWT en `req.user`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ account, countries }`.
 * @returns {Promise<import('express').Response>}
 */
async function getMyAccount(req, res) {
  try {
    // 1. Asegurar esquema evolutivo y verificar identificador del usuario autenticado
    await ensureEvolutionSchema();
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    // 2. Consultar perfil completo del usuario con defaults seguros de portal/ubicación y nombre de comunidad
    const result = await db.query(
      `SELECT
         u.id,
         u.first_name,
         u.last_name,
         u.dni,
         u.email,
         u.phone,
         u.role,
         u.country_id,
         u.is_active,
         COALESCE(u.primary_portal, CASE WHEN LOWER(u.role::text) = 'provider' THEN 'provider' ELSE 'resident' END) AS primary_portal,
         COALESCE(u.can_use_resident, FALSE) AS can_use_resident,
         COALESCE(u.can_use_provider, FALSE) AS can_use_provider,
         COALESCE(u.fraction_type, 'na') AS fraction_type,
         u.fraction_number,
         u.lot_number,
         c.name AS country_name
       FROM users u
       LEFT JOIN countries c ON c.id = u.country_id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cuenta de usuario no encontrada.' });
    }

    // 3. Consultar comunidades activas para el selector de cambio de barrio en "Mi Perfil"
    const countriesRes = await db.query(
      `SELECT id, name
       FROM countries
       WHERE is_active = TRUE
       ORDER BY id ASC`
    );

    return res.json({
      account: result.rows[0],
      countries: countriesRes.rows,
    });
  } catch (err) {
    console.error('[account.controller] Error en getMyAccount:', err);
    return res.status(500).json({ error: 'Error al obtener los datos de la cuenta.' });
  }
}

/**
 * Actualiza datos de perfil, comunidad y ubicación residencial del usuario autenticado.
 * También permite habilitar/deshabilitar acceso al portal de residente (exigiendo ubicación
 * residencial completa) o al portal de prestador, sincronizando `primary_portal`, `role`
 * y emitiendo un nuevo JWT de sesión.
 * PATCH /api/v1/account/profile
 *
 * @param {import('express').Request} req - Petición HTTP con los campos editables en `req.body`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ message, token?, account }`.
 * @returns {Promise<import('express').Response>}
 */
async function updateMyProfile(req, res) {
  try {
    // 1. Asegurar esquema y verificar usuario autenticado
    await ensureEvolutionSchema();
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    const {
      first_name,
      last_name,
      phone,
      country_id,
      fraction_type,
      fraction_number,
      lot_number,
      activate_resident_portal,
      activate_provider_portal,
    } = req.body || {};

    // 2. Cargar estado actual del usuario para combinar actualizaciones parciales de forma segura
    const currentRes = await db.query(
      `SELECT
         id, first_name, last_name, email, phone, country_id, role,
         COALESCE(primary_portal, CASE WHEN LOWER(role::text) = 'provider' THEN 'provider' ELSE 'resident' END) AS primary_portal,
         COALESCE(can_use_resident, FALSE) AS can_use_resident,
         COALESCE(can_use_provider, FALSE) AS can_use_provider,
         COALESCE(fraction_type, 'na') AS fraction_type,
         fraction_number,
         lot_number
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const current = currentRes.rows[0];
    const currentRoleLower = String(current.role || '').toLowerCase();
    const isStandardUser = STANDARD_USER_ROLES.has(currentRoleLower);

    // 3. Sanitizar datos personales y validar obligatoriedad de nombre y apellido
    const cleanFirstName =
      first_name !== undefined ? String(first_name).trim() : current.first_name;
    const cleanLastName =
      last_name !== undefined ? String(last_name).trim() : current.last_name;
    const cleanPhone = phone !== undefined ? String(phone).trim() : current.phone;
    const cleanCountryId =
      country_id !== undefined && country_id !== '' ? Number(country_id) : current.country_id;

    if (!cleanFirstName || !cleanLastName) {
      return res.status(400).json({ error: 'Nombre y apellido son obligatorios.' });
    }

    // 4. Resolver habilitación de portales: todo usuario estándar debe mantener al menos un portal activo
    const nextCanResident =
      activate_resident_portal !== undefined
        ? Boolean(activate_resident_portal)
        : Boolean(current.can_use_resident);

    const nextCanProvider =
      activate_provider_portal !== undefined
        ? Boolean(activate_provider_portal)
        : Boolean(current.can_use_provider);

    if (isStandardUser && !nextCanResident && !nextCanProvider) {
      return res.status(400).json({
        error: 'Tu cuenta debe mantener al menos un portal operativo habilitado (Residente o Prestador).',
      });
    }

    // 5. Reajustar portal principal coherente con los portales activos y sincronizar rol estándar
    let nextPrimaryPortal = String(current.primary_portal || 'resident').toLowerCase();
    if (nextCanResident && !nextCanProvider) {
      nextPrimaryPortal = 'resident';
    } else if (!nextCanResident && nextCanProvider) {
      nextPrimaryPortal = 'provider';
    } else if (!['resident', 'provider'].includes(nextPrimaryPortal)) {
      nextPrimaryPortal = nextCanProvider && !nextCanResident ? 'provider' : 'resident';
    }

    const nextRole = resolveSyncedRole(current.role, nextPrimaryPortal);

    // 6. Validar y normalizar ubicación residencial (obligatoria cuando el Portal Residente queda habilitado)
    const locValidation = normalizeLocationInput(
      {
        fractionType: fraction_type !== undefined ? fraction_type : current.fraction_type,
        fractionNumber:
          fraction_number !== undefined ? fraction_number : current.fraction_number,
        lotNumber: lot_number !== undefined ? lot_number : current.lot_number,
      },
      nextCanResident
    );

    if (locValidation.error) {
      return res.status(400).json({ error: locValidation.error });
    }

    // 7. Persistir cambios en `users` y marcar la configuración de portales como completada
    const updated = await db.query(
      `UPDATE users
       SET
         first_name = $1,
         last_name = $2,
         phone = $3,
         country_id = $4,
         fraction_type = $5,
         fraction_number = $6,
         lot_number = $7,
         can_use_resident = $8,
         can_use_provider = $9,
         primary_portal = $10,
         role = $11,
         portals_configured = TRUE
       WHERE id = $12
       RETURNING
         id, first_name, last_name, dni, email, phone, role, country_id, is_active,
         primary_portal, can_use_resident, can_use_provider,
         fraction_type, fraction_number, lot_number`,
      [
        cleanFirstName,
        cleanLastName,
        cleanPhone || null,
        cleanCountryId || null,
        locValidation.fractionType,
        locValidation.fractionNumber,
        locValidation.lotNumber,
        nextCanResident,
        nextCanProvider,
        nextPrimaryPortal,
        nextRole,
        userId,
      ]
    );

    // 8. Resolver nombre de comunidad actualizada y emitir JWT refrescado con los nuevos claims
    const updatedRow = updated.rows[0];
    let countryName = null;
    if (updatedRow.country_id) {
      const cRes = await db.query('SELECT name FROM countries WHERE id = $1 LIMIT 1', [
        updatedRow.country_id,
      ]);
      countryName = cRes.rows[0]?.name || null;
    }

    const refreshedToken = signSessionToken(updatedRow);

    return res.json({
      message: 'Perfil, rol por defecto y ubicación actualizados correctamente.',
      ...(refreshedToken ? { token: refreshedToken } : {}),
      account: {
        ...updatedRow,
        country_name: countryName,
      },
    });
  } catch (err) {
    console.error('[account.controller] Error en updateMyProfile:', err);
    return res.status(500).json({ error: 'No se pudo actualizar el perfil.' });
  }
}

/**
 * Permite al usuario configurar cuál es su Portal Principal (`'resident'` | `'provider'`).
 * Si selecciona `'resident'`, exige que ya tenga habilitado `can_use_resident` (datos de lote completos).
 * Si selecciona `'provider'`, habilita automáticamente `can_use_provider`, sincroniza el rol
 * y devuelve un JWT actualizado.
 * PATCH /api/v1/account/primary-portal
 *
 * @param {import('express').Request} req - Petición HTTP con `{ primary_portal }`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ message, token?, account }`.
 * @returns {Promise<import('express').Response>}
 */
async function updatePrimaryPortal(req, res) {
  try {
    // 1. Asegurar esquema, validar sesión y verificar valor permitido del portal destino
    await ensureEvolutionSchema();
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    const portal = String(req.body?.primary_portal || '').trim().toLowerCase();
    if (!['resident', 'provider'].includes(portal)) {
      return res.status(400).json({
        error: 'El portal principal debe ser "resident" o "provider".',
      });
    }

    // 2. Consultar permisos actuales de portales del usuario en base de datos
    const userRes = await db.query(
      `SELECT
         id, role, email, country_id, lot_number,
         COALESCE(can_use_resident, FALSE) AS can_use_resident,
         COALESCE(can_use_provider, FALSE) AS can_use_provider
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const u = userRes.rows[0];
    // Regla de negocio: pasar a Portal Residente requiere haber completado previamente los datos residenciales
    if (portal === 'resident' && !u.can_use_resident) {
      return res.status(400).json({
        error: 'Complete primero sus datos de residente (Manzana/Fracción y Lote) para habilitar el Portal Residente.',
      });
    }

    // 3. Activar bandera de prestador si corresponde, sincronizar rol y persistir cambio
    const nextCanProvider = portal === 'provider' ? true : Boolean(u.can_use_provider);
    const nextRole = resolveSyncedRole(u.role, portal);

    const resUpdate = await db.query(
      `UPDATE users
       SET
         primary_portal = $1,
         can_use_provider = $2,
         role = $3,
         portals_configured = TRUE
       WHERE id = $4
       RETURNING
         id, first_name, last_name, dni, email, phone, role, country_id, is_active,
         primary_portal, can_use_resident, can_use_provider,
         fraction_type, fraction_number, lot_number`,
      [portal, nextCanProvider, nextRole, userId]
    );

    // 4. Emitir JWT renovado con el rol sincronizado para mantener coherencia de sesión
    const updatedRow = resUpdate.rows[0];
    const refreshedToken = signSessionToken(updatedRow);

    return res.json({
      message: `Rol y portal principal actualizado a ${portal === 'resident' ? 'Residente' : 'Prestador'}.`,
      ...(refreshedToken ? { token: refreshedToken } : {}),
      account: updatedRow,
    });
  } catch (err) {
    console.error('[account.controller] Error en updatePrimaryPortal:', err);
    return res.status(500).json({ error: 'No se pudo actualizar el portal principal.' });
  }
}

/**
 * Permite al usuario autenticado cambiar su contraseña validando primero su contraseña actual.
 * Exige una longitud mínima de 6 caracteres y que la nueva clave difiera de la actual.
 * PATCH /api/v1/account/password
 *
 * @param {import('express').Request} req - Petición HTTP con `{ current_password, new_password }`.
 * @param {import('express').Response} res - Respuesta HTTP confirmando la actualización.
 * @returns {Promise<import('express').Response>}
 */
async function changeMyPassword(req, res) {
  try {
    // 1. Verificar autenticación y validar reglas básicas del payload de contraseñas
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({
        error: 'Debe ingresar su contraseña actual y la nueva contraseña.',
      });
    }

    if (String(new_password).length < 6) {
      return res.status(400).json({
        error: 'La nueva contraseña debe tener al menos 6 caracteres.',
      });
    }

    if (String(current_password) === String(new_password)) {
      return res.status(400).json({
        error: 'La nueva contraseña debe ser diferente a la actual.',
      });
    }

    // 2. Recuperar hash vigente de la cuenta activa y validar la contraseña actual con bcrypt
    const userRes = await db.query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1',
      [userId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Cuenta de usuario no encontrada.' });
    }

    const validCurrent = await bcrypt.compare(
      String(current_password),
      userRes.rows[0].password_hash
    );
    if (!validCurrent) {
      return res.status(401).json({ error: 'La contraseña actual ingresada es incorrecta.' });
    }

    // 3. Generar nuevo hash bcrypt (costo 10) y persistirlo en `users.password_hash`
    const salt = await bcrypt.genSalt(10);
    const nextHash = await bcrypt.hash(String(new_password), salt);

    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [nextHash, userId]);

    return res.status(200).json({
      message: 'Contraseña actualizada correctamente.',
    });
  } catch (err) {
    console.error('[account.controller] Error en changeMyPassword:', err);
    return res.status(500).json({ error: 'No se pudo actualizar la contraseña.' });
  }
}

module.exports = {
  normalizeLocationInput,
  getMyAccount,
  updateMyProfile,
  updatePrimaryPortal,
  changeMyPassword,
};