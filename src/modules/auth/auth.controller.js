/**
 * @file auth.controller.js
 * @description Lógica de negocio para autenticación, registro, listado y actualización de cuentas privilegiadas (Ops Master).
 * @location /trustlink-backend/src/modules/auth/auth.controller.js
 */
const crypto = require('crypto');
const db = require('../../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  ensureEvolutionSchema,
  normalizeAreaType,
  getDefaultPrimaryPortal,
} = require('../../config/ensureEvolutionSchema');

const PUBLIC_ALLOWED_ROLES = ['owner', 'family', 'provider'];
const PRIVILEGED_ALLOWED_ROLES = ['admin', 'superadmin', 'security'];

const ensurePasswordResetTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(128) NOT NULL UNIQUE,
      expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      used_at TIMESTAMP WITHOUT TIME ZONE NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

const listPublicCountries = async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name
       FROM countries
       WHERE is_active = TRUE
       ORDER BY id ASC`
    );
    return res.status(200).json({ countries: result.rows });
  } catch (error) {
    console.error('Error al listar comunidades públicas:', error);
    return res.status(500).json({ error: 'Error interno al consultar comunidades activas.' });
  }
};

const register = async (req, res) => {
  try {
    await ensureEvolutionSchema();

    const {
      country_id,
      role,
      first_name,
      last_name,
      dni,
      email,
      password,
      phone,
      fraction_type,
      fraction_number,
      fraction,
      lot_number,
      driver_license_url,
    } = req.body;

    if (!role || !first_name || !last_name || !dni || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios para el registro.' });
    }

    const normalizedRole = String(role).trim().toLowerCase();
    if (!PUBLIC_ALLOWED_ROLES.includes(normalizedRole)) {
      return res.status(403).json({
        error: 'El rol solicitado no está habilitado para registro público.',
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanDni = String(dni).trim();

    const userExists = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR dni = $2', [
      cleanEmail,
      cleanDni,
    ]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario registrado con ese correo electrónico o DNI.' });
    }

    const resolvedFractionNumber =
      fraction_number !== undefined && fraction_number !== null && String(fraction_number).trim() !== ''
        ? String(fraction_number).trim()
        : fraction !== undefined && fraction !== null && String(fraction).trim() !== ''
        ? String(fraction).trim()
        : null;

    const resolvedFractionType = fraction_type
      ? normalizeAreaType(fraction_type)
      : resolvedFractionNumber
      ? /^mz|^manzana/i.test(resolvedFractionNumber)
        ? 'manzana'
        : 'fraccion'
      : 'na';

    const resolvedLotNumber =
      lot_number !== undefined && lot_number !== null && String(lot_number).trim() !== ''
        ? String(lot_number).trim()
        : null;

    const primaryPortal = getDefaultPrimaryPortal(normalizedRole);
    const canUseResident = ['owner', 'family', 'resident'].includes(normalizedRole);
    const canUseProvider = normalizedRole === 'provider';

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const query = `
      INSERT INTO users (
        country_id, role, first_name, last_name, dni, email, password_hash, phone,
        fraction_type, fraction_number, lot_number, driver_license_url,
        primary_portal, can_use_resident, can_use_provider, portals_configured
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      RETURNING id, country_id, role, first_name, last_name, dni, email, phone,
                fraction_type, fraction_number, lot_number,
                primary_portal, can_use_resident, can_use_provider,
                is_active, created_at;
    `;
    const values = [
      country_id || null,
      normalizedRole,
      String(first_name).trim(),
      String(last_name).trim(),
      cleanDni,
      cleanEmail,
      passwordHash,
      phone ? String(phone).trim() : null,
      resolvedFractionType,
      resolvedFractionNumber,
      resolvedLotNumber,
      driver_license_url || null,
      primaryPortal,
      canUseResident,
      canUseProvider,
    ];

    const newUser = await db.query(query, values);

    return res.status(201).json({
      message: 'Usuario registrado exitosamente en la base de datos.',
      user: newUser.rows[0]
    });
  } catch (error) {
    console.error('Error en el registro:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar el registro.' });
  }
};

const createPrivilegedUser = async (req, res) => {
  try {
    await ensureEvolutionSchema();

    const { country_id, role, first_name, last_name, dni, email, password, phone } = req.body;

    if (!role || !first_name || !last_name || !dni || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios para crear la cuenta privilegiada.' });
    }

    const normalizedRole = String(role).trim().toLowerCase();
    if (!PRIVILEGED_ALLOWED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: 'Rol privilegiado inválido (admin, superadmin o security).' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanDni = String(dni).trim();

    const userExists = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR dni = $2', [
      cleanEmail,
      cleanDni,
    ]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario registrado con ese correo electrónico o DNI.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const isSuper = normalizedRole === 'superadmin';
    const result = await db.query(
      `INSERT INTO users (
         country_id, role, first_name, last_name, dni, email, password_hash, phone,
         primary_portal, can_use_resident, can_use_provider, portals_configured
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'resident', $9, $10, TRUE)
       RETURNING id, country_id, role, first_name, last_name, dni, email, phone, is_active, created_at;`,
      [
        isSuper ? null : country_id || null,
        normalizedRole,
        String(first_name).trim(),
        String(last_name).trim(),
        cleanDni,
        cleanEmail,
        passwordHash,
        phone ? String(phone).trim() : null,
        isSuper,
        isSuper,
      ]
    );

    return res.status(201).json({
      message: 'Cuenta privilegiada creada correctamente.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Error al crear cuenta privilegiada:', error);
    return res.status(500).json({ error: 'Error interno del servidor al crear la cuenta privilegiada.' });
  }
};

const login = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [
      String(email || '').trim(),
    ]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'La cuenta se encuentra inactiva.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const tokenPayload = {
      userId: user.id,
      countryId: user.country_id,
      role: user.role,
      email: user.email
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '8h' });

    return res.status(200).json({
      message: 'Inicio de sesión exitoso.',
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        country_id: user.country_id,
        fraction_type: user.fraction_type || 'na',
        fraction_number: user.fraction_number || null,
        lot_number: user.lot_number || null,
        primary_portal: user.primary_portal || getDefaultPrimaryPortal(user.role),
        can_use_resident: Boolean(user.can_use_resident),
        can_use_provider: Boolean(user.can_use_provider),
      }
    });
  } catch (error) {
    console.error('Error en el login:', error);
    return res.status(500).json({ error: 'Error interno del servidor al iniciar sesión.' });
  }
};

const getPrivilegedUsers = async (req, res) => {
  try {
    const query = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.dni, u.role, u.country_id,
             c.name AS country_name, u.is_active, u.created_at
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE u.role IN ('superadmin', 'admin', 'security')
      ORDER BY u.created_at DESC;
    `;
    const result = await db.query(query);

    return res.status(200).json({
      count: result.rows.length,
      users: result.rows
    });
  } catch (error) {
    console.error('Error al obtener usuarios privilegiados:', error);
    return res.status(500).json({ error: 'Error interno del servidor al consultar usuarios.' });
  }
};

const updatePrivilegedUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, dni, password, role, country_id, is_active } = req.body;

    if (role !== undefined && !PRIVILEGED_ALLOWED_ROLES.includes(String(role).toLowerCase())) {
      return res.status(400).json({ error: 'Rol inválido (admin, superadmin o security).' });
    }

    const normalizedRole = role !== undefined ? String(role).toLowerCase() : null;
    const resolvedCountryId =
      normalizedRole === 'superadmin'
        ? null
        : country_id !== undefined && country_id !== ''
        ? Number(country_id)
        : undefined;

    let extraSet = '';
    const values = [first_name, last_name, email, dni, normalizedRole, is_active, id];

    if (resolvedCountryId !== undefined) {
      values.push(resolvedCountryId);
      extraSet += `, country_id = $${values.length}`;
    }

    if (password && password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      values.push(hashedPassword);
      extraSet += `, password_hash = $${values.length}`;
    }

    const query = `
      UPDATE users
      SET first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          email = COALESCE($3, email),
          dni = COALESCE($4, dni),
          role = COALESCE($5, role),
          is_active = COALESCE($6, is_active)
          ${extraSet}
      WHERE id = $7 AND role IN ('superadmin', 'admin', 'security')
      RETURNING id, first_name, last_name, email, dni, role, country_id, is_active, created_at;
    `;

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario privilegiado no encontrado.' });
    }

    return res.status(200).json({
      message: 'Usuario actualizado exitosamente.',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar usuario privilegiado:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el usuario.' });
  }
};

/**
 * Solicita recuperación de contraseña generando un token temporal (30 min) almacenado como hash SHA-256.
 * Nunca revela si el correo existe en la base (evita enumeración de cuentas).
 * POST /api/v1/auth/forgot-password
 */
const forgotPassword = async (req, res) => {
  try {
    await ensurePasswordResetTable();
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();

    if (!cleanEmail) {
      return res.status(400).json({ error: 'Ingresá tu correo electrónico para recuperar la cuenta.' });
    }

    const genericResponse = {
      message:
        'Si el correo corresponde a una cuenta activa, se generó un código de recuperación válido por 30 minutos.',
    };

    const userRes = await db.query(
      'SELECT id, email, is_active FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [cleanEmail]
    );

    if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
      return res.status(200).json(genericResponse);
    }

    const userId = userRes.rows[0].id;
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
      [userId]
    );

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
      [userId, tokenHash]
    );

    if (process.env.NODE_ENV !== 'production') {
      return res.status(200).json({
        ...genericResponse,
        dev_reset_token: rawToken,
      });
    }

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error('Error en forgotPassword:', error);
    return res.status(500).json({ error: 'Error interno al solicitar recuperación de contraseña.' });
  }
};

/**
 * Restablece la contraseña validando un token temporal vigente y no consumido.
 * POST /api/v1/auth/reset-password
 */
const resetPassword = async (req, res) => {
  try {
    await ensurePasswordResetTable();
    const rawToken = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.new_password || '');

    if (!rawToken || newPassword.length < 6) {
      return res.status(400).json({
        error: 'Debe ingresar el código de recuperación y una nueva contraseña de al menos 6 caracteres.',
      });
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const tokenRes = await db.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token_hash = $1
       LIMIT 1`,
      [tokenHash]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ error: 'El código de recuperación es inválido o expiró.' });
    }

    const record = tokenRes.rows[0];
    if (record.used_at || new Date(record.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'El código de recuperación ya fue utilizado o expiró.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, record.user_id]);
    await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);

    return res.status(200).json({
      message: 'Contraseña actualizada correctamente. Ya podés iniciar sesión.',
    });
  } catch (error) {
    console.error('Error en resetPassword:', error);
    return res.status(500).json({ error: 'Error interno al restablecer la contraseña.' });
  }
};

module.exports = {
  listPublicCountries,
  register,
  login,
  forgotPassword,
  resetPassword,
  createPrivilegedUser,
  getPrivilegedUsers,
  updatePrivilegedUser
};