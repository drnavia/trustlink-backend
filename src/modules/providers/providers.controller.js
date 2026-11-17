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
            criminal_record_url = COALESCE(NULLIF($2, ''), criminal_record_url),
            insurance_policy_url = COALESCE(NULLIF($3, ''), insurance_policy_url),
            status = 'pending'
        WHERE user_id = $4
        RETURNING id, specialty, status, rating_avg, created_at;
      `;
      providerResult = await db.query(updateQuery, [specialty, criminal_record_url, insurance_policy_url, userId]);
    } else {
      const insertQuery = `
        INSERT INTO providers (user_id, specialty, criminal_record_url, insurance_policy_url, status)
        VALUES ($1, $2, $3, $4, 'pending')
        RETURNING id, specialty, status, rating_avg, created_at;
      `;
      providerResult = await db.query(insertQuery, [userId, specialty, criminal_record_url || null, insurance_policy_url || null]);
    }

    return res.status(200).json({
      message: 'Perfil de prestador actualizado con éxito. En revisión por TrustLink Ops.',
      provider: providerResult.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el perfil.' });
  }
};

/**
 * Registra un vehículo asociado al prestador autenticado.
 */
const addVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { brand, model, plate, color } = req.body;

    if (!brand || !model || !plate) {
      return res.status(400).json({ error: 'Marca, modelo y patente son obligatorios para registrar el vehículo.' });
    }

    const providerRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    if (providerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Debe registrar su perfil profesional antes de asociar vehículos.' });
    }
    const providerId = providerRes.rows[0].id;

    const vehicleQuery = `
      INSERT INTO provider_vehicles (provider_id, brand, model, plate, color)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, brand, model, plate, color, created_at;
    `;
    const vehicleRes = await db.query(vehicleQuery, [providerId, brand, model, plate.toUpperCase(), color]);

    return res.status(201).json({
      message: 'Vehículo registrado exitosamente.',
      vehicle: vehicleRes.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar vehículo:', error);
    return res.status(500).json({ error: 'Error interno del servidor al registrar el vehículo.' });
  }
};

/**
 * Obtiene el perfil de compliance y los vehículos asociados del prestador logueado.
 */
const getMyProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;

    const providerQuery = `
      SELECT p.id, p.specialty, p.criminal_record_url, p.insurance_policy_url, p.status, p.rating_avg, p.created_at,
             u.first_name, u.last_name, u.email, u.phone
      FROM users u
      LEFT JOIN providers p ON u.id = p.user_id
      WHERE u.id = $1;
    `;
    const providerRes = await db.query(providerQuery, [userId]);

    if (providerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const providerData = providerRes.rows[0];
    let vehicles = [];

    if (providerData.id) {
      const vehiclesRes = await db.query('SELECT id, brand, model, plate, color FROM provider_vehicles WHERE provider_id = $1', [providerData.id]);
      vehicles = vehiclesRes.rows;
    }

    return res.status(200).json({
      provider: providerData,
      vehicles: vehicles
    });
  } catch (error) {
    console.error('Error al obtener perfil del prestador:', error);
    return res.status(500).json({ error: 'Error interno al obtener el perfil.' });
  }
};

/**
 * Lista todos los prestadores para Ops TrustLink (incluyendo usuarios con rol 'provider' sin perfil aún).
 */
const listAllProvidersForOps = async (req, res) => {
  try {
    const query = `
      SELECT u.id as user_id, u.first_name, u.last_name, u.email, u.dni, u.phone,
             p.id as provider_id, p.specialty, p.criminal_record_url, p.insurance_policy_url, 
             COALESCE(p.status::text, 'sin_perfil') as status, p.rating_avg, p.created_at
      FROM users u
      LEFT JOIN providers p ON u.id = p.user_id
      WHERE u.role = 'provider'
      ORDER BY u.created_at DESC;
    `;
    const result = await db.query(query);
    return res.status(200).json({
      count: result.rows.length,
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al listar prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno al obtener los prestadores.' });
  }
};

/**
 * Actualiza el estado de compliance de un prestador (approved, rejected, pending).
 */
const updateComplianceStatus = async (req, res) => {
  try {
    const { provider_id, user_id, status } = req.body;
    
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    let targetProviderId = provider_id;

    if (!targetProviderId && user_id) {
      const checkProv = await db.query('SELECT id FROM providers WHERE user_id = $1', [user_id]);
      if (checkProv.rows.length === 0) {
        const createProv = await db.query(`
          INSERT INTO providers (user_id, specialty, status)
          VALUES ($1, 'General / Sin Especificar', $2)
          RETURNING id;
        `, [user_id, status]);
        targetProviderId = createProv.rows[0].id;
      } else {
        targetProviderId = checkProv.rows[0].id;
      }
    }

    const updateQuery = `
      UPDATE providers
      SET status = $1
      WHERE id = $2
      RETURNING id, user_id, specialty, status;
    `;
    const result = await db.query(updateQuery, [status, targetProviderId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado en la base de datos.' });
    }

    return res.status(200).json({
      message: `Compliance actualizado exitosamente a: ${status}`,
      provider: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar compliance:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el compliance.' });
  }
};

/**
 * Lista únicamente los prestadores aprobados para el directorio de residentes.
 */
const listVerifiedProviders = async (req, res) => {
  try {
    const query = `
      SELECT p.id, p.specialty, p.criminal_record_url, p.insurance_policy_url, p.rating_avg,
             u.first_name, u.last_name, u.email, u.phone
      FROM providers p
      JOIN users u ON p.user_id = u.id
      WHERE p.status = 'approved'
      ORDER BY p.rating_avg DESC;
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
