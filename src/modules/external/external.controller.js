/**
 * @file external.controller.js
 * @description Endpoint de integración para aplicaciones y sistemas de garita de barrios privados,
 * diagnóstico técnico, gestión paginada/filtrada de pases QR y administración paginada/filtrada
 * de comunidades para superadmin.
 * @location /trustlink-backend/src/modules/external/external.controller.js
 */

const db = require('../../config/db');

/**
 * Diagnóstico del estado del backend, PostgreSQL y endpoint externo.
 * Uso exclusivo: rol 'superadmin'.
 */
const getExternalDiagnostics = async (req, res) => {
  const startedAt = Date.now();
  try {
    const dbCheck = await db.query('SELECT NOW() AS db_time');
    const metricsCheck = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM access_passes) AS total_passes,
        (SELECT COUNT(*)::int FROM providers WHERE status = 'approved') AS approved_providers,
        (SELECT COUNT(*)::int FROM countries WHERE is_active = true) AS active_countries,
        (SELECT COUNT(*)::int FROM countries) AS total_countries
    `);

    const dbLatencyMs = Date.now() - startedAt;
    const apiKeyConfigured = Boolean(process.env.EXTERNAL_GATE_API_KEY && String(process.env.EXTERNAL_GATE_API_KEY).trim());

    return res.status(200).json({
      status: 'healthy',
      service: 'trustlink-backend',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      database: {
        connected: true,
        latency_ms: dbLatencyMs,
        db_time: dbCheck.rows[0]?.db_time || null
      },
      external_endpoint: {
        route: '/api/v1/external/passes/verify',
        method: 'POST',
        api_key_configured: apiKeyConfigured,
        auth_modes: ['x-api-key', 'Bearer JWT (admin, superadmin, security)']
      },
      metrics: metricsCheck.rows[0] || {
        total_passes: 0,
        approved_providers: 0,
        active_countries: 0,
        total_countries: 0
      }
    });
  } catch (error) {
    console.error('Error en diagnóstico técnico externo:', error);
    return res.status(500).json({
      status: 'degraded',
      service: 'trustlink-backend',
      timestamp: new Date().toISOString(),
      database: {
        connected: false,
        latency_ms: Date.now() - startedAt
      },
      external_endpoint: {
        route: '/api/v1/external/passes/verify',
        method: 'POST',
        api_key_configured: Boolean(process.env.EXTERNAL_GATE_API_KEY && String(process.env.EXTERNAL_GATE_API_KEY).trim())
      },
      error: 'Error al consultar la base de datos o el estado del servicio.'
    });
  }
};

/**
 * Lista las comunidades (countries) con paginación y filtros por estado y búsqueda.
 * Uso exclusivo: rol 'superadmin'.
 */
const listCountries = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || '6', 10) || 6));
    const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
    const searchFilter = String(req.query.search || '').trim().toLowerCase();

    const whereClauses = [];
    const params = [];

    if (statusFilter === 'active') {
      whereClauses.push('is_active = true');
    } else if (statusFilter === 'inactive') {
      whereClauses.push('is_active = false');
    }

    if (searchFilter) {
      params.push(`%${searchFilter}%`);
      const idx = params.length;
      whereClauses.push(`(
        CAST(id AS TEXT) ILIKE $${idx}
        OR COALESCE(name, '') ILIKE $${idx}
        OR COALESCE(location, '') ILIKE $${idx}
      )`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM countries
      ${whereSql};
    `;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const dataParams = [...params, limit, offset];
    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;

    const query = `
      SELECT id, name, location, is_active, created_at
      FROM countries
      ${whereSql}
      ORDER BY id ASC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx};
    `;
    const result = await db.query(query, dataParams);

    const activeCountRes = await db.query('SELECT COUNT(*)::int AS active_count FROM countries WHERE is_active = true;');
    const activeCount = activeCountRes.rows[0]?.active_count || 0;

    return res.status(200).json({
      count: result.rows.length,
      total,
      active_count: activeCount,
      page: safePage,
      limit,
      totalPages,
      countries: result.rows
    });
  } catch (error) {
    console.error('Error al listar comunidades:', error);
    return res.status(500).json({
      error: 'Error interno al consultar las comunidades.'
    });
  }
};

/**
 * Crea una nueva comunidad (country) en PostgreSQL.
 * Uso exclusivo: rol 'superadmin'.
 */
const createCountry = async (req, res) => {
  try {
    const { name, location, is_active } = req.body;
    const cleanName = String(name || '').trim();
    const cleanLocation = location ? String(location).trim() : null;
    const activeStatus = typeof is_active === 'boolean' ? is_active : true;

    if (!cleanName) {
      return res.status(400).json({
        error: 'El nombre de la comunidad es obligatorio.'
      });
    }

    const query = `
      INSERT INTO countries (name, location, is_active)
      VALUES ($1, $2, $3)
      RETURNING id, name, location, is_active, created_at;
    `;
    const result = await db.query(query, [cleanName, cleanLocation, activeStatus]);

    return res.status(201).json({
      message: 'Comunidad creada exitosamente.',
      country: result.rows[0]
    });
  } catch (error) {
    console.error('Error al crear comunidad:', error);
    return res.status(500).json({
      error: 'Error interno al crear la comunidad.'
    });
  }
};

/**
 * Edita nombre y ubicación (y opcionalmente is_active) de una comunidad existente.
 * Uso exclusivo: rol 'superadmin'.
 */
const updateCountry = async (req, res) => {
  try {
    const countryId = Number(req.params.id);
    const { name, location, is_active } = req.body;

    if (!Number.isInteger(countryId) || countryId <= 0) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'El nombre de la comunidad es obligatorio.' });
    }

    const existing = await db.query(
      'SELECT id, name, location, is_active FROM countries WHERE id = $1 LIMIT 1',
      [countryId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    const current = existing.rows[0];
    const nextLocation = location !== undefined
      ? (String(location || '').trim() || null)
      : current.location;
    const nextActive = typeof is_active === 'boolean' ? is_active : current.is_active;

    const updated = await db.query(
      `UPDATE countries
       SET name = $1, location = $2, is_active = $3
       WHERE id = $4
       RETURNING id, name, location, is_active, created_at`,
      [cleanName, nextLocation, nextActive, countryId]
    );

    return res.status(200).json({
      message: `Comunidad #${countryId} actualizada con éxito.`,
      country: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al editar comunidad:', error);
    return res.status(500).json({
      error: 'Error interno al actualizar la comunidad.'
    });
  }
};

/**
 * Alterna o actualiza el estado is_active de una comunidad por ID.
 * Uso exclusivo: rol 'superadmin'.
 */
const toggleCountryStatus = async (req, res) => {
  try {
    const countryId = Number(req.params.id);

    if (!Number.isInteger(countryId) || countryId <= 0) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existing = await db.query(
      'SELECT id, name, is_active FROM countries WHERE id = $1 LIMIT 1',
      [countryId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    const nextActive = !existing.rows[0].is_active;

    const updated = await db.query(
      `UPDATE countries
       SET is_active = $1
       WHERE id = $2
       RETURNING id, name, location, is_active, created_at`,
      [nextActive, countryId]
    );

    return res.status(200).json({
      message: `Comunidad "${updated.rows[0].name}" ${nextActive ? 'activada' : 'desactivada'} con éxito.`,
      country: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar estado de comunidad:', error);
    return res.status(500).json({
      error: 'Error interno al actualizar la comunidad.'
    });
  }
};

/**
 * Lista los pases QR con paginación y filtros por estado y búsqueda.
 * Uso exclusivo: rol 'superadmin'.
 */
const listRecentPasses = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || '8', 10) || 8));
    const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
    const searchFilter = String(req.query.search || '').trim().toLowerCase();

    const whereClauses = [];
    const params = [];

    if (statusFilter && statusFilter !== 'all') {
      params.push(statusFilter);
      whereClauses.push(`LOWER(COALESCE(ap.status::text, '')) = $${params.length}`);
    }

    if (searchFilter) {
      params.push(`%${searchFilter}%`);
      const idx = params.length;
      whereClauses.push(`(
        CAST(ap.id AS TEXT) ILIKE $${idx}
        OR COALESCE(u_prov.first_name || ' ' || u_prov.last_name, '') ILIKE $${idx}
        OR COALESCE(p.specialty, '') ILIKE $${idx}
        OR COALESCE(c.name, '') ILIKE $${idx}
        OR COALESCE(ap.fraction_number, '') ILIKE $${idx}
        OR COALESCE(ap.lot_number, '') ILIKE $${idx}
      )`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM access_passes ap
      LEFT JOIN countries c ON ap.country_id = c.id
      LEFT JOIN providers p ON ap.provider_id = p.id
      LEFT JOIN users u_prov ON p.user_id = u_prov.id
      LEFT JOIN users u_owner ON ap.owner_id = u_owner.id
      ${whereSql};
    `;

    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const dataParams = [...params, limit, offset];
    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;

    const dataQuery = `
      SELECT
        ap.id,
        ap.qr_token,
        ap.status,
        ap.fraction_number,
        ap.lot_number,
        ap.start_time,
        ap.end_time,
        ap.created_at,
        c.name AS country_name,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        p.specialty AS provider_specialty,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name
      FROM access_passes ap
      LEFT JOIN countries c ON ap.country_id = c.id
      LEFT JOIN providers p ON ap.provider_id = p.id
      LEFT JOIN users u_prov ON p.user_id = u_prov.id
      LEFT JOIN users u_owner ON ap.owner_id = u_owner.id
      ${whereSql}
      ORDER BY ap.created_at DESC, ap.id DESC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx};
    `;

    const result = await db.query(dataQuery, dataParams);

    return res.status(200).json({
      count: result.rows.length,
      total,
      page: safePage,
      limit,
      totalPages,
      passes: result.rows
    });
  } catch (error) {
    console.error('Error al listar pases QR recientes:', error);
    return res.status(500).json({
      error: 'Error interno al consultar los pases QR recientes.'
    });
  }
};

/**
 * Cancela un pase QR existente por ID.
 * Uso exclusivo: rol 'superadmin'.
 */
const cancelPassById = async (req, res) => {
  try {
    const passId = Number(req.params.id);

    if (!Number.isInteger(passId) || passId <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const existing = await db.query(
      'SELECT id, status FROM access_passes WHERE id = $1 LIMIT 1',
      [passId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    if (existing.rows[0].status === 'cancelled') {
      return res.status(400).json({ error: 'El pase ya se encuentra cancelado.' });
    }

    const updated = await db.query(
      `UPDATE access_passes
       SET status = 'cancelled'
       WHERE id = $1
       RETURNING id, qr_token, status, start_time, end_time`,
      [passId]
    );

    return res.status(200).json({
      message: `Pase QR #${passId} cancelado con éxito.`,
      pass: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al cancelar pase QR:', error);
    return res.status(500).json({
      error: 'Error interno al cancelar el pase QR.'
    });
  }
};

/**
 * Valida un token QR para sistemas externos de barrios privados.
 * Soporta autenticación por API Key de integración (x-api-key) o Bearer JWT (admin, superadmin, security).
 */
const verifyExternalPassByQR = async (req, res) => {
  try {
    const { qr_token, country_id: bodyCountryId } = req.body;
    const apiKeyHeader = String(req.headers['x-api-key'] || '').trim();
    const configuredApiKey = String(process.env.EXTERNAL_GATE_API_KEY || 'tl_gate_dev_key_123456').trim();

    if (!qr_token) {
      return res.status(400).json({
        authorized: false,
        code: 'MISSING_QR_TOKEN',
        error: 'Debe proporcionar el campo qr_token en el cuerpo de la solicitud.'
      });
    }

    const scopedCountryId = req.user?.countryId || bodyCountryId || null;

    if (!req.user) {
      if (!apiKeyHeader || apiKeyHeader !== configuredApiKey) {
        return res.status(401).json({
          authorized: false,
          code: 'INVALID_API_KEY',
          error: 'API Key externa inválida o ausente en el encabezado x-api-key.'
        });
      }
    }

    const query = `
      SELECT
        ap.id AS pass_id,
        ap.status AS pass_status,
        ap.start_time,
        ap.end_time,
        (EXTRACT(EPOCH FROM (ap.start_time AT TIME ZONE 'UTC')) * 1000)::bigint AS start_utc_ms,
        (EXTRACT(EPOCH FROM (ap.end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
        (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_utc_ms,
        ap.country_id,
        c.name AS country_name,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        u_prov.phone AS provider_phone,
        p.id AS provider_id,
        p.specialty AS provider_specialty,
        p.status AS provider_compliance_status,
        p.rating_avg AS provider_rating,
        pv.vehicle_type,
        pv.brand,
        pv.model,
        pv.color,
        pv.plate,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        ap.fraction_number,
        ap.lot_number
      FROM access_passes ap
      LEFT JOIN countries c ON ap.country_id = c.id
      JOIN providers p ON ap.provider_id = p.id
      JOIN users u_prov ON p.user_id = u_prov.id
      JOIN users u_owner ON ap.owner_id = u_owner.id
      LEFT JOIN provider_vehicles pv ON pv.provider_id = p.id
      WHERE ap.qr_token = $1
      LIMIT 1;
    `;

    const result = await db.query(query, [String(qr_token).trim()]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        authorized: false,
        code: 'PASS_NOT_FOUND',
        error: 'Pase QR inválido o inexistente.'
      });
    }

    const passInfo = result.rows[0];

    if (scopedCountryId && passInfo.country_id && Number(passInfo.country_id) !== Number(scopedCountryId)) {
      return res.status(403).json({
        authorized: false,
        code: 'COUNTRY_MISMATCH',
        error: 'El pase pertenece a una comunidad distinta a la solicitante.'
      });
    }

    if (passInfo.provider_compliance_status !== 'approved') {
      return res.status(403).json({
        authorized: false,
        code: 'COMPLIANCE_NOT_APPROVED',
        error: `El prestador no posee compliance aprobado (estado: ${passInfo.provider_compliance_status}).`
      });
    }

    if (passInfo.pass_status === 'cancelled' || passInfo.pass_status === 'expired') {
      return res.status(400).json({
        authorized: false,
        code: 'PASS_INACTIVE',
        error: `El pase se encuentra en estado ${passInfo.pass_status}.`
      });
    }

    const startMs = Number(passInfo.start_utc_ms);
    const endMs = Number(passInfo.end_utc_ms);
    const nowMs = Number(passInfo.now_utc_ms);

    if (nowMs < startMs || nowMs > endMs) {
      return res.status(400).json({
        authorized: false,
        code: 'OUT_OF_TIME_WINDOW',
        error: 'El pase se encuentra fuera de la franja horaria autorizada.',
        valid_from: new Date(startMs).toISOString(),
        valid_to: new Date(endMs).toISOString(),
        evaluated_at: new Date(nowMs).toISOString()
      });
    }

    return res.status(200).json({
      authorized: true,
      code: 'ACCESS_GRANTED',
      message: 'Acceso autorizado para ingreso perimetral.',
      country: {
        id: passInfo.country_id,
        name: passInfo.country_name || null
      },
      pass: {
        id: passInfo.pass_id,
        status: passInfo.pass_status,
        fraction_number: passInfo.fraction_number,
        lot_number: passInfo.lot_number,
        authorized_by: `${passInfo.owner_first_name} ${passInfo.owner_last_name}`,
        valid_from: new Date(startMs).toISOString(),
        valid_to: new Date(endMs).toISOString()
      },
      provider: {
        id: passInfo.provider_id,
        first_name: passInfo.provider_first_name,
        last_name: passInfo.provider_last_name,
        dni: passInfo.provider_dni,
        phone: passInfo.provider_phone,
        specialty: passInfo.provider_specialty,
        compliance_status: passInfo.provider_compliance_status,
        rating_avg: passInfo.provider_rating
      },
      vehicle: passInfo.brand || passInfo.plate
        ? {
            vehicle_type: passInfo.vehicle_type,
            brand: passInfo.brand,
            model: passInfo.model,
            color: passInfo.color,
            plate: passInfo.plate
          }
        : null
    });
  } catch (error) {
    console.error('Error en validación externa de pase QR:', error);
    return res.status(500).json({
      authorized: false,
      code: 'INTERNAL_SERVER_ERROR',
      error: 'Error interno al procesar la validación externa del pase.'
    });
  }
};

module.exports = {
  getExternalDiagnostics,
  listCountries,
  createCountry,
  updateCountry,
  toggleCountryStatus,
  listRecentPasses,
  cancelPassById,
  verifyExternalPassByQR
};