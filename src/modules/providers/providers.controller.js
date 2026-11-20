/**
 * @file providers.controller.js
 * @description Controlador para perfiles de prestadores, vehículos, compliance centralizado
 * y suspensiones/reportes operativos locales por comunidad (rol admin / superadmin).
 * @location /trustlink-backend/src/modules/providers/providers.controller.js
 */

const db = require('../../config/db');

/**
 * Asegura la existencia de la tabla local_provider_suspensions de forma idempotente.
 * Permite que un admin local reporte o suspenda temporalmente a un prestador dentro
 * de su comunidad (country_id) sin alterar el compliance global de la red TrustLink.
 */
const ensureLocalSuspensionsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS local_provider_suspensions (
      id SERIAL PRIMARY KEY,
      country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      reported_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted')),
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      lifted_at TIMESTAMP WITHOUT TIME ZONE NULL
    );
  `);
};

const updateProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { specialty, criminal_record_url, insurance_policy_url } = req.body;

    if (!specialty || !String(specialty).trim()) {
      return res.status(400).json({ error: 'La especialidad es obligatoria.' });
    }

    const insertRes = await db.query(
      `INSERT INTO providers (user_id, specialty, criminal_record_url, insurance_policy_url, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [
        userId,
        String(specialty).trim(),
        criminal_record_url ? String(criminal_record_url).trim() : null,
        insurance_policy_url ? String(insurance_policy_url).trim() : null
      ]
    );

    return res.status(201).json({
      message: 'Perfil profesional registrado y enviado a revisión de compliance.',
      provider: insertRes.rows[0]
    });
  } catch (error) {
    console.error('Error al crear perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno al registrar el perfil.' });
  }
};

const editProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const profileId = parseInt(req.params.id, 10);
    const { specialty, criminal_record_url, insurance_policy_url } = req.body;

    if (!Number.isInteger(profileId) || profileId <= 0) {
      return res.status(400).json({ error: 'ID de perfil inválido.' });
    }

    const existing = await db.query(
      'SELECT * FROM providers WHERE id = $1 AND user_id = $2',
      [profileId, userId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil no encontrado.' });
    }

    const current = existing.rows[0];
    const updated = await db.query(
      `UPDATE providers
       SET specialty = $1,
           criminal_record_url = $2,
           insurance_policy_url = $3
       WHERE id = $4
       RETURNING *`,
      [
        specialty !== undefined ? String(specialty).trim() : current.specialty,
        criminal_record_url !== undefined
          ? (String(criminal_record_url).trim() || null)
          : current.criminal_record_url,
        insurance_policy_url !== undefined
          ? (String(insurance_policy_url).trim() || null)
          : current.insurance_policy_url,
        profileId
      ]
    );

    return res.status(200).json({
      message: 'Perfil profesional actualizado.',
      provider: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al editar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno al editar el perfil.' });
  }
};

const addVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { vehicle_type, brand, model, color, plate } = req.body;

    if (!plate || !String(plate).trim()) {
      return res.status(400).json({ error: 'La patente es obligatoria.' });
    }

    const providerRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1 ORDER BY id ASC LIMIT 1',
      [userId]
    );
    if (providerRes.rows.length === 0) {
      return res.status(400).json({ error: 'Debe crear primero su perfil profesional.' });
    }

    const providerId = providerRes.rows[0].id;
    const insertVeh = await db.query(
      `INSERT INTO provider_vehicles (provider_id, vehicle_type, brand, model, color, plate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        providerId,
        vehicle_type ? String(vehicle_type).trim() : 'Utilitario',
        brand ? String(brand).trim() : null,
        model ? String(model).trim() : null,
        color ? String(color).trim() : null,
        String(plate).trim().toUpperCase()
      ]
    );

    return res.status(201).json({
      message: 'Vehículo registrado correctamente.',
      vehicle: insertVeh.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar vehículo:', error);
    return res.status(500).json({ error: 'Error interno al registrar el vehículo.' });
  }
};

const editVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const vehicleId = parseInt(req.params.id, 10);
    const { vehicle_type, brand, model, color, plate } = req.body;

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'ID de vehículo inválido.' });
    }

    const vehRes = await db.query(
      `SELECT pv.*
       FROM provider_vehicles pv
       INNER JOIN providers p ON p.id = pv.provider_id
       WHERE pv.id = $1 AND p.user_id = $2`,
      [vehicleId, userId]
    );
    if (vehRes.rows.length === 0) {
      return res.status(404).json({ error: 'Vehículo no encontrado.' });
    }

    const current = vehRes.rows[0];
    const updated = await db.query(
      `UPDATE provider_vehicles
       SET vehicle_type = $1,
           brand = $2,
           model = $3,
           color = $4,
           plate = $5
       WHERE id = $6
       RETURNING *`,
      [
        vehicle_type !== undefined ? String(vehicle_type).trim() : current.vehicle_type,
        brand !== undefined ? String(brand).trim() : current.brand,
        model !== undefined ? String(model).trim() : current.model,
        color !== undefined ? String(color).trim() : current.color,
        plate !== undefined ? String(plate).trim().toUpperCase() : current.plate,
        vehicleId
      ]
    );

    return res.status(200).json({
      message: 'Vehículo actualizado correctamente.',
      vehicle: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al editar vehículo:', error);
    return res.status(500).json({ error: 'Error interno al editar el vehículo.' });
  }
};

const getMyProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;

    const profilesRes = await db.query(
      `SELECT p.*, u.first_name, u.last_name, u.email, u.phone
       FROM providers p
       INNER JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1
       ORDER BY p.id ASC`,
      [userId]
    );

    const vehiclesRes = await db.query(
      `SELECT pv.*
       FROM provider_vehicles pv
       INNER JOIN providers p ON p.id = pv.provider_id
       WHERE p.user_id = $1
       ORDER BY pv.id ASC`,
      [userId]
    );

    return res.status(200).json({
      providers: profilesRes.rows,
      vehicles: vehiclesRes.rows
    });
  } catch (error) {
    console.error('Error al obtener perfil del prestador:', error);
    return res.status(500).json({ error: 'Error interno al obtener el perfil.' });
  }
};

const listAllProvidersForOps = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        p.id AS provider_id,
        p.user_id,
        p.specialty,
        p.criminal_record_url,
        p.insurance_policy_url,
        p.status,
        p.rating_avg,
        p.created_at,
        u.first_name,
        u.last_name,
        u.dni,
        u.email,
        u.phone
       FROM providers p
       INNER JOIN users u ON u.id = p.user_id
       ORDER BY p.id DESC`
    );

    return res.status(200).json({
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al listar prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno al listar prestadores.' });
  }
};

const updateComplianceStatus = async (req, res) => {
  try {
    const { provider_id, status } = req.body;
    const providerId = parseInt(provider_id, 10);

    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: 'ID de prestador inválido.' });
    }
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    const updated = await db.query(
      `UPDATE providers
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, providerId]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    return res.status(200).json({
      message: `Estado de compliance actualizado a ${status}.`,
      provider: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar estado de compliance:', error);
    return res.status(500).json({ error: 'Error interno al actualizar compliance.' });
  }
};

const listVerifiedProviders = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        p.id AS provider_id,
        p.user_id,
        p.specialty,
        p.status,
        p.rating_avg,
        u.first_name,
        u.last_name,
        u.email,
        u.phone
       FROM providers p
       INNER JOIN users u ON u.id = p.user_id
       WHERE p.status = 'approved'
       ORDER BY p.rating_avg DESC, p.id ASC`
    );

    return res.status(200).json({
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al obtener directorio de prestadores:', error);
    return res.status(500).json({ error: 'Error interno al obtener el directorio.' });
  }
};

/**
 * Lista suspensiones/reportes operativos locales y prestadores disponibles para el admin de barrio
 * (o globalmente para superadmin).
 */
const listLocalSuspensions = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();

    const role = req.user.role;
    const userCountryId = req.user.countryId;
    const requestedCountryId = req.query.country_id ? parseInt(req.query.country_id, 10) : null;

    const effectiveCountryId = role === 'superadmin' ? requestedCountryId : userCountryId;

    const countriesRes = await db.query(
      'SELECT id, name, location, is_active FROM countries ORDER BY id ASC'
    );

    const providersRes = await db.query(
      `SELECT
        p.id AS provider_id,
        p.specialty,
        p.status AS compliance_status,
        p.rating_avg,
        u.first_name,
        u.last_name,
        u.email
       FROM providers p
       INNER JOIN users u ON u.id = p.user_id
       ORDER BY u.first_name ASC, p.id ASC`
    );

    const params = [];
    let whereClause = '';
    if (effectiveCountryId && Number.isInteger(effectiveCountryId) && effectiveCountryId > 0) {
      params.push(effectiveCountryId);
      whereClause = 'WHERE lps.country_id = $1';
    }

    const suspensionsRes = await db.query(
      `SELECT
        lps.id,
        lps.country_id,
        c.name AS country_name,
        lps.provider_id,
        p.specialty,
        p.status AS compliance_status,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        lps.reported_by_user_id,
        u_adm.first_name AS admin_first_name,
        u_adm.last_name AS admin_last_name,
        lps.reason,
        lps.status,
        lps.created_at,
        lps.lifted_at
       FROM local_provider_suspensions lps
       LEFT JOIN countries c ON c.id = lps.country_id
       LEFT JOIN providers p ON p.id = lps.provider_id
       LEFT JOIN users u_prov ON u_prov.id = p.user_id
       LEFT JOIN users u_adm ON u_adm.id = lps.reported_by_user_id
       ${whereClause}
       ORDER BY lps.id DESC`,
      params
    );

    return res.status(200).json({
      effective_country_id: effectiveCountryId || null,
      countries: countriesRes.rows,
      providers: providersRes.rows,
      suspensions: suspensionsRes.rows
    });
  } catch (error) {
    console.error('Error al listar suspensiones locales:', error);
    return res.status(500).json({ error: 'Error interno al consultar suspensiones locales.' });
  }
};

/**
 * Registra una suspensión o reporte operativo local de un prestador en una comunidad.
 * No modifica providers.status (compliance global).
 */
const createLocalSuspension = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();

    const role = req.user.role;
    const adminUserId = req.user.userId;
    const providerId = parseInt(req.body.provider_id, 10);
    const reason = String(req.body.reason || '').trim();
    const countryId =
      role === 'superadmin'
        ? parseInt(req.body.country_id || req.user.countryId || 1, 10)
        : parseInt(req.body.country_id || req.user.countryId, 10);

    if (!Number.isInteger(countryId) || countryId <= 0) {
      return res.status(400).json({ error: 'Debe indicar una comunidad válida.' });
    }
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: 'Debe seleccionar un prestador válido.' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'El motivo del reporte o suspensión local es obligatorio.' });
    }

    const providerCheck = await db.query('SELECT id FROM providers WHERE id = $1', [providerId]);
    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    const countryCheck = await db.query('SELECT id, name FROM countries WHERE id = $1', [countryId]);
    if (countryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    const insertRes = await db.query(
      `INSERT INTO local_provider_suspensions
        (country_id, provider_id, reported_by_user_id, reason, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [countryId, providerId, adminUserId, reason]
    );

    return res.status(201).json({
      message: `Reporte/suspensión local registrada en ${countryCheck.rows[0].name}.`,
      suspension: insertRes.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar suspensión local:', error);
    return res.status(500).json({ error: 'Error interno al registrar el reporte local.' });
  }
};

/**
 * Levanta una suspensión/reporte local activa.
 */
const liftLocalSuspension = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();

    const suspensionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(suspensionId) || suspensionId <= 0) {
      return res.status(400).json({ error: 'ID de reporte/suspensión inválido.' });
    }

    const updated = await db.query(
      `UPDATE local_provider_suspensions
       SET status = 'lifted', lifted_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [suspensionId]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Registro no encontrado.' });
    }

    return res.status(200).json({
      message: 'Suspensión local levantada correctamente.',
      suspension: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al levantar suspensión local:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la suspensión.' });
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
  listVerifiedProviders,
  listLocalSuspensions,
  createLocalSuspension,
  liftLocalSuspension
};