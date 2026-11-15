/**
 * @file providers.controller.js
 * @description Lógica de negocio completa para la gestión de prestadores, subida de documentación
 * de compliance (antecedentes penales, seguros), asociación de vehículos y aprobación por parte de la administración.
 * @location /trustlink-backend/src/modules/providers/providers.controller.js
 */

const db = require('../../config/db');

/**
 * Registra o actualiza la información de compliance y especialidad de un usuario con rol 'provider'.
 * Roles permitidos: 'provider'
 */
const updateProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { specialty, criminal_record_url, insurance_policy_url } = req.body;

    if (!specialty) {
      return res.status(400).json({ error: 'La especialidad del prestador es obligatoria.' });
    }

    // 1. Verificar si ya existe un perfil de prestador para este usuario
    const existingProvider = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);

    let providerResult;

    if (existingProvider.rows.length > 0) {
      // Actualizar perfil existente y ponerlo en 'pending' nuevamente si cambia documentos críticos
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
      // Crear nuevo perfil de prestador
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
 * Roles permitidos: 'provider'
 */
const addVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { brand, model, color, plate, vehicle_insurance_url } = req.body;

    if (!brand || !model || !color || !plate) {
      return res.status(400).json({ error: 'Faltan datos obligatorios del vehículo (marca, modelo, color, patente).' });
    }

    // 1. Obtener el id del prestador asociado al usuario
    const providerQuery = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    if (providerQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Debe completar su perfil de prestador antes de registrar vehículos.' });
    }
    const providerId = providerQuery.rows.id;

    // 2. Insertar el vehículo
    const vehicleQuery = `
      INSERT INTO provider_vehicles (provider_id, brand, model, color, plate, vehicle_insurance_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, brand, model, color, plate, vehicle_insurance_url, created_at;
    `;

    const newVehicle = await db.query(vehicleQuery, [
      providerId, 
      brand, 
      model, 
      color, 
      plate.toUpperCase(), 
      vehicle_insurance_url || null
    ]);

    return res.status(201).json({
      message: 'Vehículo asociado exitosamente al prestador.',
      vehicle: newVehicle.rows[0]
    });

  } catch (error) {
    if (error.code === '23505') { // Violación de unicidad en patente
      return res.status(400).json({ error: 'La patente ingresada ya se encuentra registrada en el sistema.' });
    }
    console.error('Error al agregar vehículo:', error);
    return res.status(500).json({ error: 'Error interno del servidor al registrar el vehículo.' });
  }
};

/**
 * Permite a un administrador cambiar el estado de compliance de un prestador ('approved' o 'rejected').
 * Roles permitidos: 'admin', 'superadmin'
 */
const updateComplianceStatus = async (req, res) => {
  try {
    const { provider_id, status } = req.body;

    if (!provider_id || !['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Parámetros inválidos. Especifique un provider_id y un estado válido (approved, rejected, pending).' });
    }

    const updateQuery = `
      UPDATE providers 
      SET status = $1 
      WHERE id = $2 
      RETURNING id, user_id, specialty, status;
    `;

    const result = await db.query(updateQuery, [status, provider_id]);

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
 * Lista todos los prestadores aprobados dentro del country para que los residentes puedan contratarlos.
 * Roles permitidos: 'owner', 'family', 'admin', 'superadmin'
 */
const listVerifiedProviders = async (req, res) => {
  try {
    const countryId = req.user.countryId;

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
      WHERE u.country_id = $1 AND p.status = 'approved';
    `;

    const result = await db.query(query, [countryId]);

    return res.status(200).json({
      count: result.rows.length,
      providers: result.rows
    });

  } catch (error) {
    console.error('Error al listar prestadores:', error);
    return res.status(500).json({ error: 'Error interno del servidor al obtener el directorio.' });
  }
};

module.exports = {
  updateProviderProfile,
  addVehicle,
  updateComplianceStatus,
  listVerifiedProviders
};