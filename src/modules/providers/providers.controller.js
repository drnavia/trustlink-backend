/**
 * @file providers.controller.js
 * @description Controlador completo del módulo de prestadores en TrustLink.
 * Incluye gestión de perfiles/credenciales de compliance, flota vehicular,
 * auditoría central (Ops TrustLink), directorio unificado por prestador (listVerifiedProviders)
 * y reportes/suspensiones operativas locales por comunidad (listLocalSuspensions,
 * createLocalSuspension, liftLocalSuspension).
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

/**
 * Registra o agrega un nuevo perfil/historial de compliance y especialidad para un usuario 'provider'.
 */
const updateProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      specialty,
      criminal_record_url,
      criminal_record_expiry,
      insurance_policy_url,
      insurance_expiry
    } = req.body;

    if (!specialty || !String(specialty).trim()) {
      return res.status(400).json({ error: 'La especialidad del prestador es obligatoria.' });
    }

    const insertQuery = `
      INSERT INTO providers (
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        status
      )
      VALUES ($1, $2, $3, $4::date, $5, $6::date, 'pending')
      RETURNING
        id,
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        status,
        rating_avg,
        created_at;
    `;

    const values = [
      userId,
      String(specialty).trim(),
      criminal_record_url ? String(criminal_record_url).trim() : null,
      criminal_record_expiry || null,
      insurance_policy_url ? String(insurance_policy_url).trim() : null,
      insurance_expiry || null
    ];

    const providerResult = await db.query(insertQuery, values);

    return res.status(201).json({
      message: 'Perfil de compliance registrado y enviado a revisión con éxito.',
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
    const profileId = parseInt(req.params.id, 10);
    const {
      specialty,
      criminal_record_url,
      criminal_record_expiry,
      insurance_policy_url,
      insurance_expiry
    } = req.body;

    if (!Number.isInteger(profileId) || profileId <= 0) {
      return res.status(400).json({ error: 'ID de perfil inválido.' });
    }

    const existing = await db.query(
      'SELECT * FROM providers WHERE id = $1 AND user_id = $2',
      [profileId, userId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de prestador no encontrado o no autorizado.' });
    }

    const current = existing.rows[0];
    const updateQuery = `
      UPDATE providers
      SET specialty = $1,
          criminal_record_url = $2,
          criminal_record_expiry = COALESCE($3::date, criminal_record_expiry),
          insurance_policy_url = $4,
          insurance_expiry = COALESCE($5::date, insurance_expiry),
          status = 'pending'
      WHERE id = $6 AND user_id = $7
      RETURNING
        id,
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        status,
        rating_avg,
        created_at;
    `;

    const result = await db.query(updateQuery, [
      specialty !== undefined ? String(specialty).trim() : current.specialty,
      criminal_record_url !== undefined
        ? (String(criminal_record_url).trim() || null)
        : current.criminal_record_url,
      criminal_record_expiry || null,
      insurance_policy_url !== undefined
        ? (String(insurance_policy_url).trim() || null)
        : current.insurance_policy_url,
      insurance_expiry || null,
      profileId,
      userId
    ]);

    return res.status(200).json({
      message: 'Perfil actualizado con éxito. Pendiente de aprobación.',
      provider: result.rows[0]
    });
  } catch (error) {
    console.error('Error al editar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el perfil.' });
  }
};

/**
 * Agrega un vehículo asociado al prestador logueado.
 */
const addVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { vehicle_type, brand, model, color, plate, vehicle_insurance_url } = req.body;

    if (!plate || !String(plate).trim()) {
      return res.status(400).json({ error: 'La patente del vehículo es obligatoria.' });
    }

    const providerRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [userId]
    );

    let providerId;
    if (providerRes.rows.length === 0) {
      const newProv = await db.query(
        `
          INSERT INTO providers (user_id, specialty, status)
          VALUES ($1, 'Servicios Generales', 'pending')
          RETURNING id
        `,
        [userId]
      );
      providerId = newProv.rows[0].id;
    } else {
      providerId = providerRes.rows[0].id;
    }

    const vehicleQuery = `
      INSERT INTO provider_vehicles (
        provider_id,
        vehicle_type,
        brand,
        model,
        color,
        plate,
        vehicle_insurance_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, provider_id, vehicle_type, brand, model, color, plate, vehicle_insurance_url, created_at;
    `;

    const result = await db.query(vehicleQuery, [
      providerId,
      vehicle_type ? String(vehicle_type).trim() : 'Automóvil',
      brand ? String(brand).trim() : '',
      model ? String(model).trim() : '',
      color ? String(color).trim() : 'No especificado',
      String(plate).trim().toUpperCase(),
      vehicle_insurance_url || null
    ]);

    return res.status(201).json({
      message: 'Vehículo registrado con éxito.',
      vehicle: result.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar vehículo:', error);
    return res.status(500).json({ error: 'Error interno al registrar vehículo.' });
  }
};

/**
 * Edita un vehículo existente del prestador.
 */
const editVehicle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const vehicleId = parseInt(req.params.id, 10);
    const { vehicle_type, brand, model, color, plate, vehicle_insurance_url } = req.body;

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'ID de vehículo inválido.' });
    }
    if (plate !== undefined && !String(plate).trim()) {
      return res.status(400).json({ error: 'La patente del vehículo no puede quedar vacía.' });
    }

    const vehRes = await db.query(
      `
        SELECT pv.*
        FROM provider_vehicles pv
        INNER JOIN providers p ON p.id = pv.provider_id
        WHERE pv.id = $1 AND p.user_id = $2
      `,
      [vehicleId, userId]
    );
    if (vehRes.rows.length === 0) {
      return res.status(404).json({ error: 'Vehículo no encontrado o no autorizado.' });
    }

    const current = vehRes.rows[0];
    const updateQuery = `
      UPDATE provider_vehicles
      SET vehicle_type = $1,
          brand = $2,
          model = $3,
          color = $4,
          plate = $5,
          vehicle_insurance_url = COALESCE($6, vehicle_insurance_url)
      WHERE id = $7
      RETURNING id, provider_id, vehicle_type, brand, model, color, plate, vehicle_insurance_url, created_at;
    `;

    const result = await db.query(updateQuery, [
      vehicle_type !== undefined ? String(vehicle_type).trim() : current.vehicle_type,
      brand !== undefined ? String(brand).trim() : current.brand,
      model !== undefined ? String(model).trim() : current.model,
      color !== undefined ? String(color).trim() : current.color,
      plate !== undefined ? String(plate).trim().toUpperCase() : current.plate,
      vehicle_insurance_url || null,
      vehicleId
    ]);

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
    const providersRes = await db.query(
      `
        SELECT
          p.id,
          p.specialty,
          p.criminal_record_url,
          p.criminal_record_expiry,
          p.insurance_policy_url,
          p.insurance_expiry,
          p.status,
          p.rating_avg,
          p.created_at,
          u.first_name,
          u.last_name,
          u.email,
          u.phone
        FROM providers p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC, p.id DESC
      `,
      [userId]
    );

    const vehiclesRes = await db.query(
      `
        SELECT pv.*
        FROM provider_vehicles pv
        INNER JOIN providers p ON p.id = pv.provider_id
        WHERE p.user_id = $1
        ORDER BY pv.id ASC
      `,
      [userId]
    );

    return res.status(200).json({
      providers: providersRes.rows,
      vehicles: vehiclesRes.rows
    });
  } catch (error) {
    console.error('Error al obtener perfil del prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

/**
 * Lista TODOS los prestadores registrados (incluyendo aquellos sin perfil completo)
 * para Ops TrustLink mediante LEFT JOIN desde users.
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
        p.criminal_record_expiry,
        p.insurance_policy_url,
        p.insurance_expiry,
        COALESCE(p.status::text, 'sin_perfil') AS status,
        COALESCE(p.rating_avg, 0.00) AS rating_avg,
        COALESCE(p.created_at, u.created_at) AS created_at
      FROM users u
      LEFT JOIN providers p ON u.id = p.user_id
      WHERE u.role = 'provider'
      ORDER BY COALESCE(p.rating_avg, 0.00) DESC, u.id ASC;
    `;
    const result = await db.query(query);
    return res.status(200).json({ count: result.rows.length, providers: result.rows });
  } catch (error) {
    console.error('Error al listar prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno.' });
  }
};

/**
 * Actualiza el estado de compliance global de un prestador (exclusivo superadmin).
 */
const updateComplianceStatus = async (req, res) => {
  try {
    const { provider_id, user_id, status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    let targetProviderId = provider_id;
    if (!targetProviderId && user_id) {
      const existing = await db.query(
        'SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [user_id]
      );
      if (existing.rows.length > 0) {
        targetProviderId = existing.rows[0].id;
      } else {
        const newProv = await db.query(
          `
            INSERT INTO providers (user_id, specialty, status)
            VALUES ($1, 'Servicios Generales', $2)
            RETURNING id
          `,
          [user_id, status]
        );
        targetProviderId = newProv.rows[0].id;
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
      message: `Estado de compliance actualizado exitosamente a: ${status}`,
      provider: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar compliance:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar la solicitud.' });
  }
};

/**
 * Lista los prestadores verificados unificados por usuario (u.id) para el Portal Residente.
 * Si un mismo profesional tiene múltiples filas aprobadas en providers (por ejemplo distintas
 * especialidades), consolida en una sola tarjeta sus especialidades, promedio de calificación
 * y cantidad total de trabajos/contratos asociados a cualquiera de sus perfiles aprobados.
 */
const listVerifiedProviders = async (req, res) => {
  try {
    const query = `
      WITH approved_profiles AS (
        SELECT
          p.id AS provider_id,
          p.user_id,
          u.first_name,
          u.last_name,
          u.phone,
          u.email,
          p.specialty,
          COALESCE(p.rating_avg, 0.00)::numeric(4,2) AS rating_avg,
          p.id AS ordered_id,
          (
            SELECT COUNT(*)::int
            FROM service_contracts sc
            WHERE sc.provider_id = p.id
          ) AS profile_jobs
        FROM providers p
        JOIN users u ON p.user_id = u.id
        WHERE p.status = 'approved'::provider_status
      )
      SELECT
        (ARRAY_AGG(ap.provider_id ORDER BY ap.ordered_id ASC))[1] AS provider_id,
        ARRAY_AGG(ap.provider_id ORDER BY ap.ordered_id ASC) AS provider_ids,
        ap.user_id,
        ap.first_name,
        ap.last_name,
        ap.phone,
        ap.email,
        STRING_AGG(DISTINCT ap.specialty, ' · ' ORDER BY ap.specialty) AS specialties_label,
        ARRAY_AGG(DISTINCT ap.specialty ORDER BY ap.specialty) AS specialties,
        (ARRAY_AGG(ap.specialty ORDER BY ap.ordered_id ASC))[1] AS specialty,
        ROUND(AVG(ap.rating_avg)::numeric, 2) AS rating_avg,
        COALESCE(SUM(ap.profile_jobs), 0)::int AS total_jobs
      FROM approved_profiles ap
      GROUP BY ap.user_id, ap.first_name, ap.last_name, ap.phone, ap.email
      ORDER BY AVG(ap.rating_avg) DESC, ap.user_id ASC;
    `;

    const result = await db.query(query);

    return res.status(200).json({
      count: result.rows.length,
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al listar prestadores verificados:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al obtener el directorio.'
    });
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
      `
        SELECT
          p.id AS provider_id,
          p.specialty,
          p.status AS compliance_status,
          p.rating_avg,
          u.first_name,
          u.last_name,
          u.email
        FROM providers p
        INNER JOIN users u ON u.id = p.user_id
        ORDER BY u.first_name ASC, p.id ASC
      `
    );

    const params = [];
    let whereClause = '';
    if (effectiveCountryId && Number.isInteger(effectiveCountryId) && effectiveCountryId > 0) {
      params.push(effectiveCountryId);
      whereClause = 'WHERE lps.country_id = $1';
    }

    const suspensionsRes = await db.query(
      `
        SELECT
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
        ORDER BY lps.id DESC
      `,
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
      return res
        .status(400)
        .json({ error: 'El motivo del reporte o suspensión local es obligatorio.' });
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
      `
        INSERT INTO local_provider_suspensions
          (country_id, provider_id, reported_by_user_id, reason, status)
        VALUES ($1, $2, $3, $4, 'active')
        RETURNING *
      `,
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
      `
        UPDATE local_provider_suspensions
        SET status = 'lifted', lifted_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
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