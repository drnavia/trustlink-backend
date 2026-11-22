/**
 * @file external.controller.js
 * @description Controlador para integración externa de barrios privados (validación de QR),
 * diagnóstico técnico del sistema, gestión de pases QR con persistencia de estado 'expired',
 * administración de comunidades (con migración idempotente de columnas), integraciones por comunidad
 * y auditoría tolerante de accesos y transacciones.
 * @location /trustlink-backend/src/modules/external/external.controller.js
 */

const crypto = require('crypto');
const db = require('../../config/db');

/**
 * Asegura de forma idempotente que la tabla `countries` cuente con las columnas
 * address, postal_code, city y province (migrando datos desde locality/location si existen).
 */
const ensureCountriesColumns = async () => {
  await db.query(`
    ALTER TABLE countries
      ADD COLUMN IF NOT EXISTS address VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30) NULL,
      ADD COLUMN IF NOT EXISTS city VARCHAR(120) NULL,
      ADD COLUMN IF NOT EXISTS province VARCHAR(120) NULL;
  `);

  const colsRes = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'countries'
  `);
  const cols = new Set(colsRes.rows.map((r) => r.column_name));

  if (cols.has('locality')) {
    await db.query(`
      UPDATE countries
      SET city = COALESCE(city, locality)
      WHERE city IS NULL AND locality IS NOT NULL;
    `);
  }

  if (cols.has('location')) {
    await db.query(`
      UPDATE countries
      SET city = COALESCE(city, location)
      WHERE city IS NULL AND location IS NOT NULL;
    `);
  }
};

/**
 * Asegura la existencia de la tabla country_integrations de forma idempotente.
 */
const ensureIntegrationsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS country_integrations (
      id SERIAL PRIMARY KEY,
      country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
      label VARCHAR(120) NOT NULL,
      api_key_hash VARCHAR(128) NOT NULL,
      api_key_prefix VARCHAR(24) NOT NULL,
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
 * Persiste en PostgreSQL el estado 'expired'::pass_status para pases en estado 'pending'
 * cuya end_time (almacenada en UTC sin zona horaria) ya superó el instante actual (NOW()).
 * @param {number|null} passId
 */
const expireOverduePasses = async (passId = null) => {
  try {
    if (passId !== null && passId !== undefined) {
      await db.query(
        `
          UPDATE access_passes
          SET status = 'expired'::pass_status
          WHERE id = $1
            AND status = 'pending'::pass_status
            AND end_time IS NOT NULL
            AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
        `,
        [passId]
      );
      return;
    }

    await db.query(`
      UPDATE access_passes
      SET status = 'expired'::pass_status
      WHERE status = 'pending'::pass_status
        AND end_time IS NOT NULL
        AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
    `);
  } catch (err) {
    console.error('Error al persistir pases vencidos (expired):', err);
  }
};

const hashApiKey = (rawKey) =>
  crypto.createHash('sha256').update(String(rawKey).trim()).digest('hex');

const maskToken = (token) => {
  if (!token) return null;
  const clean = String(token).trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 8)}...${clean.slice(-6)}`;
};

/**
 * Registra un evento de validación de pase QR en gate_access_logs.
 */
const recordGateAccessLog = async ({
  qrToken,
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
    await db.query(
      `
        INSERT INTO gate_access_logs (
          qr_token,
          pass_id,
          country_id,
          integration_label,
          auth_mode,
          authorized,
          reason_code,
          message,
          http_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        maskToken(qrToken),
        passId,
        countryId,
        integrationLabel,
        authMode,
        authorized,
        reasonCode,
        message,
        httpStatus
      ]
    );
  } catch (err) {
    console.error('Error al registrar auditoría en gate_access_logs:', err);
  }
};

/**
 * Autentica la llamada externa mediante API key por comunidad (country_integrations)
 * o clave global de respaldo (EXTERNAL_GATE_API_KEY), o bien vía JWT interno.
 */
const resolveExternalAuth = async (req) => {
  const providedKey = String(req.headers['x-api-key'] || '').trim();
  const envKey = String(process.env.EXTERNAL_GATE_API_KEY || '').trim();
  const hasValidJwt = Boolean(
    req.user && ['admin', 'superadmin', 'security'].includes(req.user.role)
  );

  if (providedKey) {
    await ensureIntegrationsTable();
    const keyHash = hashApiKey(providedKey);
    const integrationRes = await db.query(
      `
        SELECT
          ci.id,
          ci.country_id,
          ci.label,
          ci.is_active,
          c.name AS country_name,
          c.is_active AS country_is_active
        FROM country_integrations ci
        JOIN countries c ON ci.country_id = c.id
        WHERE ci.api_key_hash = $1
        LIMIT 1
      `,
      [keyHash]
    );

    if (integrationRes.rows.length > 0) {
      const integ = integrationRes.rows[0];
      if (!integ.is_active) {
        return {
          ok: false,
          status: 403,
          code: 'INTEGRATION_INACTIVE',
          error: 'La clave API de la comunidad se encuentra revocada o inactiva.',
          authMode: 'community_api_key',
          countryId: integ.country_id,
          integrationLabel: integ.label
        };
      }
      if (!integ.country_is_active) {
        return {
          ok: false,
          status: 403,
          code: 'COUNTRY_INACTIVE',
          error: 'La comunidad asociada a la clave API se encuentra inactiva.',
          authMode: 'community_api_key',
          countryId: integ.country_id,
          integrationLabel: integ.label
        };
      }

      await db.query(
        'UPDATE country_integrations SET last_used_at = NOW() WHERE id = $1',
        [integ.id]
      );

      return {
        ok: true,
        authMode: 'community_api_key',
        countryId: integ.country_id,
        integrationLabel: integ.label
      };
    }

    if (envKey && providedKey === envKey) {
      return {
        ok: true,
        authMode: 'env_api_key',
        countryId: null,
        integrationLabel: 'Clave Global (ENV)'
      };
    }

    return {
      ok: false,
      status: 401,
      code: 'INVALID_API_KEY',
      error: 'API Key externa inválida o no reconocida.',
      authMode: 'api_key',
      countryId: null,
      integrationLabel: null
    };
  }

  if (hasValidJwt) {
    return {
      ok: true,
      authMode: 'jwt',
      countryId: null,
      integrationLabel: `Sesión ${req.user.role}`
    };
  }

  return {
    ok: false,
    status: 401,
    code: 'MISSING_API_KEY',
    error: 'Debe enviar un encabezado x-api-key válido o autenticarse con un rol autorizado.',
    authMode: 'none',
    countryId: null,
    integrationLabel: null
  };
};

/**
 * Diagnóstico técnico del backend, base de datos y endpoint externo.
 * Uso exclusivo: rol 'superadmin'.
 */
const getExternalDiagnostics = async (req, res) => {
  const startedAt = Date.now();
  try {
    await Promise.all([
      ensureCountriesColumns(),
      ensureIntegrationsTable(),
      ensureAuditLogsTable(),
      expireOverduePasses()
    ]);

    const dbCheck = await db.query('SELECT NOW() AS db_time');
    const dbLatencyMs = Date.now() - startedAt;

    const metricsCheck = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM access_passes) AS total_passes,
        (SELECT COUNT(*)::int FROM access_passes WHERE status = 'pending'::pass_status) AS pending_passes,
        (SELECT COUNT(*)::int FROM access_passes WHERE status = 'used'::pass_status) AS used_passes,
        (SELECT COUNT(*)::int FROM access_passes WHERE status = 'expired'::pass_status) AS expired_passes,
        (SELECT COUNT(*)::int FROM access_passes WHERE status = 'cancelled'::pass_status) AS cancelled_passes,
        (SELECT COUNT(*)::int FROM providers WHERE status = 'approved'::provider_status) AS approved_providers,
        (SELECT COUNT(*)::int FROM countries) AS total_countries,
        (SELECT COUNT(*)::int FROM countries WHERE is_active = TRUE) AS active_countries,
        (SELECT COUNT(*)::int FROM country_integrations WHERE is_active = TRUE) AS active_integrations,
        (SELECT COUNT(*)::int FROM gate_access_logs) AS total_access_logs
    `);

    const envKey = String(process.env.EXTERNAL_GATE_API_KEY || '').trim();

    return res.status(200).json({
      status: 'healthy',
      service: 'trustlink-backend',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      database: {
        connected: true,
        latency_ms: dbLatencyMs,
        server_time: dbCheck.rows[0]?.db_time || null
      },
      external_endpoint: {
        route: '/api/v1/external/passes/verify',
        method: 'POST',
        env_api_key_configured: Boolean(envKey),
        supports_community_api_keys: true,
        supports_jwt_roles: ['admin', 'superadmin', 'security']
      },
      metrics: metricsCheck.rows[0] || {}
    });
  } catch (error) {
    console.error('Error en diagnóstico externo:', error);
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
        env_api_key_configured: Boolean(
          process.env.EXTERNAL_GATE_API_KEY &&
            String(process.env.EXTERNAL_GATE_API_KEY).trim()
        )
      },
      error: 'Error al consultar la base de datos o el estado del servicio.'
    });
  }
};

/**
 * Lista comunidades (countries) con paginación, filtro de estado y búsqueda.
 */
const listCountries = async (req, res) => {
  try {
    await Promise.all([ensureCountriesColumns(), ensureIntegrationsTable()]);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 4, 1), 100);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all').trim().toLowerCase();

    const conditions = [];
    const params = [];

    if (status === 'active') {
      conditions.push('c.is_active = TRUE');
    } else if (status === 'inactive') {
      conditions.push('c.is_active = FALSE');
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(
        `(c.name ILIKE $${idx} OR COALESCE(c.city, '') ILIKE $${idx} OR COALESCE(c.province, '') ILIKE $${idx} OR COALESCE(c.address, '') ILIKE $${idx} OR COALESCE(c.postal_code, '') ILIKE $${idx})`
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM countries c ${whereClause}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    const listParams = [...params, limit, safeOffset];
    const result = await db.query(
      `
        SELECT
          c.id,
          c.name,
          c.address,
          c.postal_code,
          c.city,
          c.province,
          c.is_active,
          c.created_at,
          (SELECT COUNT(*)::int FROM country_integrations ci WHERE ci.country_id = c.id AND ci.is_active = TRUE) AS active_keys_count
        FROM countries c
        ${whereClause}
        ORDER BY c.id ASC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.status(200).json({
      countries: result.rows,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error al listar comunidades:', error);
    return res.status(500).json({
      error: `Error al obtener las comunidades: ${error.message}`
    });
  }
};

/**
 * Crea una nueva comunidad (country).
 */
const createCountry = async (req, res) => {
  try {
    await ensureCountriesColumns();

    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    const postalCode = String(req.body?.postal_code || '').trim();
    const city = String(req.body?.city || '').trim();
    const province = String(req.body?.province || '').trim();
    const isActive = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : true;

    if (!name) {
      return res.status(400).json({ error: 'El nombre de la comunidad es obligatorio.' });
    }

    const colsRes = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'countries'
    `);
    const cols = new Set(colsRes.rows.map((r) => r.column_name));

    const locationText = [address, city, province, postalCode].filter(Boolean).join(', ') || null;

    if (cols.has('location')) {
      const result = await db.query(
        `
          INSERT INTO countries (name, location, address, postal_code, city, province, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, name, address, postal_code, city, province, is_active, created_at
        `,
        [name, locationText, address || null, postalCode || null, city || null, province || null, isActive]
      );
      return res.status(201).json({
        message: 'Comunidad creada correctamente.',
        country: result.rows[0]
      });
    }

    const result = await db.query(
      `
        INSERT INTO countries (name, address, postal_code, city, province, is_active)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, address, postal_code, city, province, is_active, created_at
      `,
      [name, address || null, postalCode || null, city || null, province || null, isActive]
    );

    return res.status(201).json({
      message: 'Comunidad creada correctamente.',
      country: result.rows[0]
    });
  } catch (error) {
    console.error('Error al crear comunidad:', error);
    return res.status(500).json({ error: 'Error al crear la comunidad en la base de datos.' });
  }
};

/**
 * Actualiza los datos de una comunidad existente.
 */
const updateCountry = async (req, res) => {
  try {
    await ensureCountriesColumns();

    const countryId = parseInt(req.params.id, 10);
    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existing = await db.query('SELECT * FROM countries WHERE id = $1', [countryId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    const current = existing.rows[0];
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : current.name;
    if (!name) {
      return res.status(400).json({ error: 'El nombre de la comunidad no puede quedar vacío.' });
    }

    const address =
      req.body?.address !== undefined ? String(req.body.address).trim() || null : current.address;
    const postalCode =
      req.body?.postal_code !== undefined
        ? String(req.body.postal_code).trim() || null
        : current.postal_code;
    const city = req.body?.city !== undefined ? String(req.body.city).trim() || null : current.city;
    const province =
      req.body?.province !== undefined
        ? String(req.body.province).trim() || null
        : current.province;

    const updated = await db.query(
      `
        UPDATE countries
        SET name = $1,
            address = $2,
            postal_code = $3,
            city = $4,
            province = $5
        WHERE id = $6
        RETURNING id, name, address, postal_code, city, province, is_active, created_at
      `,
      [name, address, postalCode, city, province, countryId]
    );

    return res.status(200).json({
      message: 'Comunidad actualizada correctamente.',
      country: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar comunidad:', error);
    return res.status(500).json({ error: 'Error al actualizar la comunidad.' });
  }
};

/**
 * Activa o desactiva una comunidad.
 */
const toggleCountryStatus = async (req, res) => {
  try {
    const countryId = parseInt(req.params.id, 10);
    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existing = await db.query('SELECT id, is_active FROM countries WHERE id = $1', [countryId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    const nextActive =
      typeof req.body?.is_active === 'boolean' ? req.body.is_active : !existing.rows[0].is_active;

    const updated = await db.query(
      `
        UPDATE countries
        SET is_active = $1
        WHERE id = $2
        RETURNING id, name, address, postal_code, city, province, is_active, created_at
      `,
      [nextActive, countryId]
    );

    return res.status(200).json({
      message: `Comunidad ${nextActive ? 'activada' : 'desactivada'} correctamente.`,
      country: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al cambiar estado de comunidad:', error);
    return res.status(500).json({ error: 'Error al actualizar el estado de la comunidad.' });
  }
};

/**
 * Lista claves API de integración por comunidad (con paginación y filtro por comunidad).
 */
const listCommunityIntegrations = async (req, res) => {
  try {
    await ensureIntegrationsTable();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 50);
    const countryIdParam = req.query.country_id ? parseInt(req.query.country_id, 10) : null;

    const conditions = [];
    const params = [];

    if (countryIdParam && !Number.isNaN(countryIdParam)) {
      params.push(countryIdParam);
      conditions.push(`ci.country_id = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM country_integrations ci ${whereClause}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    const listParams = [...params, limit, safeOffset];
    const result = await db.query(
      `
        SELECT
          ci.id,
          ci.country_id,
          c.name AS country_name,
          ci.label,
          ci.api_key_prefix,
          ci.is_active,
          ci.last_used_at,
          ci.created_at
        FROM country_integrations ci
        JOIN countries c ON ci.country_id = c.id
        ${whereClause}
        ORDER BY ci.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.status(200).json({
      integrations: result.rows,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error al listar integraciones por comunidad:', error);
    return res.status(500).json({ error: 'Error al obtener las claves de integración.' });
  }
};

/**
 * Crea una nueva clave API para una comunidad. Devuelve el secreto en texto plano una sola vez.
 */
const createCommunityIntegration = async (req, res) => {
  try {
    await ensureIntegrationsTable();
    const countryId = parseInt(req.body?.country_id, 10);
    const label = String(req.body?.label || '').trim() || 'Garita Principal';

    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'Debe seleccionar una comunidad válida.' });
    }

    const countryRes = await db.query('SELECT id, name FROM countries WHERE id = $1', [countryId]);
    if (countryRes.rows.length === 0) {
      return res.status(404).json({ error: 'La comunidad indicada no existe.' });
    }

    const rawApiKey = `tlk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = hashApiKey(rawApiKey);
    const prefix = `${rawApiKey.slice(0, 14)}...${rawApiKey.slice(-4)}`;

    const insertRes = await db.query(
      `
        INSERT INTO country_integrations (country_id, label, api_key_hash, api_key_prefix, is_active)
        VALUES ($1, $2, $3, $4, TRUE)
        RETURNING id, country_id, label, api_key_prefix, is_active, last_used_at, created_at
      `,
      [countryId, label, keyHash, prefix]
    );

    return res.status(201).json({
      message: 'Clave API generada para la comunidad. Cópiela ahora; no se volverá a mostrar completa.',
      api_key: rawApiKey,
      integration: {
        ...insertRes.rows[0],
        country_name: countryRes.rows[0].name
      }
    });
  } catch (error) {
    console.error('Error al crear integración de comunidad:', error);
    return res.status(500).json({ error: 'Error al generar la clave API de la comunidad.' });
  }
};

/**
 * Rota la clave API de una integración existente y devuelve el nuevo secreto una sola vez.
 */
const rotateCommunityIntegrationKey = async (req, res) => {
  try {
    await ensureIntegrationsTable();
    const integrationId = parseInt(req.params.id, 10);
    if (Number.isNaN(integrationId)) {
      return res.status(400).json({ error: 'ID de integración inválido.' });
    }

    const existing = await db.query(
      `
        SELECT ci.id, ci.country_id, ci.label, c.name AS country_name
        FROM country_integrations ci
        JOIN countries c ON ci.country_id = c.id
        WHERE ci.id = $1
      `,
      [integrationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada.' });
    }

    const rawApiKey = `tlk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = hashApiKey(rawApiKey);
    const prefix = `${rawApiKey.slice(0, 14)}...${rawApiKey.slice(-4)}`;

    const updated = await db.query(
      `
        UPDATE country_integrations
        SET api_key_hash = $1,
            api_key_prefix = $2,
            is_active = TRUE
        WHERE id = $3
        RETURNING id, country_id, label, api_key_prefix, is_active, last_used_at, created_at
      `,
      [keyHash, prefix, integrationId]
    );

    return res.status(200).json({
      message: 'Clave API rotada correctamente. Cópiela ahora; la clave anterior quedó invalidada.',
      api_key: rawApiKey,
      integration: {
        ...updated.rows[0],
        country_name: existing.rows[0].country_name
      }
    });
  } catch (error) {
    console.error('Error al rotar clave API:', error);
    return res.status(500).json({ error: 'Error al rotar la clave API.' });
  }
};

/**
 * Activa o revoca una clave API de comunidad.
 */
const toggleCommunityIntegrationStatus = async (req, res) => {
  try {
    await ensureIntegrationsTable();
    const integrationId = parseInt(req.params.id, 10);
    if (Number.isNaN(integrationId)) {
      return res.status(400).json({ error: 'ID de integración inválido.' });
    }

    const existing = await db.query(
      'SELECT id, is_active FROM country_integrations WHERE id = $1',
      [integrationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada.' });
    }

    const nextActive =
      typeof req.body?.is_active === 'boolean'
        ? req.body.is_active
        : !existing.rows[0].is_active;

    const updated = await db.query(
      `
        UPDATE country_integrations
        SET is_active = $1
        WHERE id = $2
        RETURNING id, country_id, label, api_key_prefix, is_active, last_used_at, created_at
      `,
      [nextActive, integrationId]
    );

    return res.status(200).json({
      message: `Clave API ${nextActive ? 'reactivada' : 'revocada'} correctamente.`,
      integration: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al cambiar estado de clave API:', error);
    return res.status(500).json({ error: 'Error al actualizar la clave API.' });
  }
};

/**
 * Lista los pases QR recientes persistiendo 'expired' si venció su ventana horaria en UTC,
 * y exponiendo start_utc_ms / end_utc_ms para formateo exacto en la zona del usuario.
 */
const listRecentPasses = async (req, res) => {
  try {
    await expireOverduePasses();

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 50);
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
      conditions.push(
        `(ap.qr_token ILIKE $${idx} OR COALESCE(u_prov.first_name, '') ILIKE $${idx} OR COALESCE(u_prov.last_name, '') ILIKE $${idx} OR COALESCE(p.specialty, '') ILIKE $${idx} OR COALESCE(c.name, '') ILIKE $${idx} OR COALESCE(ap.fraction_number, '') ILIKE $${idx} OR COALESCE(ap.lot_number, '') ILIKE $${idx})`
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.query(
      `
        SELECT COUNT(*)::int AS total
        FROM access_passes ap
        LEFT JOIN providers p ON ap.provider_id = p.id
        LEFT JOIN users u_prov ON p.user_id = u_prov.id
        LEFT JOIN countries c ON ap.country_id = c.id
        ${whereClause}
      `,
      params
    );

    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    const listParams = [...params, limit, safeOffset];
    const result = await db.query(
      `
        SELECT
          ap.id,
          ap.country_id,
          c.name AS country_name,
          ap.owner_id,
          TRIM(CONCAT(COALESCE(u_own.first_name, ''), ' ', COALESCE(u_own.last_name, ''))) AS owner_name,
          ap.provider_id,
          TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
          p.specialty,
          ap.fraction_number,
          ap.lot_number,
          ap.qr_token,
          ap.start_time,
          ap.end_time,
          (EXTRACT(EPOCH FROM (ap.start_time AT TIME ZONE 'UTC')) * 1000)::bigint AS start_utc_ms,
          (EXTRACT(EPOCH FROM (ap.end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
          ap.status,
          ap.created_at
        FROM access_passes ap
        LEFT JOIN users u_own ON ap.owner_id = u_own.id
        LEFT JOIN providers p ON ap.provider_id = p.id
        LEFT JOIN users u_prov ON p.user_id = u_prov.id
        LEFT JOIN countries c ON ap.country_id = c.id
        ${whereClause}
        ORDER BY ap.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.status(200).json({
      passes: result.rows,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error al listar pases QR recientes:', error);
    return res.status(500).json({ error: 'Error al obtener los pases QR recientes.' });
  }
};

/**
 * Cancela un pase QR pendiente cambiando su estado a 'cancelled' en PostgreSQL.
 */
const cancelPassById = async (req, res) => {
  try {
    const passId = parseInt(req.params.id, 10);
    if (Number.isNaN(passId)) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const passRes = await db.query('SELECT id, status FROM access_passes WHERE id = $1', [passId]);
    if (passRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    const currentStatus = passRes.rows[0].status;
    if (currentStatus !== 'pending') {
      return res.status(400).json({
        error: `No se puede cancelar un pase en estado '${currentStatus}'.`
      });
    }

    const updated = await db.query(
      `
        UPDATE access_passes
        SET status = 'cancelled'::pass_status
        WHERE id = $1
        RETURNING id, status
      `,
      [passId]
    );

    return res.status(200).json({
      message: `Pase QR #${passId} cancelado con éxito.`,
      pass: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al cancelar pase QR:', error);
    return res.status(500).json({ error: 'Error al cancelar el pase QR.' });
  }
};

/**
 * Consulta de forma segura el resumen y listado reciente de transacciones
 * adaptándose dinámicamente a las columnas reales de la tabla `transactions`.
 */
const fetchTransactionsAuditSafe = async () => {
  const defaultSummary = {
    total_transactions: 0,
    gross_volume: 0,
    platform_fee_total: 0,
    provider_payout_total: 0
  };

  try {
    const colsRes = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions'
    `);
    const cols = new Set(colsRes.rows.map((r) => r.column_name));
    if (cols.size === 0) {
      return { summary: defaultSummary, recent: [] };
    }

    const grossCol = cols.has('gross_amount')
      ? 't.gross_amount'
      : cols.has('amount')
      ? 't.amount'
      : cols.has('total_amount')
      ? 't.total_amount'
      : '0';

    const feeCol = cols.has('platform_fee')
      ? 't.platform_fee'
      : cols.has('commission_fee')
      ? 't.commission_fee'
      : cols.has('fee_amount')
      ? 't.fee_amount'
      : `ROUND((${grossCol} * 0.07)::numeric, 2)`;

    const payoutCol = cols.has('provider_payout')
      ? 't.provider_payout'
      : cols.has('net_amount')
      ? 't.net_amount'
      : cols.has('provider_amount')
      ? 't.provider_amount'
      : `ROUND((${grossCol} - (${feeCol}))::numeric, 2)`;

    const statusCol = cols.has('status')
      ? 't.status::text'
      : cols.has('payment_status')
      ? 't.payment_status::text'
      : `'completed'`;

    const contractCol = cols.has('contract_id') ? 't.contract_id' : 'NULL';
    const orderCol = cols.has('id') ? 't.id DESC' : '1';

    const summaryRes = await db.query(`
      SELECT
        COUNT(*)::int AS total_transactions,
        COALESCE(SUM(${grossCol}), 0)::numeric(12,2) AS gross_volume,
        COALESCE(SUM(${feeCol}), 0)::numeric(12,2) AS platform_fee_total,
        COALESCE(SUM(${payoutCol}), 0)::numeric(12,2) AS provider_payout_total
      FROM transactions t
    `);

    const joinContracts = cols.has('contract_id')
      ? `
        LEFT JOIN service_contracts sc ON t.contract_id = sc.id
        LEFT JOIN providers p ON sc.provider_id = p.id
        LEFT JOIN users u_prov ON p.user_id = u_prov.id
        LEFT JOIN countries c ON sc.country_id = c.id
      `
      : '';

    const providerSelect = cols.has('contract_id')
      ? `TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name, c.name AS country_name`
      : `NULL AS provider_name, NULL AS country_name`;

    const recentRes = await db.query(`
      SELECT
        ${cols.has('id') ? 't.id' : 'ROW_NUMBER() OVER () AS id'},
        ${contractCol} AS contract_id,
        COALESCE(${grossCol}, 0)::numeric(12,2) AS gross_amount,
        COALESCE(${feeCol}, 0)::numeric(12,2) AS platform_fee,
        COALESCE(${payoutCol}, 0)::numeric(12,2) AS provider_payout,
        ${statusCol} AS status,
        ${providerSelect}
      FROM transactions t
      ${joinContracts}
      ORDER BY ${orderCol}
      LIMIT 6
    `);

    return {
      summary: summaryRes.rows[0] || defaultSummary,
      recent: recentRes.rows
    };
  } catch (txErr) {
    console.error('Aviso al consultar resumen de transacciones en auditoría:', txErr);
    return { summary: defaultSummary, recent: [] };
  }
};

/**
 * Obtiene bitácora paginada de intentos de validación de acceso en garita/API externa
 * y resumen de transacciones / comisiones (Take Rate) en PostgreSQL.
 */
const getAuditOverview = async (req, res) => {
  try {
    await Promise.all([
      ensureIntegrationsTable(),
      ensureAuditLogsTable(),
      expireOverduePasses()
    ]);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
    const outcome = String(req.query.outcome || 'all').trim().toLowerCase();
    const search = String(req.query.search || '').trim();

    const conditions = [];
    const params = [];

    if (outcome === 'authorized') {
      conditions.push('gal.authorized = TRUE');
    } else if (outcome === 'denied') {
      conditions.push('gal.authorized = FALSE');
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(
        `(COALESCE(gal.qr_token, '') ILIKE $${idx} OR COALESCE(gal.reason_code, '') ILIKE $${idx} OR COALESCE(gal.message, '') ILIKE $${idx} OR COALESCE(gal.integration_label, '') ILIKE $${idx} OR COALESCE(c.name, '') ILIKE $${idx})`
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const summaryRes = await db.query(`
      SELECT
        COUNT(*)::int AS total_attempts,
        COUNT(*) FILTER (WHERE authorized = TRUE)::int AS authorized_count,
        COUNT(*) FILTER (WHERE authorized = FALSE)::int AS denied_count
      FROM gate_access_logs
    `);

    const countRes = await db.query(
      `
        SELECT COUNT(*)::int AS total
        FROM gate_access_logs gal
        LEFT JOIN countries c ON gal.country_id = c.id
        ${whereClause}
      `,
      params
    );

    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    const logsParams = [...params, limit, safeOffset];
    const logsRes = await db.query(
      `
        SELECT
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
        LEFT JOIN countries c ON gal.country_id = c.id
        ${whereClause}
        ORDER BY gal.id DESC
        LIMIT $${logsParams.length - 1} OFFSET $${logsParams.length}
      `,
      logsParams
    );

    const txAudit = await fetchTransactionsAuditSafe();

    return res.status(200).json({
      access_summary: summaryRes.rows[0] || {
        total_attempts: 0,
        authorized_count: 0,
        denied_count: 0
      },
      access_logs: logsRes.rows,
      access_pagination: {
        page: safePage,
        limit,
        total,
        totalPages
      },
      transactions_summary: txAudit.summary,
      recent_transactions: txAudit.recent
    });
  } catch (error) {
    console.error('Error al obtener auditoría de accesos y transacciones:', error);
    return res.status(500).json({
      error: `Error al cargar la auditoría del sistema: ${error.message}`
    });
  }
};

/**
 * Valida un pase QR en tiempo real para garitas o sistemas externos de barrios privados.
 */
const verifyExternalPassByQR = async (req, res) => {
  await Promise.all([ensureIntegrationsTable(), ensureAuditLogsTable()]);

  const auth = await resolveExternalAuth(req);
  const qrToken = String(req.body?.qr_token || '').trim();
  const requestedCountryId =
    req.body?.country_id !== undefined && req.body?.country_id !== null
      ? parseInt(req.body.country_id, 10)
      : null;

  if (!auth.ok) {
    await recordGateAccessLog({
      qrToken,
      countryId: auth.countryId,
      integrationLabel: auth.integrationLabel,
      authMode: auth.authMode,
      authorized: false,
      reasonCode: auth.code,
      message: auth.error,
      httpStatus: auth.status
    });
    return res.status(auth.status).json({
      authorized: false,
      code: auth.code,
      error: auth.error
    });
  }

  if (!qrToken) {
    const msg = 'Debe proporcionar el token QR (qr_token) para validar el acceso.';
    await recordGateAccessLog({
      qrToken,
      countryId: auth.countryId || requestedCountryId,
      integrationLabel: auth.integrationLabel,
      authMode: auth.authMode,
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

  try {
    const passRes = await db.query(
      `
        SELECT
          ap.id,
          ap.country_id,
          c.name AS country_name,
          ap.owner_id,
          TRIM(CONCAT(COALESCE(u_own.first_name, ''), ' ', COALESCE(u_own.last_name, ''))) AS owner_name,
          ap.provider_id,
          TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
          u_prov.dni AS provider_dni,
          p.specialty,
          p.status AS compliance_status,
          ap.fraction_number,
          ap.lot_number,
          ap.start_time,
          ap.end_time,
          (EXTRACT(EPOCH FROM (ap.start_time AT TIME ZONE 'UTC')) * 1000)::bigint AS start_utc_ms,
          (EXTRACT(EPOCH FROM (ap.end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
          (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_utc_ms,
          ap.status
        FROM access_passes ap
        LEFT JOIN countries c ON ap.country_id = c.id
        LEFT JOIN users u_own ON ap.owner_id = u_own.id
        LEFT JOIN providers p ON ap.provider_id = p.id
        LEFT JOIN users u_prov ON p.user_id = u_prov.id
        WHERE ap.qr_token = $1
        LIMIT 1
      `,
      [qrToken]
    );

    if (passRes.rows.length === 0) {
      const msg = 'El token QR indicado no corresponde a ningún pase registrado.';
      await recordGateAccessLog({
        qrToken,
        countryId: auth.countryId || requestedCountryId,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
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

    let record = passRes.rows[0];
    const effectiveCountryId = auth.countryId || requestedCountryId;

    if (
      effectiveCountryId &&
      !Number.isNaN(effectiveCountryId) &&
      Number(record.country_id) !== Number(effectiveCountryId)
    ) {
      const msg = 'El pase QR pertenece a una comunidad distinta a la de la clave/solicitud.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
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

    const startMs =
      record.start_utc_ms !== null && record.start_utc_ms !== undefined
        ? Number(record.start_utc_ms)
        : null;
    const endMs =
      record.end_utc_ms !== null && record.end_utc_ms !== undefined
        ? Number(record.end_utc_ms)
        : null;
    const nowMs =
      record.now_utc_ms !== null && record.now_utc_ms !== undefined
        ? Number(record.now_utc_ms)
        : Date.now();

    if (record.status === 'pending' && endMs !== null && !Number.isNaN(endMs) && nowMs > endMs) {
      await expireOverduePasses(record.id);
      record = { ...record, status: 'expired' };
    }

    if (record.status === 'cancelled') {
      const msg = 'El pase QR fue cancelado y ya no es válido.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
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

    if (record.status === 'expired') {
      const msg = 'El pase QR se encuentra vencido / fuera de vigencia horaria.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
        authorized: false,
        reasonCode: 'OUT_OF_TIME_WINDOW',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'OUT_OF_TIME_WINDOW',
        error: msg
      });
    }

    if (record.status !== 'pending' && record.status !== 'used') {
      const msg = `El pase QR no se encuentra habilitado (estado actual: ${record.status}).`;
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
        authorized: false,
        reasonCode: 'PASS_NOT_ELIGIBLE',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_NOT_ELIGIBLE',
        error: msg
      });
    }

    if (startMs !== null && !Number.isNaN(startMs) && nowMs < startMs) {
      const msg = 'El pase aún no está dentro de su franja horaria habilitada.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
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
      await expireOverduePasses(record.id);
      const msg = 'El pase QR se encuentra vencido / fuera de vigencia horaria.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
        authorized: false,
        reasonCode: 'OUT_OF_TIME_WINDOW',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'OUT_OF_TIME_WINDOW',
        error: msg
      });
    }

    if (record.compliance_status && record.compliance_status !== 'approved') {
      const msg = `El prestador no cuenta con compliance aprobado (estado: ${record.compliance_status}).`;
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
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

    let vehicles = [];
    if (record.provider_id) {
      const vehRes = await db.query(
        `
          SELECT vehicle_type, brand, model, color, plate
          FROM provider_vehicles
          WHERE provider_id = $1
          ORDER BY id ASC
        `,
        [record.provider_id]
      );
      vehicles = vehRes.rows;
    }

    const grantedMsg = 'Acceso autorizado para ingreso perimetral.';
    await recordGateAccessLog({
      qrToken,
      passId: record.id,
      countryId: record.country_id,
      integrationLabel: auth.integrationLabel,
      authMode: auth.authMode,
      authorized: true,
      reasonCode: 'ACCESS_GRANTED',
      message: grantedMsg,
      httpStatus: 200
    });

    return res.status(200).json({
      authorized: true,
      code: 'ACCESS_GRANTED',
      message: grantedMsg,
      auth_mode: auth.authMode,
      integration_label: auth.integrationLabel,
      pass: {
        id: record.id,
        country_id: record.country_id,
        country_name: record.country_name,
        owner_name: record.owner_name,
        provider_name: record.provider_name,
        provider_dni: record.provider_dni,
        specialty: record.specialty,
        compliance_status: record.compliance_status,
        fraction_number: record.fraction_number,
        lot_number: record.lot_number,
        start_time: record.start_time,
        end_time: record.end_time,
        start_utc_ms: record.start_utc_ms,
        end_utc_ms: record.end_utc_ms,
        status: record.status,
        vehicles
      }
    });
  } catch (error) {
    console.error('Error al verificar pase QR externo:', error);
    await recordGateAccessLog({
      qrToken,
      countryId: auth.countryId || requestedCountryId,
      integrationLabel: auth.integrationLabel,
      authMode: auth.authMode,
      authorized: false,
      reasonCode: 'INTERNAL_SERVER_ERROR',
      message: 'Error interno del servidor al validar el pase QR.',
      httpStatus: 500
    });
    return res.status(500).json({
      authorized: false,
      code: 'INTERNAL_SERVER_ERROR',
      error: 'Error interno del servidor al validar el pase QR.'
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