/**
 * @file external.controller.js
 * @description Controlador completo para integración externa de barrios privados (validación de QR),
 * diagnóstico técnico del sistema, gestión de pases QR con persistencia de estado 'expired',
 * administración de comunidades, integraciones por comunidad y auditoría de accesos/transacciones.
 * @location /trustlink-backend/src/modules/external/external.controller.js
 */

const crypto = require('crypto');
const db = require('../../config/db');

/**
 * Asegura la existencia de la tabla country_integrations de forma idempotente.
 */
const ensureIntegrationsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS country_integrations (
      id SERIAL PRIMARY KEY,
      country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
      label VARCHAR(120) NOT NULL DEFAULT 'Garita Principal',
      api_key VARCHAR(128) NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_used_at TIMESTAMP WITHOUT TIME ZONE NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Asegura la existencia de la tabla gate_access_logs de forma idempotente
 * para auditar intentos autorizados y denegados de validación de pases QR.
 */
const ensureAuditLogsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gate_access_logs (
      id SERIAL PRIMARY KEY,
      qr_token VARCHAR(255) NULL,
      pass_id INTEGER NULL,
      country_id INTEGER NULL,
      integration_label VARCHAR(120) NULL,
      auth_mode VARCHAR(40) NOT NULL DEFAULT 'unknown',
      authorized BOOLEAN NOT NULL DEFAULT FALSE,
      reason_code VARCHAR(80) NOT NULL,
      message TEXT NOT NULL,
      http_status INTEGER NOT NULL DEFAULT 200,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Marca como 'expired' en PostgreSQL los pases en estado 'pending' cuya end_time
 * (interpretada en UTC, consistente con el almacenamiento del módulo de pases) ya venció.
 * Opcionalmente filtra por passId para actualizar un único pase de forma focalizada.
 */
const expireOverduePasses = async (passId = null) => {
  try {
    if (passId !== null && passId !== undefined) {
      await db.query(
        `UPDATE access_passes
         SET status = 'expired'::pass_status
         WHERE id = $1
           AND status = 'pending'::pass_status
           AND end_time IS NOT NULL
           AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`,
        [passId]
      );
      return;
    }

    await db.query(
      `UPDATE access_passes
       SET status = 'expired'::pass_status
       WHERE status = 'pending'::pass_status
         AND end_time IS NOT NULL
         AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`
    );
  } catch (err) {
    console.error('Error al persistir estado expired en access_passes:', err);
  }
};

/**
 * Registra un evento en gate_access_logs sin interrumpir la respuesta principal si falla el log.
 */
const recordGateAccessLog = async ({
  qrToken = null,
  passId = null,
  countryId = null,
  integrationLabel = null,
  authMode = 'unknown',
  authorized = false,
  reasonCode = 'UNKNOWN',
  message = '',
  httpStatus = 200
}) => {
  try {
    await ensureAuditLogsTable();
    const safeToken = qrToken ? String(qrToken).slice(0, 120) : null;
    await db.query(
      `INSERT INTO gate_access_logs
        (qr_token, pass_id, country_id, integration_label, auth_mode, authorized, reason_code, message, http_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        safeToken,
        passId || null,
        countryId || null,
        integrationLabel || null,
        authMode,
        Boolean(authorized),
        reasonCode,
        message,
        httpStatus
      ]
    );
  } catch (logErr) {
    console.error('Error al registrar evento de auditoría en gate_access_logs:', logErr);
  }
};

const maskApiKey = (apiKey = '') => {
  if (!apiKey || apiKey.length <= 10) return '••••••••••';
  return `${apiKey.slice(0, 10)}••••••••••••${apiKey.slice(-4)}`;
};

/**
 * Diagnóstico técnico del backend, base de datos y endpoint externo.
 * Uso exclusivo: rol 'superadmin'.
 */
const getExternalDiagnostics = async (req, res) => {
  const startedAt = Date.now();
  try {
    await Promise.all([ensureIntegrationsTable(), ensureAuditLogsTable(), expireOverduePasses()]);
    const dbCheck = await db.query('SELECT NOW() AS db_time');
    const dbLatencyMs = Date.now() - startedAt;

    const metricsCheck = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM access_passes) AS total_passes,
        (SELECT COUNT(*)::int FROM access_passes WHERE status = 'expired') AS expired_passes,
        (SELECT COUNT(*)::int FROM providers WHERE status = 'approved') AS approved_providers,
        (SELECT COUNT(*)::int FROM countries WHERE is_active = true) AS active_countries,
        (SELECT COUNT(*)::int FROM countries) AS total_countries,
        (SELECT COUNT(*)::int FROM country_integrations WHERE is_active = true) AS active_integrations
    `);

    const envApiKeyConfigured = Boolean(
      process.env.EXTERNAL_GATE_API_KEY && String(process.env.EXTERNAL_GATE_API_KEY).trim()
    );
    const activeIntegrationsCount = Number(metricsCheck.rows[0]?.active_integrations || 0);

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
        api_key_configured: envApiKeyConfigured || activeIntegrationsCount > 0,
        env_key_configured: envApiKeyConfigured,
        active_community_keys: activeIntegrationsCount,
        auth_modes: ['x-api-key (Comunidad / Env)', 'Bearer JWT (admin, superadmin, security)']
      },
      metrics: metricsCheck.rows[0] || {
        total_passes: 0,
        expired_passes: 0,
        approved_providers: 0,
        active_countries: 0,
        total_countries: 0,
        active_integrations: 0
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
      error: 'Error al consultar la base de datos o el estado del servicio.'
    });
  }
};

/**
 * Lista comunidades con paginación, búsqueda y filtro de estado.
 */
const listCountries = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 50);
    const status = String(req.query.status || 'all').toLowerCase();
    const search = String(req.query.search || '').trim();
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (status === 'active') {
      conditions.push('is_active = TRUE');
    } else if (status === 'inactive') {
      conditions.push('is_active = FALSE');
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(`(CAST(id AS TEXT) ILIKE $${idx} OR name ILIKE $${idx} OR COALESCE(location, '') ILIKE $${idx})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM countries ${whereClause}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const dataParams = [...params, limit, offset];
    const result = await db.query(
      `SELECT id, name, location, is_active, created_at
       FROM countries
       ${whereClause}
       ORDER BY id ASC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.status(200).json({
      countries: result.rows,
      total,
      page,
      limit,
      totalPages
    });
  } catch (error) {
    console.error('Error al listar comunidades:', error);
    return res.status(500).json({ error: 'Error interno al obtener las comunidades.' });
  }
};

/**
 * Crea una nueva comunidad en countries.
 */
const createCountry = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const location = req.body.location !== undefined && req.body.location !== null
      ? String(req.body.location).trim()
      : null;
    const isActive = req.body.is_active !== undefined ? Boolean(req.body.is_active) : true;

    if (!name) {
      return res.status(400).json({ error: 'El nombre de la comunidad es obligatorio.' });
    }

    const insertResult = await db.query(
      `INSERT INTO countries (name, location, is_active)
       VALUES ($1, $2, $3)
       RETURNING id, name, location, is_active, created_at`,
      [name, location || null, isActive]
    );

    return res.status(201).json({
      message: 'Comunidad creada correctamente.',
      country: insertResult.rows[0]
    });
  } catch (error) {
    console.error('Error al crear comunidad:', error);
    return res.status(500).json({ error: 'Error interno al crear la comunidad.' });
  }
};

/**
 * Edita nombre, ubicación o estado de una comunidad existente.
 */
const updateCountry = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existingResult = await db.query(
      'SELECT id, name, location, is_active, created_at FROM countries WHERE id = $1',
      [id]
    );
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    const current = existingResult.rows[0];
    const nextName = req.body.name !== undefined ? String(req.body.name).trim() : current.name;
    const nextLocation = req.body.location !== undefined
      ? (String(req.body.location).trim() || null)
      : current.location;
    const nextIsActive = req.body.is_active !== undefined ? Boolean(req.body.is_active) : current.is_active;

    if (!nextName) {
      return res.status(400).json({ error: 'El nombre de la comunidad no puede quedar vacío.' });
    }

    const updatedResult = await db.query(
      `UPDATE countries
       SET name = $1, location = $2, is_active = $3
       WHERE id = $4
       RETURNING id, name, location, is_active, created_at`,
      [nextName, nextLocation, nextIsActive, id]
    );

    return res.status(200).json({
      message: 'Comunidad actualizada correctamente.',
      country: updatedResult.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar comunidad:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la comunidad.' });
  }
};

/**
 * Alterna el estado is_active de una comunidad.
 */
const toggleCountryStatus = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const result = await db.query(
      `UPDATE countries
       SET is_active = NOT is_active
       WHERE id = $1
       RETURNING id, name, location, is_active, created_at`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    return res.status(200).json({
      message: `Estado de la comunidad actualizado a ${result.rows[0].is_active ? 'activa' : 'inactiva'}.`,
      country: result.rows[0]
    });
  } catch (error) {
    console.error('Error al cambiar estado de comunidad:', error);
    return res.status(500).json({ error: 'Error interno al cambiar el estado de la comunidad.' });
  }
};

/**
 * Lista todas las integraciones y claves API por comunidad para superadmin.
 */
const listCommunityIntegrations = async (req, res) => {
  try {
    await ensureIntegrationsTable();

    const countriesRes = await db.query(
      'SELECT id, name, location, is_active FROM countries ORDER BY id ASC'
    );

    const keysRes = await db.query(`
      SELECT
        ci.id,
        ci.country_id,
        c.name AS country_name,
        c.location AS country_location,
        c.is_active AS country_is_active,
        ci.label,
        ci.api_key,
        ci.is_active,
        ci.last_used_at,
        ci.created_at
      FROM country_integrations ci
      INNER JOIN countries c ON c.id = ci.country_id
      ORDER BY ci.id DESC
    `);

    const integrations = keysRes.rows.map((row) => ({
      id: row.id,
      country_id: row.country_id,
      country_name: row.country_name,
      country_location: row.country_location,
      country_is_active: row.country_is_active,
      label: row.label,
      api_key: row.api_key,
      masked_key: maskApiKey(row.api_key),
      is_active: row.is_active,
      last_used_at: row.last_used_at,
      created_at: row.created_at
    }));

    return res.status(200).json({
      countries: countriesRes.rows,
      integrations,
      env_fallback_configured: Boolean(
        process.env.EXTERNAL_GATE_API_KEY && String(process.env.EXTERNAL_GATE_API_KEY).trim()
      )
    });
  } catch (error) {
    console.error('Error al listar integraciones por comunidad:', error);
    return res.status(500).json({ error: 'Error interno al consultar integraciones.' });
  }
};

/**
 * Crea una nueva API Key para una comunidad.
 */
const createCommunityIntegration = async (req, res) => {
  try {
    await ensureIntegrationsTable();

    const countryId = parseInt(req.body.country_id, 10);
    const label = String(req.body.label || 'Garita Principal').trim() || 'Garita Principal';

    if (!Number.isInteger(countryId) || countryId <= 0) {
      return res.status(400).json({ error: 'Debe seleccionar una comunidad válida.' });
    }

    const countryCheck = await db.query(
      'SELECT id, name, is_active FROM countries WHERE id = $1',
      [countryId]
    );
    if (countryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'La comunidad indicada no existe.' });
    }

    const generatedKey = `tl_c${countryId}_${crypto.randomBytes(18).toString('hex')}`;

    const insertRes = await db.query(
      `INSERT INTO country_integrations (country_id, label, api_key, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, country_id, label, api_key, is_active, last_used_at, created_at`,
      [countryId, label, generatedKey]
    );

    const created = insertRes.rows[0];
    return res.status(201).json({
      message: `Clave de integración generada para ${countryCheck.rows[0].name}.`,
      integration: {
        ...created,
        country_name: countryCheck.rows[0].name,
        country_is_active: countryCheck.rows[0].is_active,
        masked_key: maskApiKey(created.api_key)
      },
      plain_api_key: generatedKey
    });
  } catch (error) {
    console.error('Error al crear clave de integración:', error);
    return res.status(500).json({ error: 'Error interno al generar la clave de integración.' });
  }
};

/**
 * Rota / regenera la clave de una integración existente.
 */
const rotateCommunityIntegrationKey = async (req, res) => {
  try {
    await ensureIntegrationsTable();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de integración inválido.' });
    }

    const currentRes = await db.query(
      `SELECT ci.id, ci.country_id, ci.label, c.name AS country_name
       FROM country_integrations ci
       INNER JOIN countries c ON c.id = ci.country_id
       WHERE ci.id = $1`,
      [id]
    );
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada.' });
    }

    const current = currentRes.rows[0];
    const newKey = `tl_c${current.country_id}_${crypto.randomBytes(18).toString('hex')}`;

    const updatedRes = await db.query(
      `UPDATE country_integrations
       SET api_key = $1, is_active = TRUE
       WHERE id = $2
       RETURNING id, country_id, label, api_key, is_active, last_used_at, created_at`,
      [newKey, id]
    );

    return res.status(200).json({
      message: `Clave rotada para ${current.country_name} (${current.label}).`,
      integration: {
        ...updatedRes.rows[0],
        country_name: current.country_name,
        masked_key: maskApiKey(newKey)
      },
      plain_api_key: newKey
    });
  } catch (error) {
    console.error('Error al rotar clave de integración:', error);
    return res.status(500).json({ error: 'Error interno al rotar la clave.' });
  }
};

/**
 * Activa o desactiva una clave de integración por comunidad.
 */
const toggleCommunityIntegrationStatus = async (req, res) => {
  try {
    await ensureIntegrationsTable();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de integración inválido.' });
    }

    const updatedRes = await db.query(
      `UPDATE country_integrations
       SET is_active = NOT is_active
       WHERE id = $1
       RETURNING id, country_id, label, api_key, is_active, last_used_at, created_at`,
      [id]
    );

    if (updatedRes.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada.' });
    }

    return res.status(200).json({
      message: `Integración ${updatedRes.rows[0].is_active ? 'activada' : 'desactivada'}.`,
      integration: {
        ...updatedRes.rows[0],
        masked_key: maskApiKey(updatedRes.rows[0].api_key)
      }
    });
  } catch (error) {
    console.error('Error al cambiar estado de integración:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la integración.' });
  }
};

/**
 * Lista los pases QR recientes en la plataforma con paginación, búsqueda y filtro de estado.
 * Persiste automáticamente el estado 'expired' en pases 'pending' vencidos antes de consultar.
 */
const listRecentPasses = async (req, res) => {
  try {
    await expireOverduePasses();

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
    const status = String(req.query.status || 'all').trim().toLowerCase();
    const search = String(req.query.search || '').trim();

    const conditions = [];
    const params = [];

    if (['pending', 'used', 'expired', 'cancelled'].includes(status)) {
      params.push(status);
      conditions.push(`ap.status = $${params.length}::pass_status`);
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(`(
        CAST(ap.id AS TEXT) ILIKE $${idx}
        OR CAST(ap.country_id AS TEXT) ILIKE $${idx}
        OR COALESCE(ap.fraction_number, '') ILIKE $${idx}
        OR COALESCE(ap.lot_number, '') ILIKE $${idx}
        OR COALESCE(c.name, '') ILIKE $${idx}
        OR COALESCE(u_prov.first_name, '') ILIKE $${idx}
        OR COALESCE(u_prov.last_name, '') ILIKE $${idx}
        OR COALESCE(p.specialty, '') ILIKE $${idx}
      )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM access_passes ap
      LEFT JOIN countries c ON ap.country_id = c.id
      LEFT JOIN providers p ON ap.provider_id = p.id
      LEFT JOIN users u_prov ON p.user_id = u_prov.id
      ${whereClause};
    `;
    const countRes = await db.query(countQuery, params);
    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    const dataQuery = `
      SELECT
        ap.id,
        ap.country_id,
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
      ${whereClause}
      ORDER BY ap.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2};
    `;

    const result = await db.query(dataQuery, [...params, limit, safeOffset]);

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
 * Cancela un pase QR por ID.
 */
const cancelPassById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const updated = await db.query(
      `UPDATE access_passes
       SET status = 'cancelled'::pass_status
       WHERE id = $1
       RETURNING id, status`,
      [id]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Pase no encontrado.' });
    }

    return res.status(200).json({
      message: 'Pase cancelado correctamente.',
      pass: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al cancelar pase:', error);
    return res.status(500).json({ error: 'Error interno al cancelar el pase.' });
  }
};

/**
 * Devuelve la auditoría de intentos de validación de acceso (autorizados vs. denegados
 * y su motivo) junto con el resumen y listado reciente de contratos y transacciones.
 * Uso exclusivo: rol 'superadmin'.
 */
const getAuditOverview = async (req, res) => {
  try {
    await Promise.all([ensureAuditLogsTable(), expireOverduePasses()]);

    const outcome = String(req.query.outcome || 'all').trim().toLowerCase();
    const search = String(req.query.search || '').trim();

    const logConditions = [];
    const logParams = [];

    if (outcome === 'authorized') {
      logConditions.push('gal.authorized = TRUE');
    } else if (outcome === 'denied') {
      logConditions.push('gal.authorized = FALSE');
    }

    if (search) {
      logParams.push(`%${search}%`);
      const idx = logParams.length;
      logConditions.push(`(
        COALESCE(gal.reason_code, '') ILIKE $${idx}
        OR COALESCE(gal.qr_token, '') ILIKE $${idx}
        OR COALESCE(gal.message, '') ILIKE $${idx}
        OR COALESCE(c.name, '') ILIKE $${idx}
        OR COALESCE(gal.integration_label, '') ILIKE $${idx}
      )`);
    }

    const logWhere = logConditions.length > 0 ? `WHERE ${logConditions.join(' AND ')}` : '';

    const accessLogsRes = await db.query(
      `SELECT
        gal.id,
        gal.qr_token,
        gal.pass_id,
        gal.country_id,
        c.name AS country_name,
        gal.integration_label,
        gal.auth_mode,
        gal.authorized,
        gal.reason_code,
        gal.message,
        gal.http_status,
        gal.created_at
       FROM gate_access_logs gal
       LEFT JOIN countries c ON c.id = gal.country_id
       ${logWhere}
       ORDER BY gal.id DESC
       LIMIT 20`,
      logParams
    );

    const logSummaryRes = await db.query(`
      SELECT
        COUNT(*)::int AS total_attempts,
        COUNT(*) FILTER (WHERE authorized = TRUE)::int AS authorized_count,
        COUNT(*) FILTER (WHERE authorized = FALSE)::int AS denied_count
      FROM gate_access_logs
    `);

    const txSummaryRes = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM service_contracts) AS total_contracts,
        (SELECT COUNT(*)::int FROM service_contracts WHERE status = 'pending') AS pending_contracts,
        (SELECT COUNT(*)::int FROM service_contracts WHERE status = 'completed') AS completed_contracts,
        (SELECT COUNT(*)::int FROM transactions) AS total_transactions,
        (SELECT COALESCE(SUM(total_amount), 0)::numeric(12,2) FROM transactions) AS gross_volume,
        (SELECT COALESCE(SUM(platform_fee), 0)::numeric(12,2) FROM transactions) AS platform_fees,
        (SELECT COALESCE(SUM(provider_payout), 0)::numeric(12,2) FROM transactions) AS provider_payouts
    `);

    const transactionsRes = await db.query(`
      SELECT
        t.id,
        t.contract_id,
        t.gateway_provider,
        t.gateway_payment_id,
        t.total_amount,
        t.platform_fee,
        t.provider_payout,
        t.status,
        t.created_at,
        sc.description AS contract_description,
        c.name AS country_name,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name
      FROM transactions t
      LEFT JOIN service_contracts sc ON sc.id = t.contract_id
      LEFT JOIN countries c ON c.id = sc.country_id
      LEFT JOIN providers p ON p.id = sc.provider_id
      LEFT JOIN users u_prov ON u_prov.id = p.user_id
      ORDER BY t.id DESC
      LIMIT 15
    `);

    return res.status(200).json({
      access_summary: logSummaryRes.rows[0] || {
        total_attempts: 0,
        authorized_count: 0,
        denied_count: 0
      },
      access_logs: accessLogsRes.rows,
      financial_summary: txSummaryRes.rows[0] || {
        total_contracts: 0,
        pending_contracts: 0,
        completed_contracts: 0,
        total_transactions: 0,
        gross_volume: '0.00',
        platform_fees: '0.00',
        provider_payouts: '0.00'
      },
      transactions: transactionsRes.rows
    });
  } catch (error) {
    console.error('Error al consultar auditoría de accesos y transacciones:', error);
    return res.status(500).json({
      error: 'Error interno al consultar la auditoría de accesos y transacciones.'
    });
  }
};

/**
 * Validación externa de pase QR mediante API Key de comunidad, API Key global o JWT.
 * Persiste 'expired' si el pase pendiente venció y registra cada intento en gate_access_logs.
 */
const verifyExternalPassByQR = async (req, res) => {
  const providedKey = String(req.headers['x-api-key'] || '').trim();
  const envKey = String(process.env.EXTERNAL_GATE_API_KEY || '').trim();
  const hasValidJwt = Boolean(
    req.user && ['admin', 'superadmin', 'security'].includes(req.user.role)
  );
  const qrToken = String(req.body?.qr_token || '').trim();
  const authMode = hasValidJwt ? 'jwt' : providedKey ? 'x-api-key' : 'none';

  try {
    await Promise.all([ensureIntegrationsTable(), ensureAuditLogsTable()]);

    let matchedIntegration = null;

    if (!hasValidJwt) {
      if (!providedKey) {
        const msg = 'Debe enviar x-api-key o un token Bearer autorizado.';
        await recordGateAccessLog({
          qrToken,
          authMode,
          authorized: false,
          reasonCode: 'MISSING_API_KEY',
          message: msg,
          httpStatus: 401
        });
        return res.status(401).json({
          authorized: false,
          code: 'MISSING_API_KEY',
          error: msg
        });
      }

      const keyLookup = await db.query(
        `SELECT ci.id, ci.country_id, ci.label, c.name AS country_name, c.is_active AS country_active
         FROM country_integrations ci
         INNER JOIN countries c ON c.id = ci.country_id
         WHERE ci.api_key = $1 AND ci.is_active = TRUE
         LIMIT 1`,
        [providedKey]
      );

      if (keyLookup.rows.length > 0) {
        matchedIntegration = keyLookup.rows[0];
        if (!matchedIntegration.country_active) {
          const msg = 'La comunidad asociada a esta clave de integración está inactiva.';
          await recordGateAccessLog({
            qrToken,
            countryId: matchedIntegration.country_id,
            integrationLabel: matchedIntegration.label,
            authMode,
            authorized: false,
            reasonCode: 'COUNTRY_INACTIVE',
            message: msg,
            httpStatus: 403
          });
          return res.status(403).json({
            authorized: false,
            code: 'COUNTRY_INACTIVE',
            error: msg
          });
        }
        await db.query(
          'UPDATE country_integrations SET last_used_at = NOW() WHERE id = $1',
          [matchedIntegration.id]
        );
      } else if (!envKey || providedKey !== envKey) {
        const msg = 'API Key externa inválida o inactiva.';
        await recordGateAccessLog({
          qrToken,
          authMode,
          authorized: false,
          reasonCode: 'INVALID_API_KEY',
          message: msg,
          httpStatus: 401
        });
        return res.status(401).json({
          authorized: false,
          code: 'INVALID_API_KEY',
          error: msg
        });
      }
    }

    const effectiveAuthMode = matchedIntegration
      ? 'community_api_key'
      : hasValidJwt
        ? 'jwt'
        : 'global_env_key';
    const effectiveIntegrationLabel = matchedIntegration
      ? matchedIntegration.label
      : hasValidJwt
        ? `JWT (${req.user.role})`
        : 'Global (.env)';

    if (!qrToken) {
      const msg = 'El campo qr_token es obligatorio.';
      await recordGateAccessLog({
        qrToken: null,
        countryId: matchedIntegration?.country_id || null,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'MISSING_QR_TOKEN',
        message: msg,
        httpStatus: 400
      });
      return res.status(400).json({
        authorized: false,
        code: 'MISSING_QR_TOKEN',
        error: msg
      });
    }

    const passQuery = await db.query(
      `SELECT
        ap.*,
        (EXTRACT(EPOCH FROM (ap.start_time AT TIME ZONE 'UTC')) * 1000)::bigint AS start_utc_ms,
        (EXTRACT(EPOCH FROM (ap.end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
        (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_utc_ms,
        c.name AS country_name,
        c.is_active AS country_active,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        p.id AS provider_profile_id,
        p.specialty,
        p.status AS compliance_status,
        p.rating_avg,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        u_prov.phone AS provider_phone,
        pv.vehicle_type,
        pv.brand AS vehicle_brand,
        pv.model AS vehicle_model,
        pv.color AS vehicle_color,
        pv.plate AS vehicle_plate
       FROM access_passes ap
       LEFT JOIN countries c ON c.id = ap.country_id
       LEFT JOIN users u_owner ON u_owner.id = ap.owner_id
       LEFT JOIN providers p ON p.id = ap.provider_id
       LEFT JOIN users u_prov ON u_prov.id = p.user_id
       LEFT JOIN provider_vehicles pv ON pv.provider_id = p.id
       WHERE ap.qr_token = $1
       ORDER BY pv.id DESC NULLS LAST
       LIMIT 1`,
      [qrToken]
    );

    if (passQuery.rows.length === 0) {
      const msg = 'Token QR inexistente.';
      await recordGateAccessLog({
        qrToken,
        countryId: matchedIntegration?.country_id || null,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'PASS_NOT_FOUND',
        message: msg,
        httpStatus: 404
      });
      return res.status(404).json({
        authorized: false,
        code: 'PASS_NOT_FOUND',
        error: msg
      });
    }

    let record = passQuery.rows[0];

    if (matchedIntegration && Number(record.country_id) !== Number(matchedIntegration.country_id)) {
      const msg = `Este pase pertenece a ${record.country_name || 'otra comunidad'}, no a ${matchedIntegration.country_name}.`;
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: matchedIntegration.country_id,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'COUNTRY_MISMATCH',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'COUNTRY_MISMATCH',
        error: msg
      });
    }

    if (record.status === 'cancelled') {
      const msg = 'El pase QR fue cancelado.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'PASS_CANCELLED',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_CANCELLED',
        error: msg
      });
    }

    const startMs = record.start_utc_ms !== null && record.start_utc_ms !== undefined
      ? Number(record.start_utc_ms)
      : null;
    const endMs = record.end_utc_ms !== null && record.end_utc_ms !== undefined
      ? Number(record.end_utc_ms)
      : null;
    const nowMs = record.now_utc_ms !== null && record.now_utc_ms !== undefined
      ? Number(record.now_utc_ms)
      : Date.now();

    if (startMs !== null && !Number.isNaN(startMs) && nowMs < startMs) {
      const msg = 'El pase aún no está dentro de su franja horaria habilitada.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'BEFORE_TIME_WINDOW',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'BEFORE_TIME_WINDOW',
        error: msg
      });
    }

    if (endMs !== null && !Number.isNaN(endMs) && nowMs > endMs) {
      if (record.status === 'pending') {
        await expireOverduePasses(record.id);
        record = { ...record, status: 'expired' };
      }

      const msg = 'El pase QR se encuentra vencido / fuera de vigencia horaria.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'OUT_OF_TIME_WINDOW',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'OUT_OF_TIME_WINDOW',
        pass_status: record.status,
        error: msg
      });
    }

    if (record.status === 'expired') {
      const msg = 'El pase QR se encuentra vencido.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'PASS_EXPIRED',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_EXPIRED',
        pass_status: record.status,
        error: msg
      });
    }

    if (record.compliance_status && record.compliance_status !== 'approved') {
      const msg = `El prestador no posee compliance aprobado (estado actual: ${record.compliance_status}).`;
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: effectiveIntegrationLabel,
        authMode: effectiveAuthMode,
        authorized: false,
        reasonCode: 'COMPLIANCE_NOT_APPROVED',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'COMPLIANCE_NOT_APPROVED',
        error: msg
      });
    }

    const grantedMsg = 'Acceso autorizado para ingreso perimetral.';
    await recordGateAccessLog({
      qrToken,
      passId: record.id,
      countryId: record.country_id,
      integrationLabel: effectiveIntegrationLabel,
      authMode: effectiveAuthMode,
      authorized: true,
      reasonCode: 'ACCESS_GRANTED',
      message: grantedMsg,
      httpStatus: 200
    });

    return res.status(200).json({
      authorized: true,
      code: 'ACCESS_GRANTED',
      message: grantedMsg,
      integration: matchedIntegration
        ? { id: matchedIntegration.id, label: matchedIntegration.label }
        : { mode: hasValidJwt ? 'jwt' : 'global_env_key' },
      country: {
        id: record.country_id,
        name: record.country_name
      },
      pass: {
        id: record.id,
        status: record.status,
        fraction_number: record.fraction_number,
        lot_number: record.lot_number,
        authorized_by: `${record.owner_first_name || ''} ${record.owner_last_name || ''}`.trim() || 'Residente',
        start_time: record.start_time,
        end_time: record.end_time
      },
      provider: {
        id: record.provider_profile_id,
        first_name: record.provider_first_name,
        last_name: record.provider_last_name,
        dni: record.provider_dni,
        phone: record.provider_phone,
        specialty: record.specialty,
        compliance_status: record.compliance_status,
        rating_avg: record.rating_avg
      },
      vehicle: record.vehicle_plate
        ? {
            vehicle_type: record.vehicle_type,
            brand: record.vehicle_brand,
            model: record.vehicle_model,
            color: record.vehicle_color,
            plate: record.vehicle_plate
          }
        : null
    });
  } catch (error) {
    console.error('Error en validación externa de pase QR:', error);
    const errMsg = 'Error interno al validar el pase QR.';
    await recordGateAccessLog({
      qrToken,
      integrationLabel: 'Sistema',
      authMode,
      authorized: false,
      reasonCode: 'INTERNAL_SERVER_ERROR',
      message: errMsg,
      httpStatus: 500
    });
    return res.status(500).json({
      authorized: false,
      code: 'INTERNAL_SERVER_ERROR',
      error: errMsg
    });
  }
};

module.exports = {
  getExternalDiagnostics,
  listCountries,
  createCountry,
  updateCountry,
  toggleCountryStatus,
  listCommunityIntegrations,
  createCommunityIntegration,
  rotateCommunityIntegrationKey,
  toggleCommunityIntegrationStatus,
  listRecentPasses,
  cancelPassById,
  getAuditOverview,
  verifyExternalPassByQR
};