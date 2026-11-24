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

const STANDARD_USER_ROLES = new Set(['owner', 'family', 'resident', 'provider']);

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
 *  - fractionType: 'manzana' | 'fraccion' | 'na'
 *  - Si fractionType es 'manzana' o 'fraccion': fractionNumber es obligatorio y debe ser numérico
 *    (solo número, sin textos ni símbolos).
 *  - Si fractionType es 'na': fractionNumber queda en null.
 *  - lotNumber: cuando se envía o se exige para residente, debe ser solo número (ej. "14", "102").
 */
function normalizeLocationInput({ fractionType, fractionNumber, lotNumber }, requireLocation = false) {
  const normalizedType = String(fractionType || 'na').trim().toLowerCase();
  if (!['manzana', 'fraccion', 'na'].includes(normalizedType)) {
    return {
      error: 'Tipo de Manzana/Fracción inválido. Use "manzana", "fraccion" o "na".',
    };
  }

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
 * Obtiene los datos de cuenta, perfil, capacidades de portal y ubicación del usuario autenticado.
 * GET /api/v1/account/me
 */
async function getMyAccount(req, res) {
  try {
    await ensureEvolutionSchema();
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }

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
 * Actualiza datos de perfil y ubicación residencial del usuario autenticado.
 * También permite activar el acceso al portal de residente (si completa su ubicación)
 * o al portal de prestador.
 * PATCH /api/v1/account/profile
 */
async function updateMyProfile(req, res) {
  try {
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

    let nextPrimaryPortal = String(current.primary_portal || 'resident').toLowerCase();
    if (nextCanResident && !nextCanProvider) {
      nextPrimaryPortal = 'resident';
    } else if (!nextCanResident && nextCanProvider) {
      nextPrimaryPortal = 'provider';
    } else if (!['resident', 'provider'].includes(nextPrimaryPortal)) {
      nextPrimaryPortal = nextCanProvider && !nextCanResident ? 'provider' : 'resident';
    }

    const nextRole = resolveSyncedRole(current.role, nextPrimaryPortal);

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
 * Permite al usuario configurar cuál es su Portal Principal ('resident' | 'provider').
 * PATCH /api/v1/account/primary-portal
 */
async function updatePrimaryPortal(req, res) {
  try {
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
    if (portal === 'resident' && !u.can_use_resident) {
      return res.status(400).json({
        error: 'Complete primero sus datos de residente (Manzana/Fracción y Lote) para habilitar el Portal Residente.',
      });
    }

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
 * Permite al usuario autenticado cambiar su contraseña validando su contraseña actual.
 * PATCH /api/v1/account/password
 */
async function changeMyPassword(req, res) {
  try {
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