/**
 * @file providers.controller.js
 * @description Lógica de negocio completa para la gestión de prestadores, subida de documentación
 * de compliance (antecedentes penales, seguros), asociación de vehículos y auditoría global por Ops TrustLink.
 * @location /trustlink-backend/src/modules/providers/providers.controller.js
 */
const db = require('../../config/db');

/**
 * Registra o actualiza la información de compliance y especialidad de un usuario con rol 'provider'.
 */
const updateProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { specialty, criminal_record_url, insurance_policy_url } = req.body;

    if (!specialty) {
      return res.status(400).json({ error: 'La especialidad del prestador es obligatoria.' });
    }

    const existingProvider = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    let providerResult;

    if (existingProvider.rows.length > 0) {
      const updateQuery = `
        UPDATE providers
        SET specialty = $1,
            criminal_record_url = COALESCE($2, criminal_record_url),
            insurance_policy_url = COALESCE($3, insurance_policy_url),
            status = 'pending'
        WHERE user_id = $4
        RETURNING id, specialty, status, rating_avg, created_at;
      `;
      providerResult = await db.query(updateQuery, [specialty, criminal_record_url || null, insurance_policy_url || null, userId]);
    } else {
      const insertQuery = `
        INSERT INTO providers (user_id, specialty, criminal_record_url, insurance_policy_url, status)
        VALUES ($1, $2, $3, $4, 'pending')
        RETURNING id, specialty, status, rating_avg, created_at;
      `;
      providerResult = await db.query(insertQuery, [userId, specialty, criminal_record_url || null, insurance_policy_url || null]);
    }

    return res.status(200).json({
      message: 'Perfil de compliance del prestador actualizado con éxito. Su estado actual es pendiente de aprobación.',
      provider: providerResult.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el perfil.' });
  }
};

/**
 * Agrega un vehículo a la flota del prestador para el control de patentes en garita.
 */
const addVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { brand, model, color, plate, vehicle_insurance_url } = req.body;

    if (!brand || !model || !color || !plate) {
      return res.status(400).json({ error: 'Faltan datos obligatorios del vehículo (marca, modelo, color, patente).' });
    }

    const providerRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    if (providerRes.rows.length === 0) {
      return res.status(404).json({ error: 'El usuario no tiene un perfil de prestador registrado.' });
    }
    const providerId = providerRes.rows[0].id;

    const insertQuery = `
      INSERT INTO provider_vehicles (provider_id, brand, model, color, plate, vehicle_insurance_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, brand, model, color, plate, vehicle_insurance_url, created_at;
    `;
    const values = [providerId, brand, model, color, plate, vehicle_insurance_url || null];
    const newVehicle = await db.query(insertQuery, values);

    return res.status(201).json({
      message: 'Vehículo registrado y asociado exitosamente.',
      vehicle: newVehicle.rows[0]
    });
  } catch (error) {
    console.error('Error al agregar vehículo:', error);
    return res.status(500).json({ error: 'Error interno del servidor al registrar el vehículo.' });
  }
};

/**
 * Lista TODOS los prestadores del sistema (partiendo de users con rol 'provider' y LEFT JOIN a providers)
 * para que Ops TrustLink muestre incluso a quienes aún no han completado su perfil.
 * Roles permitidos: 'superadmin'
 */
const listAllProvidersForOps = async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id AS user_id,
        p.id AS provider_id,
        u.first_name,
        u.last_name,
        u.dni,
        u.email,
        COALESCE(p.specialty, 'Sin especificar (Perfil Incompleto)') AS specialty,
        p.criminal_record_url,
        p.insurance_policy_url,
        COALESCE(p.status::text, 'sin_perfil') AS status,
        COALESCE(p.rating_avg, 0.00) AS rating_avg,
        COALESCE(p.created_at, u.created_at) AS created_at
      FROM users u
      LEFT JOIN providers p ON p.user_id = u.id
      WHERE u.role = 'provider'
      ORDER BY u.created_at DESC;
    `;
    const result = await db.query(query);

    return res.status(200).json({
      count: result.rows.length,
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al listar todos los prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno del servidor al consultar prestadores.' });
  }
};

/**
 * Actualiza el estado de compliance de un prestador. Si el usuario aún no tenía registro
 * en la tabla 'providers' (estado 'sin_perfil'), se crea automáticamente al interactuar.
 * Roles permitidos: 'superadmin'
 */
const updateComplianceStatus = async (req, res) => {
  try {
    const { provider_id, user_id, status } = req.body;

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    let targetProviderId = provider_id;

    if (!targetProviderId && user_id) {
      const existing = await db.query('SELECT id FROM providers WHERE user_id = $1', [user_id]);
      if (existing.rows.length > 0) {
        targetProviderId = existing.rows[0].id;
      } else {
        const newProv = await db.query(
          `INSERT INTO providers (user_id, specialty, status) VALUES ($1, 'Servicios Generales', $2) RETURNING id`,
          [user_id, status]
        );
        targetProviderId = newProv.rows[0].id;
      }
    }

    if (!targetProviderId) {
      return res.status(400).json({ error: 'Debe especificar un provider_id o user_id válido.' });
    }

    const updateQuery = `
      UPDATE providers
      SET status = $1
      WHERE id = $2
      RETURNING id, user_id, specialty, status;
    `;
    const result = await db.query(updateQuery, [status, targetProviderId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    return res.status(200).json({
      message: `El estado de compliance del prestador fue actualizado a: ${status}`,
      provider: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar compliance:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar la solicitud.' });
  }
};

/**
 * Obtiene el perfil de compliance y los vehículos asociados del prestador logueado.
 */
const getMyProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const providerRes = await db.query(
      `SELECT id, specialty, criminal_record_url, insurance_policy_url, status, rating_avg FROM providers WHERE user_id = $1`,
      [userId]
    );

    let provider = providerRes.rows[0] || null;
    let vehicles = [];

    if (provider) {
      const vehiclesRes = await db.query(
        `SELECT id, brand, model, color, plate, vehicle_insurance_url FROM provider_vehicles WHERE provider_id = $1`,
        [provider.id]
      );
      vehicles = vehiclesRes.rows;
    }

    return res.status(200).json({
      provider,
      vehicles
    });
  } catch (error) {
    console.error('Error al obtener perfil del prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

/**
 * Lista todos los prestadores aprobados dentro del country para el directorio del residente.
 */
const listVerifiedProviders = async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id AS provider_id,
        u.first_name,
        u.last_name,
        u.phone,
        u.email,
        p.specialty,
        p.rating_avg,
        p.status
      FROM providers p
      JOIN users u ON p.user_id = u.id
      WHERE p.status = 'approved';
    `;
    const result = await db.query(query);

    return res.status(200).json({
      count: result.rows.length,
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al listar prestadores verificados:', error);
    return res.status(500).json({ error: 'Error interno del servidor al obtener el directorio.' });
  }
};

module.exports = {
  updateProviderProfile,
  addVehicle,
  listAllProvidersForOps,
  updateComplianceStatus,
  getMyProviderProfile,
  listVerifiedProviders
};