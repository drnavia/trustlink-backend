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
const {
  findComplianceExpiryViolation,
  hydrateAuthorizedEmployeesExpiry,
} = require('../../utils/complianceExpiry');

/**
 * Catálogo comercial de planes B2B disponibles para comunidades/barrios privados.
 * Define precio de referencia en ARS y cuota mensual de validaciones QR autorizadas
 * (`null` equivale a validaciones ilimitadas).
 */
const COMMUNITY_B2B_PLANS = [
  {
    code: 'pilot',
    name: 'Piloto Comunidad',
    price_ars: 0,
    default_monthly_quota: 300,
    description: 'Plan inicial de prueba con Consola Garita y 1 integración API.',
  },
  {
    code: 'starter',
    name: 'Barrio Esencial',
    price_ars: 89000,
    default_monthly_quota: 1000,
    description: 'Validación QR en tiempo real, trazabilidad y alertas de vencimiento.',
  },
  {
    code: 'pro',
    name: 'Country Pro',
    price_ars: 189000,
    default_monthly_quota: 5000,
    description: 'Múltiples garitas/API Keys, auditoría completa y suspensiones locales.',
  },
  {
    code: 'enterprise',
    name: 'Red Enterprise',
    price_ars: 320000,
    default_monthly_quota: null,
    description: 'Validaciones QR ilimitadas para complejos y consorcios de alto tráfico.',
  },
];

/** Índice rápido de metadatos de planes B2B agrupados por su código (`plan_code`). */
const B2B_PLANS_BY_CODE = Object.fromEntries(COMMUNITY_B2B_PLANS.map((p) => [p.code, p]));
/** Estados de facturación permitidos para una suscripción B2B de comunidad. */
const ALLOWED_B2B_BILLING_STATUSES = ['trial', 'active', 'grace', 'suspended'];

/**
 * Asegura de forma idempotente que la tabla `countries` cuente con las columnas
 * de ubicación y licenciamiento B2B (`plan_code`, `billing_status`, `subscription_ends_at`,
 * `monthly_pass_quota`), y migra valores heredados de `locality` o `location` hacia `city`.
 *
 * @returns {Promise<void>}
 */
const ensureCountriesColumns = async () => {
  // Paso 1: Agregar columnas de domicilio y licenciamiento comercial si aún no existen
  await db.query(`
    ALTER TABLE countries
      ADD COLUMN IF NOT EXISTS address VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30) NULL,
      ADD COLUMN IF NOT EXISTS city VARCHAR(120) NULL,
      ADD COLUMN IF NOT EXISTS province VARCHAR(120) NULL,
      ADD COLUMN IF NOT EXISTS plan_code VARCHAR(40) NOT NULL DEFAULT 'pilot',
      ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMP WITHOUT TIME ZONE NULL,
      ADD COLUMN IF NOT EXISTS monthly_pass_quota INTEGER NULL;
  `);

  // Paso 2: Inspeccionar columnas reales para soportar esquemas legacy con `locality` o `location`
  const colsRes = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'countries'
  `);
  const cols = new Set(colsRes.rows.map((r) => r.column_name));

  // Backfill de `city` a partir de columnas antiguas si están pobladas
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
 * Asegura de forma idempotente la existencia de la tabla `country_integrations`
 * y migra claves legacy almacenadas en texto plano (`api_key`) hacia su formato
 * seguro con hash SHA-256 (`api_key_hash`) y prefijo enmascarado (`api_key_prefix`).
 *
 * @returns {Promise<void>}
 */
const ensureIntegrationsTable = async () => {
  // Paso 1: Crear tabla de integraciones API por comunidad si no existe
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

  // Paso 2: Garantizar columnas de almacenamiento seguro en instalaciones previas
  await db.query(`
    ALTER TABLE country_integrations
      ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(128) NULL,
      ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(24) NULL;
  `);

  // Paso 3: Detectar columna heredada `api_key` para migrar claves sin perder continuidad operativa
  const legacyColRes = await db.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'country_integrations'
      AND column_name = 'api_key'
    LIMIT 1
  `);

  if (legacyColRes.rows.length > 0) {
    // Relajar NOT NULL de `api_key` legacy para permitir nuevos registros solo con hash
    await db
      .query('ALTER TABLE country_integrations ALTER COLUMN api_key DROP NOT NULL;')
      .catch(() => {});

    // Calcular hash SHA-256 y prefijo visible para filas heredadas aún sin migrar
    const legacyRows = await db.query(
      `SELECT id, api_key
       FROM country_integrations
       WHERE api_key IS NOT NULL
         AND (api_key_hash IS NULL OR api_key_prefix IS NULL)`
    );
    for (const row of legacyRows.rows) {
      const raw = String(row.api_key).trim();
      if (!raw) continue;
      const hashed = crypto.createHash('sha256').update(raw).digest('hex');
      const pref = raw.length > 18 ? `${raw.slice(0, 14)}...${raw.slice(-4)}` : raw;
      await db.query(
        `UPDATE country_integrations
         SET api_key_hash = COALESCE(api_key_hash, $1),
             api_key_prefix = COALESCE(api_key_prefix, $2)
         WHERE id = $3`,
        [hashed, pref, row.id]
      );
    }
  }
};

/**
 * Asegura de forma idempotente la existencia de la tabla `gate_access_logs`,
 * donde se audita cada intento autorizado o denegado de validación QR en garita o API externa.
 *
 * @returns {Promise<void>}
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
 * Persiste en PostgreSQL el estado `'expired'::pass_status` para pases en estado `'pending'`
 * cuya columna `end_time` (almacenada en UTC sin zona horaria) ya superó el instante actual (`NOW()`).
 * Tolerante a fallos: registra el error sin interrumpir el flujo llamador.
 *
 * @param {number|null} [passId=null] - Si se indica, evalúa solo ese pase; si es null, barre todos los vencidos.
 * @returns {Promise<void>}
 */
const expireOverduePasses = async (passId = null) => {
  try {
    // Expiración puntual de un único pase específico
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

    // Barrido masivo de todos los pases pendientes fuera de ventana horaria
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

/**
 * Genera el hash criptográfico SHA-256 en hexadecimal de una API Key externa
 * (previo recorte de espacios) para almacenamiento y comparación sin exponer secretos.
 *
 * @param {string} rawKey - Clave API en texto plano recibida o recién generada.
 * @returns {string} Hash SHA-256 en formato hexadecimal (64 caracteres).
 */
const hashApiKey = (rawKey) =>
  crypto.createHash('sha256').update(String(rawKey).trim()).digest('hex');

/**
 * Enmascara un token QR conservando los primeros 8 y los últimos 6 caracteres
 * para mantener trazabilidad en auditoría sin persistir el secreto completo.
 *
 * @param {string|null|undefined} token - Token QR original.
 * @returns {string|null} Token parcialmente enmascarado o `null` si está vacío.
 */
const maskToken = (token) => {
  if (!token) return null;
  const clean = String(token).trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 8)}...${clean.slice(-6)}`;
};

/**
 * Registra de forma tolerante a fallos un evento de validación de pase QR en `gate_access_logs`,
 * enmascarando el token para preservar trazabilidad sin exponer credenciales completas.
 *
 * @param {Object} params - Datos del evento de auditoría.
 * @param {string} [params.qrToken] - Token QR evaluado (se persiste enmascarado).
 * @param {number|null} [params.passId=null] - ID del pase si fue hallado.
 * @param {number|null} [params.countryId=null] - ID de la comunidad asociada.
 * @param {string|null} [params.integrationLabel=null] - Etiqueta de garita/integración/rol.
 * @param {string} [params.authMode='unknown'] - Modo de autenticación (`community_api_key`, `env_api_key`, `jwt`, etc.).
 * @param {boolean} [params.authorized=false] - Indica si el acceso fue concedido.
 * @param {string} [params.reasonCode='UNKNOWN'] - Código de resultado o motivo de rechazo.
 * @param {string} [params.message=''] - Mensaje descriptivo devuelto al consumidor.
 * @param {number} [params.httpStatus=200] - Código HTTP de la respuesta emitida.
 * @returns {Promise<void>}
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
    // Persistir el intento con el token enmascarado y los metadatos de resultado/HTTP
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
 * Cuenta cuántas validaciones QR autorizadas (`authorized = TRUE`) consumió una comunidad
 * durante el mes calendario en curso (desde el 1° del mes según el reloj del servidor SQL).
 * Se utiliza para controlar la cuota mensual del plan B2B y mostrar métricas de consumo.
 *
 * @param {number|string|null} countryId - ID de la comunidad.
 * @returns {Promise<number>} Cantidad de validaciones autorizadas en el mes actual.
 */
const getMonthlyQrUsedForCountry = async (countryId) => {
  if (!countryId) return 0;
  await ensureAuditLogsTable();
  const res = await db.query(
    `SELECT COUNT(*)::int AS used
     FROM gate_access_logs
     WHERE country_id = $1
       AND authorized = TRUE
       AND created_at >= date_trunc('month', NOW())`,
    [Number(countryId)]
  );
  return Number(res.rows[0]?.used || 0);
};

/**
 * Evalúa si la licencia comercial B2B de una comunidad permite validar accesos QR:
 * 1) Bloquea si `billing_status === 'suspended'`.
 * 2) Bloquea si `subscription_ends_at` ya expiró (excepto cuando está en período `'grace'`).
 * 3) Bloquea si el consumo mensual alcanzó o superó `monthly_pass_quota` (cuando es > 0).
 *
 * @param {Object} countryRow - Registro de comunidad con `billing_status`, `subscription_ends_at` y `monthly_pass_quota`.
 * @param {number} [monthlyUsed=0] - Validaciones QR autorizadas acumuladas en el mes actual.
 * @returns {{ok: boolean, code?: string, error?: string}} Resultado de habilitación comercial.
 */
const evaluateCountryB2BStatus = (countryRow, monthlyUsed = 0) => {
  // Regla 1: Bloqueo inmediato por suspensión comercial
  const status = String(countryRow?.billing_status || 'active').toLowerCase();
  if (status === 'suspended') {
    return {
      ok: false,
      code: 'COUNTRY_SUBSCRIPTION_SUSPENDED',
      error: 'La licencia B2B de la comunidad se encuentra suspendida. Contacte a TrustLink.',
    };
  }

  // Regla 2: Verificar fecha de vencimiento de suscripción (respetando período de gracia)
  if (countryRow?.subscription_ends_at && status !== 'grace') {
    const endsAtMs = new Date(countryRow.subscription_ends_at).getTime();
    if (!Number.isNaN(endsAtMs) && endsAtMs < Date.now()) {
      return {
        ok: false,
        code: 'COUNTRY_SUBSCRIPTION_EXPIRED',
        error: 'La suscripción B2B de la comunidad se encuentra vencida. Renueve el abono para continuar operando.',
      };
    }
  }

  // Regla 3: Controlar tope mensual de validaciones QR autorizadas (null = ilimitado)
  const quota =
    countryRow?.monthly_pass_quota !== null && countryRow?.monthly_pass_quota !== undefined
      ? Number(countryRow.monthly_pass_quota)
      : null;
  if (quota !== null && !Number.isNaN(quota) && quota > 0 && Number(monthlyUsed) >= quota) {
    return {
      ok: false,
      code: 'COUNTRY_QUOTA_EXCEEDED',
      error: `La comunidad alcanzó su cuota mensual de ${quota} validaciones QR autorizadas.`,
    };
  }

  return { ok: true };
};

/**
 * Resuelve la autenticación y autorización de llamadas externas al validador de garita.
 * Orden de precedencia:
 * 1) Header `x-api-key` comparado contra hashes de `country_integrations` (verifica clave activa,
 *    comunidad activa, licencia/cuota B2B y actualiza `last_used_at`).
 * 2) Header `x-api-key` igual a la clave global de respaldo `EXTERNAL_GATE_API_KEY`.
 * 3) Sesión JWT interna con rol autorizado (`admin`, `superadmin` o `security`).
 *
 * @param {import('express').Request} req - Solicitud HTTP entrante.
 * @returns {Promise<{ok: boolean, status?: number, code?: string, error?: string, authMode: string, countryId: number|null, integrationLabel: string|null}>}
 */
const resolveExternalAuth = async (req) => {
  // Extraer credenciales posibles: header x-api-key, variable de entorno global y sesión JWT
  const providedKey = String(req.headers['x-api-key'] || '').trim();
  const envKey = String(process.env.EXTERNAL_GATE_API_KEY || '').trim();
  const hasValidJwt = Boolean(
    req.user && ['admin', 'superadmin', 'security'].includes(req.user.role)
  );

  // Flujo 1: Autenticación mediante encabezado `x-api-key`
  if (providedKey) {
    await Promise.all([ensureCountriesColumns(), ensureIntegrationsTable()]);
    const keyHash = hashApiKey(providedKey);

    // Buscar la clave hasheada junto con el estado operativo y comercial de su comunidad
    const integrationRes = await db.query(
      `
        SELECT
          ci.id,
          ci.country_id,
          ci.label,
          ci.is_active,
          c.name AS country_name,
          c.is_active AS country_is_active,
          c.plan_code,
          c.billing_status,
          c.subscription_ends_at,
          c.monthly_pass_quota
        FROM country_integrations ci
        JOIN countries c ON ci.country_id = c.id
        WHERE ci.api_key_hash = $1
        LIMIT 1
      `,
      [keyHash]
    );

    if (integrationRes.rows.length > 0) {
      const integ = integrationRes.rows[0];

      // Verificar que la clave no haya sido revocada y que la comunidad esté habilitada
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

      // Evaluar estado de licencia comercial B2B y cuota mensual consumida
      const monthlyUsed = await getMonthlyQrUsedForCountry(integ.country_id);
      const b2bCheck = evaluateCountryB2BStatus(integ, monthlyUsed);
      if (!b2bCheck.ok) {
        return {
          ok: false,
          status: 403,
          code: b2bCheck.code,
          error: b2bCheck.error,
          authMode: 'community_api_key',
          countryId: integ.country_id,
          integrationLabel: integ.label
        };
      }

      // Registrar último uso exitoso de la integración para monitoreo
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

    // Flujo 2: Fallback a clave global configurada por variable de entorno
    if (envKey && providedKey === envKey) {
      return {
        ok: true,
        authMode: 'env_api_key',
        countryId: null,
        integrationLabel: 'Clave Global (ENV)'
      };
    }

    // Clave enviada pero no coincide con ninguna comunidad ni con la clave global
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

  // Flujo 3: Autenticación mediante JWT interno de consola (admin, superadmin o security)
  if (hasValidJwt) {
    return {
      ok: true,
      authMode: 'jwt',
      countryId: null,
      integrationLabel: `Sesión ${req.user.role}`
    };
  }

  // Sin API Key ni sesión JWT autorizada
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
 * Devuelve un diagnóstico técnico integral del servicio backend, conectividad/latencia con PostgreSQL,
 * configuración del endpoint externo y métricas operativas globales (pases, prestadores, comunidades,
 * integraciones activas y validaciones QR del mes).
 * GET /api/v1/external/diagnostics (Uso exclusivo: rol `superadmin`).
 *
 * @param {import('express').Request} req - Solicitud HTTP entrante.
 * @param {import('express').Response} res - Respuesta HTTP con estado `healthy` o `degraded`.
 */
const getExternalDiagnostics = async (req, res) => {
  const startedAt = Date.now();
  try {
    // Etapa 1: Asegurar tablas/columnas requeridas y sincronizar pases vencidos antes de medir KPIs
    await Promise.all([
      ensureCountriesColumns(),
      ensureIntegrationsTable(),
      ensureAuditLogsTable(),
      expireOverduePasses()
    ]);

    // Etapa 2: Verificar conectividad con PostgreSQL y calcular latencia de respuesta
    const dbCheck = await db.query('SELECT NOW() AS db_time');
    const dbLatencyMs = Date.now() - startedAt;

    // Etapa 3: Consolidar métricas operativas y comerciales en una única consulta agregada
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
        (SELECT COUNT(*)::int FROM countries WHERE billing_status IN ('active', 'trial', 'grace')) AS b2b_active_countries,
        (SELECT COUNT(*)::int FROM countries WHERE billing_status = 'suspended') AS b2b_suspended_countries,
        (SELECT COUNT(*)::int FROM country_integrations WHERE is_active = TRUE) AS active_integrations,
        (SELECT COUNT(*)::int FROM gate_access_logs) AS total_access_logs,
        (SELECT COUNT(*)::int FROM gate_access_logs WHERE authorized = TRUE AND created_at >= date_trunc('month', NOW())) AS monthly_qr_validations
    `);

    const envKey = String(process.env.EXTERNAL_GATE_API_KEY || '').trim();

    // Etapa 4: Retornar reporte saludable con telemetría del proceso, BD y capacidades del endpoint
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
 * Lista comunidades (`countries`) con paginación, filtro por estado (`active`/`inactive`/`all`)
 * y búsqueda textual sobre nombre, localidad, provincia, dirección o código postal.
 * Incluye conteo de API Keys activas, consumo mensual de QR y catálogo de planes B2B.
 * GET /api/v1/external/countries
 *
 * @param {import('express').Request} req - Query params: `page`, `limit`, `search`, `status`.
 * @param {import('express').Response} res - Respuesta HTTP con comunidades enriquecidas y paginación.
 */
const listCountries = async (req, res) => {
  try {
    await Promise.all([ensureCountriesColumns(), ensureIntegrationsTable(), ensureAuditLogsTable()]);

    // Etapa 1: Sanitizar parámetros de paginación y filtros de búsqueda
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

    // Etapa 2: Calcular total filtrado y acotar la página solicitada al rango válido
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM countries c ${whereClause}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    // Etapa 3: Consultar página de comunidades con subconsultas de claves activas y consumo QR mensual
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
          c.plan_code,
          c.billing_status,
          c.subscription_ends_at,
          c.monthly_pass_quota,
          c.created_at,
          (SELECT COUNT(*)::int FROM country_integrations ci WHERE ci.country_id = c.id AND ci.is_active = TRUE) AS active_keys_count,
          (
            SELECT COUNT(*)::int
            FROM gate_access_logs gal
            WHERE gal.country_id = c.id
              AND gal.authorized = TRUE
              AND gal.created_at >= date_trunc('month', NOW())
          ) AS monthly_qr_used
        FROM countries c
        ${whereClause}
        ORDER BY c.id ASC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    // Enriquecer cada comunidad con el nombre legible del plan B2B asignado
    const enrichedCountries = result.rows.map((row) => ({
      ...row,
      plan_name: B2B_PLANS_BY_CODE[row.plan_code]?.name || row.plan_code || 'Piloto Comunidad',
    }));

    return res.status(200).json({
      countries: enrichedCountries,
      b2b_plans: COMMUNITY_B2B_PLANS,
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
 * Crea una nueva comunidad (`countries`) adaptándose dinámicamente a si existe la columna
 * heredada `location` en el esquema de PostgreSQL.
 * POST /api/v1/external/countries
 *
 * @param {import('express').Request} req - Body: `name` (obligatorio), `address`, `postal_code`, `city`, `province`, `is_active`.
 * @param {import('express').Response} res - Respuesta HTTP 201 con la comunidad creada.
 */
const createCountry = async (req, res) => {
  try {
    await ensureCountriesColumns();

    // Etapa 1: Extraer y validar datos básicos de la comunidad
    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    const postalCode = String(req.body?.postal_code || '').trim();
    const city = String(req.body?.city || '').trim();
    const province = String(req.body?.province || '').trim();
    const isActive = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : true;

    if (!name) {
      return res.status(400).json({ error: 'El nombre de la comunidad es obligatorio.' });
    }

    // Etapa 2: Verificar si existe columna legacy `location` para mantener compatibilidad hacia atrás
    const colsRes = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'countries'
    `);
    const cols = new Set(colsRes.rows.map((r) => r.column_name));

    const locationText = [address, city, province, postalCode].filter(Boolean).join(', ') || null;

    // Etapa 3: Insertar incluyendo `location` concatenado si la columna legacy sigue presente
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
 * Actualiza los datos descriptivos y de domicilio de una comunidad existente.
 * Aplica actualización parcial preservando los valores actuales de cualquier campo omitido.
 * PUT / PATCH /api/v1/external/countries/:id
 *
 * @param {import('express').Request} req - Param `id`; body opcional con `name`, `address`, `postal_code`, `city`, `province`.
 * @param {import('express').Response} res - Respuesta HTTP con la comunidad actualizada.
 */
const updateCountry = async (req, res) => {
  try {
    await ensureCountriesColumns();

    // Etapa 1: Validar identificador y existencia de la comunidad
    const countryId = parseInt(req.params.id, 10);
    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existing = await db.query('SELECT * FROM countries WHERE id = $1', [countryId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    // Etapa 2: Fusionar campos recibidos con los valores persistidos actualmente
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

    // Etapa 3: Persistir cambios en `countries`
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
 * Activa o desactiva operativamente una comunidad (`is_active`).
 * Si el body incluye un booleano explícito `is_active`, aplica ese valor; caso contrario invierte el actual.
 * PATCH /api/v1/external/countries/:id/status
 *
 * @param {import('express').Request} req - Param `id`; body opcional `{ is_active?: boolean }`.
 * @param {import('express').Response} res - Respuesta HTTP con el registro actualizado.
 */
const toggleCountryStatus = async (req, res) => {
  try {
    // Validar ID y comprobar existencia previa
    const countryId = parseInt(req.params.id, 10);
    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existing = await db.query('SELECT id, is_active FROM countries WHERE id = $1', [countryId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    // Determinar estado destino (explícito o toggle del estado actual)
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
 * Actualiza el plan B2B, estado de facturación, vigencia y cuota mensual de QR de una comunidad.
 * Permite extender la vigencia acumulativamente con `extend_days` o fijar `subscription_ends_at`.
 * PATCH /api/v1/external/countries/:id/billing (Exclusivo `superadmin`).
 *
 * @param {import('express').Request} req - Param `id`; body: `plan_code`, `billing_status`, `monthly_pass_quota`, `extend_days`, `subscription_ends_at`.
 * @param {import('express').Response} res - Respuesta HTTP con la comunidad y su consumo QR mensual actual.
 */
const updateCountryBilling = async (req, res) => {
  try {
    await Promise.all([ensureCountriesColumns(), ensureAuditLogsTable()]);

    // Etapa 1: Validar ID y obtener configuración comercial vigente de la comunidad
    const countryId = parseInt(req.params.id, 10);
    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'ID de comunidad inválido.' });
    }

    const existingRes = await db.query('SELECT * FROM countries WHERE id = $1 LIMIT 1', [countryId]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }
    const current = existingRes.rows[0];

    // Etapa 2: Validar plan B2B y estado comercial contra las listas permitidas
    const requestedPlan =
      req.body?.plan_code !== undefined ? String(req.body.plan_code).trim().toLowerCase() : current.plan_code || 'pilot';
    if (!B2B_PLANS_BY_CODE[requestedPlan]) {
      return res.status(400).json({
        error: `Plan B2B inválido. Valores permitidos: ${Object.keys(B2B_PLANS_BY_CODE).join(', ')}.`,
      });
    }

    const requestedStatus =
      req.body?.billing_status !== undefined
        ? String(req.body.billing_status).trim().toLowerCase()
        : current.billing_status || 'active';
    if (!ALLOWED_B2B_BILLING_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({
        error: `Estado comercial inválido. Valores permitidos: ${ALLOWED_B2B_BILLING_STATUSES.join(', ')}.`,
      });
    }

    // Etapa 3: Resolver cuota mensual (override explícito, ilimitado con null/''/0 o default al cambiar plan)
    const planMeta = B2B_PLANS_BY_CODE[requestedPlan];
    let nextQuota = current.monthly_pass_quota;
    if (req.body?.monthly_pass_quota !== undefined) {
      if (req.body.monthly_pass_quota === null || req.body.monthly_pass_quota === '') {
        nextQuota = null;
      } else {
        const parsedQuota = parseInt(req.body.monthly_pass_quota, 10);
        if (Number.isNaN(parsedQuota) || parsedQuota < 0) {
          return res.status(400).json({ error: 'La cuota mensual de pases debe ser un entero positivo o vacía (ilimitada).' });
        }
        nextQuota = parsedQuota === 0 ? null : parsedQuota;
      }
    } else if (req.body?.plan_code !== undefined && requestedPlan !== current.plan_code) {
      nextQuota = planMeta.default_monthly_quota;
    }

    // Etapa 4: Calcular fecha de vencimiento (extensión por días sobre fecha vigente o fecha explícita)
    let nextEndsAt = current.subscription_ends_at || null;
    if (req.body?.extend_days !== undefined && req.body.extend_days !== null) {
      const extendDays = parseInt(req.body.extend_days, 10);
      if (Number.isNaN(extendDays) || extendDays < 1 || extendDays > 730) {
        return res.status(400).json({ error: 'extend_days debe estar entre 1 y 730.' });
      }
      const now = new Date();
      const base =
        current.subscription_ends_at && new Date(current.subscription_ends_at) > now
          ? new Date(current.subscription_ends_at)
          : now;
      nextEndsAt = new Date(base.getTime() + extendDays * 24 * 60 * 60 * 1000).toISOString();
    } else if (req.body?.subscription_ends_at !== undefined) {
      if (req.body.subscription_ends_at === null || req.body.subscription_ends_at === '') {
        nextEndsAt = null;
      } else {
        const parsed = new Date(req.body.subscription_ends_at);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ error: 'Fecha de vencimiento de licencia inválida.' });
        }
        nextEndsAt = parsed.toISOString();
      }
    }

    // Etapa 5: Persistir actualización comercial y adjuntar uso mensual actual
    const updatedRes = await db.query(
      `
        UPDATE countries
        SET plan_code = $1,
            billing_status = $2,
            subscription_ends_at = $3,
            monthly_pass_quota = $4
        WHERE id = $5
        RETURNING
          id, name, address, postal_code, city, province, is_active,
          plan_code, billing_status, subscription_ends_at, monthly_pass_quota, created_at
      `,
      [requestedPlan, requestedStatus, nextEndsAt, nextQuota, countryId]
    );

    const monthlyUsed = await getMonthlyQrUsedForCountry(countryId);
    const updatedCountry = {
      ...updatedRes.rows[0],
      plan_name: planMeta.name,
      monthly_qr_used: monthlyUsed,
    };

    return res.status(200).json({
      message: `Licencia B2B de "${updatedCountry.name}" actualizada (${planMeta.name} · ${requestedStatus}).`,
      country: updatedCountry,
    });
  } catch (error) {
    console.error('Error al actualizar licencia B2B de comunidad:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la licencia B2B de la comunidad.' });
  }
};

/**
 * Devuelve el resumen de licencia B2B, claves activas y porcentaje de consumo mensual de QR
 * para la comunidad del administrador local (o la comunidad indicada/primera disponible si es `superadmin`).
 * GET /api/v1/external/my-community/billing
 *
 * @param {import('express').Request} req - Query opcional `country_id` (solo considerado para `superadmin`).
 * @param {import('express').Response} res - Respuesta HTTP con detalle de comunidad, plan actual y catálogo B2B.
 */
const getMyCommunityBilling = async (req, res) => {
  try {
    await Promise.all([ensureCountriesColumns(), ensureIntegrationsTable(), ensureAuditLogsTable()]);

    // Etapa 1: Determinar la comunidad objetivo según el rol autenticado
    // Para admin local se consulta también `users.country_id` en BD por si fue asignado tras emitir el JWT
    const isSuperadmin = req.user?.role === 'superadmin';
    const requestedCountryId = req.query.country_id ? parseInt(req.query.country_id, 10) : null;
    let targetCountryId = isSuperadmin && requestedCountryId ? requestedCountryId : req.user?.countryId;

    if (!isSuperadmin && !targetCountryId && req.user?.userId) {
      const userCountryRes = await db.query('SELECT country_id FROM users WHERE id = $1 LIMIT 1', [
        Number(req.user.userId),
      ]);
      targetCountryId = userCountryRes.rows[0]?.country_id || null;
    }

    // Para superadmin sin countryId en sesión ni query, usar la primera comunidad registrada como fallback
    if (!targetCountryId && isSuperadmin) {
      const firstCountry = await db.query('SELECT id FROM countries ORDER BY id ASC LIMIT 1');
      targetCountryId = firstCountry.rows[0]?.id || null;
    }

    if (!targetCountryId) {
      return res.status(404).json({ error: 'No se encontró una comunidad asociada a la cuenta.' });
    }

    // Etapa 2: Consultar datos comerciales de la comunidad y cantidad de API Keys activas
    const countryRes = await db.query(
      `
        SELECT
          c.id,
          c.name,
          c.city,
          c.province,
          c.is_active,
          c.plan_code,
          c.billing_status,
          c.subscription_ends_at,
          c.monthly_pass_quota,
          (SELECT COUNT(*)::int FROM country_integrations ci WHERE ci.country_id = c.id AND ci.is_active = TRUE) AS active_keys_count
        FROM countries c
        WHERE c.id = $1
        LIMIT 1
      `,
      [Number(targetCountryId)]
    );

    if (countryRes.rows.length === 0) {
      return res.status(404).json({ error: 'Comunidad no encontrada.' });
    }

    // Etapa 3: Calcular consumo QR del mes en curso y porcentaje respecto a la cuota del plan
    const community = countryRes.rows[0];
    const monthlyUsed = await getMonthlyQrUsedForCountry(community.id);
    const plan = B2B_PLANS_BY_CODE[community.plan_code] || COMMUNITY_B2B_PLANS[0];
    const quota =
      community.monthly_pass_quota !== null && community.monthly_pass_quota !== undefined
        ? Number(community.monthly_pass_quota)
        : null;
    const usagePercent =
      quota && quota > 0 ? Math.min(100, Math.round((monthlyUsed / quota) * 100)) : null;

    return res.status(200).json({
      community: {
        ...community,
        plan_name: plan.name,
        monthly_qr_used: monthlyUsed,
        usage_percent: usagePercent,
      },
      plan,
      b2b_plans: COMMUNITY_B2B_PLANS,
    });
  } catch (error) {
    console.error('Error al consultar licencia B2B de la comunidad:', error);
    return res.status(500).json({ error: 'Error interno al consultar la licencia de la comunidad.' });
  }
};

/**
 * Lista las claves API de integración por comunidad con paginación y filtro opcional por `country_id`.
 * Por seguridad solo expone `api_key_prefix` (nunca el hash ni el secreto en texto plano).
 * GET /api/v1/external/integrations
 *
 * @param {import('express').Request} req - Query params: `page`, `limit`, `country_id`.
 * @param {import('express').Response} res - Respuesta HTTP con integraciones y paginación.
 */
const listCommunityIntegrations = async (req, res) => {
  try {
    await ensureIntegrationsTable();

    // Etapa 1: Parsear paginación y filtro opcional por comunidad
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

    // Etapa 2: Contar registros totales y calcular offset seguro
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM country_integrations ci ${whereClause}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * limit;

    // Etapa 3: Consultar página de integraciones uniendo el nombre de la comunidad
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

    // Devolver claves de integración paginadas (solo prefijos visibles, nunca secretos ni hashes)
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
 * Crea una nueva clave API criptográfica (`tlk_live_*`) para una comunidad.
 * Persiste únicamente el hash SHA-256 y el prefijo visible; devuelve el secreto completo una sola vez.
 * POST /api/v1/external/integrations
 *
 * @param {import('express').Request} req - Body: `country_id` (obligatorio), `label` (opcional).
 * @param {import('express').Response} res - Respuesta HTTP 201 con `api_key` de exhibición única e integración creada.
 */
const createCommunityIntegration = async (req, res) => {
  try {
    await ensureIntegrationsTable();

    // Etapa 1: Validar comunidad destino y etiqueta descriptiva de la garita/sistema
    const countryId = parseInt(req.body?.country_id, 10);
    const label = String(req.body?.label || '').trim() || 'Garita Principal';

    if (Number.isNaN(countryId)) {
      return res.status(400).json({ error: 'Debe seleccionar una comunidad válida.' });
    }

    const countryRes = await db.query('SELECT id, name FROM countries WHERE id = $1', [countryId]);
    if (countryRes.rows.length === 0) {
      return res.status(404).json({ error: 'La comunidad indicada no existe.' });
    }

    // Etapa 2: Generar clave aleatoria de 24 bytes, calcular hash SHA-256 y prefijo enmascarado
    const rawApiKey = `tlk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = hashApiKey(rawApiKey);
    const prefix = `${rawApiKey.slice(0, 14)}...${rawApiKey.slice(-4)}`;

    // Etapa 3: Persistir integración activa (sin almacenar la clave en texto plano)
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
 * Rota la clave API de una integración existente invalidando de inmediato la clave anterior,
 * reactiva la integración y devuelve el nuevo secreto en texto plano una única vez.
 * POST / PATCH /api/v1/external/integrations/:id/rotate
 *
 * @param {import('express').Request} req - Param `id` de la integración.
 * @param {import('express').Response} res - Respuesta HTTP con el nuevo secreto `api_key` e integración actualizada.
 */
const rotateCommunityIntegrationKey = async (req, res) => {
  try {
    await ensureIntegrationsTable();

    // Etapa 1: Validar ID y verificar que la integración exista junto a su comunidad
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

    // Etapa 2: Generar nueva credencial, hash SHA-256 y prefijo enmascarado
    const rawApiKey = `tlk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = hashApiKey(rawApiKey);
    const prefix = `${rawApiKey.slice(0, 14)}...${rawApiKey.slice(-4)}`;

    // Etapa 3: Reemplazar hash en BD y asegurar `is_active = TRUE`
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
 * Reactiva o revoca una clave API de comunidad actualizando su bandera `is_active`.
 * Si no se envía `is_active` booleano en el body, alterna el estado actual.
 * PATCH /api/v1/external/integrations/:id/status
 *
 * @param {import('express').Request} req - Param `id`; body opcional `{ is_active?: boolean }`.
 * @param {import('express').Response} res - Respuesta HTTP con la integración actualizada.
 */
const toggleCommunityIntegrationStatus = async (req, res) => {
  try {
    await ensureIntegrationsTable();

    // Validar ID y existencia de la integración
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

    // Determinar nuevo estado (explícito o inversión del estado actual) y persistir
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
 * Lista los pases QR recientes con paginación, filtro de estado y búsqueda libre,
 * persistiendo previamente `'expired'` en pases vencidos y devolviendo `start_utc_ms`/`end_utc_ms`
 * para formateo horario exacto en el cliente.
 * GET /api/v1/external/passes
 *
 * @param {import('express').Request} req - Query params: `page`, `limit`, `status`, `search`.
 * @param {import('express').Response} res - Respuesta HTTP con listado de pases y paginación.
 */
const listRecentPasses = async (req, res) => {
  try {
    // Etapa 1: Sincronizar estados vencidos antes de consultar
    await expireOverduePasses();

    // Etapa 2: Sanitizar parámetros de paginación, filtro de estado y búsqueda textual
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

    // Etapa 3: Obtener total filtrado y acotar página/offset
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

    // Etapa 4: Consultar pases enriquecidos con residente, prestador, comunidad y epochs UTC
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

    // Devolver pases paginados listos para renderizar con marcas temporales UTC exactas
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
 * Cancela un pase QR únicamente si se encuentra en estado `'pending'`,
 * cambiando su estado a `'cancelled'::pass_status` en PostgreSQL.
 * PATCH /api/v1/external/passes/:id/cancel
 *
 * @param {import('express').Request} req - Param `id` del pase QR.
 * @param {import('express').Response} res - Respuesta HTTP con el pase cancelado.
 */
const cancelPassById = async (req, res) => {
  try {
    // Etapa 1: Validar identificador y comprobar existencia del pase
    const passId = parseInt(req.params.id, 10);
    if (Number.isNaN(passId)) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const passRes = await db.query('SELECT id, status FROM access_passes WHERE id = $1', [passId]);
    if (passRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    // Etapa 2: Restringir la cancelación exclusivamente a pases pendientes
    const currentStatus = passRes.rows[0].status;
    if (currentStatus !== 'pending') {
      return res.status(400).json({
        error: `No se puede cancelar un pase en estado '${currentStatus}'.`
      });
    }

    // Etapa 3: Persistir el estado `cancelled`
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
 * Consulta de forma tolerante a variaciones de esquema el resumen financiero (volumen bruto,
 * comisiones/Take Rate y pagos netos a prestadores) y las últimas 6 transacciones de `transactions`.
 * Si faltan columnas explícitas de comisión o neto, aplica el Take Rate de referencia del 7%.
 *
 * @returns {Promise<{summary: Object, recent: Array<Object>}>}
 */
const fetchTransactionsAuditSafe = async () => {
  const defaultSummary = {
    total_transactions: 0,
    gross_volume: 0,
    platform_fee_total: 0,
    provider_payout_total: 0
  };

  try {
    // Etapa 1: Inspeccionar columnas reales disponibles en la tabla `transactions`
    const colsRes = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions'
    `);
    const cols = new Set(colsRes.rows.map((r) => r.column_name));
    if (cols.size === 0) {
      return { summary: defaultSummary, recent: [] };
    }

    // Etapa 2: Mapear dinámicamente expresiones SQL para monto bruto, comisión, neto y estado
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

    // Etapa 3: Calcular acumulados financieros globales
    const summaryRes = await db.query(`
      SELECT
        COUNT(*)::int AS total_transactions,
        COALESCE(SUM(${grossCol}), 0)::numeric(12,2) AS gross_volume,
        COALESCE(SUM(${feeCol}), 0)::numeric(12,2) AS platform_fee_total,
        COALESCE(SUM(${payoutCol}), 0)::numeric(12,2) AS provider_payout_total
      FROM transactions t
    `);

    // Etapa 4: Armar JOIN opcional con contratos/prestadores/comunidades si existe `contract_id`
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

    // Etapa 5: Obtener las 6 transacciones más recientes para vista rápida de auditoría
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
 * Obtiene la bitácora paginada de intentos de validación de acceso en garita/API externa
 * (`gate_access_logs`), junto con totales de autorizados/denegados y el resumen financiero
 * tolerante de transacciones y comisiones (Take Rate).
 * GET /api/v1/external/audit
 *
 * @param {import('express').Request} req - Query params: `page`, `limit`, `outcome` (`all`|`authorized`|`denied`), `search`.
 * @param {import('express').Response} res - Respuesta HTTP con KPIs, bitácora paginada y resumen de transacciones.
 */
const getAuditOverview = async (req, res) => {
  try {
    // Etapa 1: Asegurar tablas requeridas y sincronizar estados de pases vencidos
    await Promise.all([
      ensureIntegrationsTable(),
      ensureAuditLogsTable(),
      expireOverduePasses()
    ]);

    // Etapa 2: Sanitizar paginación, filtro de resultado (`outcome`) y búsqueda libre
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

    // Etapa 3: Consultar KPIs globales de intentos (sin filtros) y total filtrado para paginación
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

    // Etapa 4: Obtener página de eventos de auditoría unidos al nombre de comunidad
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

    // Etapa 5: Anexar resumen financiero de transacciones de manera tolerante a fallos
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
 * Valida un pase QR en tiempo real para garitas o sistemas de control de acceso externos.
 * Ejecuta cadena completa de controles: autenticación (`x-api-key` con cuota/licencia B2B o JWT),
 * pertenencia de comunidad, vigencia horaria UTC, estado de pase, compliance aprobado, vencimientos
 * documentales de titular y cuadrilla, suspensión operativa local y consumo atómico de ingreso único.
 * Cada intento (exitoso o denegado) queda auditado en `gate_access_logs`.
 * POST /api/v1/external/passes/verify
 *
 * @param {import('express').Request} req - Header `x-api-key` (o JWT); body `{ qr_token, country_id? }`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ authorized, code, ... }` y datos del pase si se aprueba.
 */
const verifyExternalPassByQR = async (req, res) => {
  await Promise.all([ensureIntegrationsTable(), ensureAuditLogsTable()]);

  // Etapa 1: Autenticar integrador/sesión (incluye verificación de licencia y cuota B2B)
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

  // Etapa 2: Validar que el body incluya el token QR obligatorio
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
    // Etapa 3: Asegurar columna de cuadrilla y consultar el pase completo con datos de cumplimiento y reloj UTC de BD
    await db.query(`
      ALTER TABLE public.access_passes
        ADD COLUMN IF NOT EXISTS authorized_employees JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    const passRes = await db.query(
      `
        SELECT
          ap.id,
          ap.country_id,
          c.name AS country_name,
          ap.owner_id,
          TRIM(CONCAT(COALESCE(u_own.first_name, ''), ' ', COALESCE(u_own.last_name, ''))) AS owner_name,
          u_own.phone AS owner_phone,
          ap.provider_id,
          TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
          u_prov.dni AS provider_dni,
          p.specialty,
          p.status AS compliance_status,
          p.criminal_record_expiry,
          p.insurance_expiry,
          ap.fraction_number,
          ap.lot_number,
          COALESCE(ap.authorized_employees, '[]'::jsonb) AS authorized_employees,
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

    // Rechazar y auditar si el token QR no existe en `access_passes`
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

    // Etapa 4: Verificar aislamiento multi-comunidad (el pase debe pertenecer a la comunidad de la clave/solicitud)
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

    // Etapa 5: Normalizar marcas temporales UTC y expirar de inmediato si un pase pendiente ya venció
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

    // Etapa 6: Validar estado del ciclo de vida del pase (solo se permite avanzar en estado `pending`)
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

    // Bloquear pases ya vencidos fuera de vigencia horaria
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

    // Bloquear reintentos sobre pases de ingreso único ya consumidos
    if (record.status === 'used') {
      const msg = 'El pase QR ya fue utilizado para un ingreso previo.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
        authorized: false,
        reasonCode: 'PASS_ALREADY_USED',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_ALREADY_USED',
        error: msg
      });
    }

    // Resguardo genérico frente a cualquier estado distinto de `pending`
    if (record.status !== 'pending') {
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

    // Etapa 7: Comprobar que el instante actual se encuentre dentro de la franja horaria [startMs, endMs]
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

    // Etapa 8: Verificar que el prestador cuente con compliance global en estado `approved`
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

    // Etapa 9: Hidratar vigencias actuales de la cuadrilla y bloquear ante cualquier documento vencido (antecedentes/seguro)
    const rawExternalCrew = Array.isArray(record.authorized_employees)
      ? record.authorized_employees
      : [];
    const hydratedExternalCrew = await hydrateAuthorizedEmployeesExpiry(db, rawExternalCrew);
    const externalExpiryViolation = findComplianceExpiryViolation({
      criminalRecordExpiry: record.criminal_record_expiry,
      insuranceExpiry: record.insurance_expiry,
      authorizedEmployees: hydratedExternalCrew,
      context: 'gate'
    });
    if (externalExpiryViolation) {
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
        authorized: false,
        reasonCode: externalExpiryViolation.code,
        message: externalExpiryViolation.message,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: externalExpiryViolation.code,
        expiry_date: externalExpiryViolation.expiry_date,
        error: externalExpiryViolation.message
      });
    }

    // Etapa 10: Verificar suspensión operativa local activa en la comunidad (si existe la tabla)
    const suspensionCountryId = record.country_id || effectiveCountryId;
    if (suspensionCountryId && record.provider_id) {
      const suspTable = await db.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'provider_local_suspensions'
         LIMIT 1`
      );
      if (suspTable.rows.length > 0) {
        const suspRes = await db.query(
          `SELECT id, reason
           FROM public.provider_local_suspensions
           WHERE country_id = $1 AND provider_id = $2 AND active = TRUE
           ORDER BY id DESC
           LIMIT 1`,
          [Number(suspensionCountryId), Number(record.provider_id)]
        );
        if (suspRes.rows.length > 0) {
          const msg = `Ingreso bloqueado por suspensión operativa local en la comunidad: ${suspRes.rows[0].reason}`;
          await recordGateAccessLog({
            qrToken,
            passId: record.id,
            countryId: suspensionCountryId,
            integrationLabel: auth.integrationLabel,
            authMode: auth.authMode,
            authorized: false,
            reasonCode: 'LOCAL_SUSPENSION_ACTIVE',
            message: msg,
            httpStatus: 403
          });
          return res.status(403).json({
            authorized: false,
            code: 'LOCAL_SUSPENSION_ACTIVE',
            error: msg
          });
        }
      }
    }

    // Etapa 11: Consumo atómico de ingreso único (`pending` -> `used`) para prevenir doble uso concurrente
    const consumedRes = await db.query(
      `UPDATE access_passes
       SET status = 'used'::pass_status
       WHERE id = $1 AND status = 'pending'::pass_status
       RETURNING id, status`,
      [record.id]
    );

    if (consumedRes.rows.length === 0) {
      const msg = 'El pase QR ya fue utilizado para un ingreso previo.';
      await recordGateAccessLog({
        qrToken,
        passId: record.id,
        countryId: record.country_id,
        integrationLabel: auth.integrationLabel,
        authMode: auth.authMode,
        authorized: false,
        reasonCode: 'PASS_ALREADY_USED',
        message: msg,
        httpStatus: 403
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_ALREADY_USED',
        error: msg
      });
    }

    // Etapa 12: Recuperar vehículos registrados del prestador para control visual en barrera
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

    // Etapa 13: Auditar autorización concedida y retornar ficha completa del ingreso
    const grantedMsg = 'Acceso autorizado para ingreso perimetral. Pase marcado como utilizado (ingreso único).';
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
        owner_phone: record.owner_phone || null,
        provider_name: record.provider_name,
        provider_dni: record.provider_dni,
        specialty: record.specialty,
        compliance_status: record.compliance_status,
        fraction_number: record.fraction_number,
        lot_number: record.lot_number,
        authorized_employees: hydratedExternalCrew,
        start_time: record.start_time,
        end_time: record.end_time,
        start_utc_ms: record.start_utc_ms,
        end_utc_ms: record.end_utc_ms,
        status: 'used',
        vehicles
      }
    });
  } catch (error) {
    // Auditar cualquier falla inesperada del servidor antes de responder HTTP 500
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

// Exportaciones públicas del módulo de integración externa, comunidades, licencias B2B y auditoría
module.exports = {
  COMMUNITY_B2B_PLANS,
  getExternalDiagnostics,
  listCountries,
  createCountry,
  updateCountry,
  toggleCountryStatus,
  updateCountryBilling,
  getMyCommunityBilling,
  listCommunityIntegrations,
  createCommunityIntegration,
  rotateCommunityIntegrationKey,
  toggleCommunityIntegrationStatus,
  listRecentPasses,
  cancelPassById,
  getAuditOverview,
  verifyExternalPassByQR
};