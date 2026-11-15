/**
 * @file auth.controller.js
 * @description Lógica de negocio para el registro de nuevos usuarios (propietarios, prestadores, etc.)
 * y el inicio de sesión con emisión de tokens JWT.
 * @location /trustlink-backend/src/modules/auth/auth.controller.js
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/db');

/**
 * Registra un nuevo usuario en la base de datos de TrustLink.
 */
const register = async (req, res) => {
  try {
    const { 
      country_id, 
      role, 
      first_name, 
      last_name, 
      dni, 
      email, 
      password, 
      phone, 
      fraction_number, 
      lot_number,
      driver_license_url 
    } = req.body;

    // 1. Validar duplicidad por email o DNI
    const userExists = await db.query('SELECT id FROM users WHERE email = $1 OR dni = $2', [email, dni]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'El correo electrónico o el DNI ya se encuentran registrados.' });
    }

    // 2. Encriptar la contraseña con Bcrypt
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // 3. Insertar usuario en la base de datos
    const query = `
      INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone, fraction_number, lot_number, driver_license_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, country_id, role, first_name, last_name, email, created_at;
    `;
    
    const values = [
      country_id || null, 
      role || 'owner', 
      first_name, 
      last_name, 
      dni, 
      email, 
      password_hash, 
      phone || null, 
      fraction_number || null, 
      lot_number || null,
      driver_license_url || null
    ];

    const newUser = await db.query(query, values);

    return res.status(201).json({
      message: 'Usuario registrado exitosamente en TrustLink.',
      user: newUser.rows[0]
    });

  } catch (error) {
    console.error('Error en el registro:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar el registro.' });
  }
};

/**
 * Autentica al usuario y genera un token JWT.
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Buscar usuario por email
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];

    // 2. Validar si el usuario está activo
    if (!user.is_active) {
      return res.status(403).json({ error: 'La cuenta se encuentra inactiva.' });
    }

    // 3. Comparar contraseñas
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // 4. Generar token JWT con vigencia de 8 horas
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

module.exports = {
  register,
  login
};