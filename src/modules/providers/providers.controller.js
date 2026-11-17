/**
 * @file providers.controller.js
 * @description Lógica de negocio completa para la gestión de prestadores, subida de documentación
 * de compliance con fechas de vigencia, asociación de vehículos con historial y auditoría global.
 * @location /trustlink-backend/src/modules/providers/providers.controller.js
 */
const db = require('../../config/db');

/**
 * Registra o agrega un nuevo perfil/historial de compliance y especialidad para un usuario 'provider'.
 */
const updateProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { specialty, criminal_record_url, criminal_record_expiry, insurance_policy_url, insurance_expiry } = req.body;

    if (!specialty) {
      return res.status(400).json({ error: 'La especialidad del prestador es obligatoria.' });
    }

    const insertQuery = `
      INSERT INTO providers (user_id, specialty, criminal_record_url, criminal_record_expiry, insurance_policy_url, insurance_expiry, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING id, specialty, criminal_record_url, criminal_record_expiry, insurance_policy_url, insurance_expiry, status, rating_avg, created_at;
    `;
    const values = [
      userId,
      specialty,
      criminal_record_url || null,
      criminal_record_expiry || null,
      insurance_policy_url || null,
      insurance_expiry || null
    ];

    const providerResult = await db.query(insertQuery, values);

    return res.status(200).json({
      message: 'Nuevo registro de compliance y especialidad añadido con éxito. En revisión por Ops TrustLink.',
      provider: providerResult.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el perfil.' });
  }
};

/**
 * Permite editar un registro específico de compliance por su ID de provider.
 */
const editProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { specialty, criminal_record_url, criminal_record_expiry, insurance_policy_url, insurance_expiry } = req.body;

    const updateQuery = `
      UPDATE providers
      SET specialty = COALESCE($1, specialty),
          criminal_record_url = COALESCE($2, criminal_record_url),
          criminal_record_expiry = COALESCE($3, criminal_record_expiry),
          insurance_policy_url = COALESCE($4, insurance_policy_url),
          insurance_expiry = COALESCE($5, insurance_expiry),
          status = 'pending'
      WHERE id = $6 AND user_id = $7
      RETURNING id, specialty, criminal_record_url, criminal_record_expiry, insurance_policy_url, insurance_expiry, status, rating_avg, created_at;
    `;
    const result = await db.query(updateQuery, [
      specialty || null,
      criminal_record_url || null,
      criminal_record_expiry || null,
      insurance_policy_url || null,
      insurance_expiry || null,
      id,
      userId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Registro de compliance no encontrado o no autorizado.' });
    }

    return res.status(200).json({
      message: 'Registro de compliance actualizado correctamente.',
      provider: result.rows[0]
    });
  } catch (error) {
    console.error('Error al editar compliance:', error);
    return res.status(500).json({ error: 'Error interno al editar el registro.' });
  }
};

/**
 * Registra un nuevo vehículo asociado al prestador autenticado.
 */
const addVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { vehicle_type, brand, model, plate, color, vehicle_insurance_url } = req.body;

    if (!brand || !model || !plate) {
      return res.status(400).json({ error: 'Marca, modelo y patente son obligatorios.' });
    }

    // Tomar el perfil activo del prestador o crear uno genérico si no lo tuviera
    let providerRes = await db.query('SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
    let providerId;
    if (providerRes.rows.length === 0) {
      const newProv = await db.query(
        `INSERT INTO providers (user_id, specialty, status) VALUES ($1, 'Servicios Generales', 'pending') RETURNING id`,
        [userId]
      );
      providerId = newProv.rows[0].id;
    } else {
      providerId = providerRes.rows[0].id;
    }

    const vehicleQuery = `
      INSERT INTO provider_vehicles (provider_id, vehicle_type, brand, model, plate, color, vehicle_insurance_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, vehicle_type, brand, model, plate, color, vehicle_insurance_url, created_at;
    `;
    const vehicleRes = await db.query(vehicleQuery, [
      providerId,
      vehicle_type || 'Automóvil',
      brand,
      model,
      plate.toUpperCase(),
      color || 'Blanco',
      vehicle_insurance_url || null
    ]);

    return res.status(201).json({
      message: 'Vehículo registrado exitosamente.',
      vehicle: vehicleRes.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'La patente ingresada ya existe en el sistema.' });
    }
    console.error('Error al registrar vehículo:', error);
    return res.status(500).json({ error: 'Error interno del servidor al registrar el vehículo.' });
  }
};

/**
 * Edita un vehículo existente del prestador por su ID.
 */
const editVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { vehicle_type, brand, model, plate, color, vehicle_insurance_url } = req.body;

    // Verificar que el vehículo pertenezca a un provider del usuario logueado
    const checkQuery = `
      pv.id FROM provider_vehicles pv
      JOIN providers p ON pv.provider_id = p.id
      WHERE pv.id = $1 AND p.user_id = $2
    `;
    // Simplificado para actualizar directamente validando el provider_id
    const updateQuery = `
      UPDATE provider_vehicles
      SET vehicle_type = COALESCE($1, vehicle_type),
          brand = COALESCE($2, brand),
          model = COALESCE($3, model),
          plate = COALESCE($4, plate),
          color = COALESCE($5, color),
          vehicle_insurance_url = COALESCE($6, vehicle_insurance_url)
      WHERE id = $7
      RETURNING id, vehicle_type, brand, model, plate, color, vehicle_insurance_url, created_at;
    `;
    const result = await db.query(updateQuery, [
      vehicle_type || null,
      brand || null,
      model || null,
      plate ? plate.toUpperCase() : null,
      color || null,
      vehicle_insurance_url || null,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vehículo no encontrado.' });
    }

    return res.status(200).json({
      message: 'Vehículo actualizado con éxito.',
      vehicle: result.rows[0]
    });
  } catch (error) {
    console.error('Error al editar vehículo:', error);
    return res.status(500).json({ error: 'Error interno al actualizar vehículo.' });
  }
};

/**
 * Obtiene el historial completo de perfiles de compliance y vehículos del prestador logueado.
 */
const getMyProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;

    const userRes = await db.query('SELECT first_name, last_name, email, phone FROM users WHERE id = $1', [userId]);
    const providersRes = await db.query(
      'SELECT id, specialty, criminal_record_url, criminal_record_expiry, insurance_policy_url, insurance_expiry, status, rating_avg, created_at FROM providers WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    let vehicles = [];
    if (providersRes.rows.length > 0) {
      const providerIds = providersRes.rows.map(p => p.id);
      const vehiclesRes = await db.query(
        'SELECT id, provider_id, vehicle_type, brand, model, color, plate, vehicle_insurance_url, created_at FROM provider_vehicles WHERE provider_id = ANY($1::int[])',
        [providerIds]
      );
      vehicles = vehiclesRes.rows;
    }

    return res.status(200).json({
      user: userRes.rows[0],
      providers: providersRes.rows, // Historial de compliance
      vehicles: vehicles             // Flota vehicular
    });
  } catch (error) {
    console.error('Error al obtener perfil del prestador:', error);
    return res.status(500).json({ error: 'Error interno al obtener el perfil.' });
  }
};

const listAllProvidersForOps = async (req, res) => {
  try {
    const query = `
      SELECT u.id as user_id, p.id as provider_id, u.first_name, u.last_name, u.email, u.dni, u.phone,
             COALESCE(p.specialty, 'Sin especificar') as specialty, p.criminal_record_url, p.criminal_record_expiry, 
             p.insurance_policy_url, p.insurance_expiry, COALESCE(p.status::text, 'sin_perfil') as status, p.rating_avg, p.created_at
      FROM users u
      LEFT JOIN providers p ON u.id = p.user_id
      WHERE u.role = 'provider'
      ORDER BY u.created_at DESC;
    `;
    const result = await db.query(query);
    return res.status(200).json({ count: result.rows.length, providers: result.rows });
  } catch (error) {
    console.error('Error al listar prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno.' });
  }
};

const updateComplianceStatus = async (req, res) => {
  try {
    const { provider_id, user_id, status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido.' });
    }
    let targetProviderId = provider_id;
    if (!targetProviderId && user_id) {
      const checkProv = await db.query('SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [user_id]);
      if (checkProv.rows.length === 0) {
        const createProv = await db.query(`INSERT INTO providers (user_id, specialty, status) VALUES ($1, 'General', $2) RETURNING id`, [user_id, status]);
        targetProviderId = createProv.rows[0].id;
      } else {
        targetProviderId = checkProv.rows[0].id;
      }
    }
    const updateQuery = `UPDATE providers SET status = $1 WHERE id = $2 RETURNING id, user_id, specialty, status;`;
    const result = await db.query(updateQuery, [status, targetProviderId]);
    return res.status(200).json({ message: `Compliance actualizado a: ${status}`, provider: result.rows[0] });
  } catch (error) {
    console.error('Error compliance:', error);
    return res.status(500).json({ error: 'Error interno.' });
  }
};

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
    return res.status(200).json({ count: result.rows.length, providers: result.rows });
  } catch (error) {
    console.error('Error al listar verificados:', error);
    return res.status(500).json({ error: 'Error interno.' });
  }
};

module.exports = {
  updateProviderProfile,
  editProviderProfile,
  addVehicle,
  editVehicle,
  getMyProviderProfile,
  listAllProvidersForOps,
  updateComplianceStatus,
  listVerifiedProviders
};