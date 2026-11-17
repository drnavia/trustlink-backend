/**
 * @file auth.controller.js
 * @description Lógica de negocio para autenticación, registro, listado y actualización completa de usuarios privilegiados.
 * @location /trustlink-backend/src/modules/auth/auth.controller.js
 */
const db = require('../../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const register = async (req, res) => {
  try {
    const { country_id, role, first_name, last_name, dni, email, password, phone, fraction_number, lot_number } = req.body;

    if (!role || !first_name || !last_name || !dni || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios para el registro.' });
    }

    const userExists = await db.query('SELECT id FROM users WHERE email = $1 OR dni = $2', [email, dni]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario registrado con ese correo electrónico o DNI.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const query = `
      INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone, fraction_number, lot_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, country_id, role, first_name, last_name, dni, email, phone, is_active, created_at;
    `;
    const values = [
      country_id || null,
      role,
      first_name,
      last_name,
      dni,
      email,
      passwordHash,
      phone || null,
      fraction_number || null,
      lot_number || null
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

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
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
        role: user.role,
        country_id: user.country_id
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
      SELECT id, first_name, last_name, email, dni, role, is_active, created_at
      FROM users
      WHERE role IN ('superadmin', 'admin')
      ORDER BY created_at DESC;
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
    const { first_name, last_name, email, dni, password, role, is_active } = req.body;

    let passwordHashQuery = '';
    let values = [first_name, last_name, email, dni, role, is_active, id];

    if (password && password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      passwordHashQuery = ', password_hash = $8';
      values.push(hashedPassword);
    }

    const query = `
      UPDATE users
      SET first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          email = COALESCE($3, email),
          dni = COALESCE($4, dni),
          role = COALESCE($5, role),
          is_active = COALESCE($6, is_active)
          ${passwordHashQuery}
      WHERE id = $7 AND role IN ('superadmin', 'admin')
      RETURNING id, first_name, last_name, email, dni, role, is_active, created_at;
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

module.exports = {
  register,
  login,
  getPrivilegedUsers,
  updatePrivilegedUser
};