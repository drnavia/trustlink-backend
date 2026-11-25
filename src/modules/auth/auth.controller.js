/**
 * @file auth.controller.js
 * @description Lógica de negocio para autenticación (login), registro público de usuarios,
 * consulta de comunidades activas, recuperación/restablecimiento de contraseña y alta, listado
 * y actualización de cuentas privilegiadas (Ops Master: admin, superadmin y security).
 * @location /trustlink-backend/src/modules/auth/auth.controller.js
 */
const crypto = require('crypto');
const db = require('../../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  ensureEvolutionSchema,
  normalizeAreaType,
  getDefaultPrimaryPortal,
} = require('../../config/ensureEvolutionSchema');

// Roles habilitados para autoregistro desde el formulario público
const PUBLIC_ALLOWED_ROLES = ['owner', 'family', 'provider'];
// Roles operativos internos que solo pueden ser creados o editados por personal privilegiado
const PRIVILEGED_ALLOWED_ROLES = ['admin', 'superadmin', 'security'];

/**
 * Garantiza de forma idempotente la existencia de la tabla `password_reset_tokens`.
 * Almacena únicamente hashes SHA-256 de tokens temporales con expiración y marca de uso único;
 * al eliminarse un usuario, sus tokens se purgan en cascada (`ON DELETE CASCADE`).
 *
 * @returns {Promise<void>}
 */
const ensurePasswordResetTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(128) NOT NULL UNIQUE,
      expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      used_at TIMESTAMP WITHOUT TIME ZONE NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Lista las comunidades/countries habilitados para mostrarlos en selectores públicos
 * (por ejemplo, durante el registro de residentes y prestadores).
 * Consulta `countries` filtrando exclusivamente `is_active = TRUE` ordenados por `id`.
 * GET /api/v1/auth/countries
 *
 * @param {import('express').Request} _req - Petición HTTP (sin parámetros requeridos).
 * @param {import('express').Response} res - Respuesta HTTP con `{ countries }`.
 * @returns {Promise<import('express').Response>}
 */
const listPublicCountries = async (_req, res) => {
  try {
    // Consulta únicamente las comunidades activas para poblar el selector público
    const result = await db.query(
      `SELECT id, name
       FROM countries
       WHERE is_active = TRUE
       ORDER BY id ASC`
    );
    return res.status(200).json({ countries: result.rows });
  } catch (error) {
    console.error('Error al listar comunidades públicas:', error);
    return res.status(500).json({ error: 'Error interno al consultar comunidades activas.' });
  }
};

/**
 * Registra un nuevo usuario estándar (`owner`, `family` o `provider`) desde el flujo público.
 * Valida obligatoriedad de campos, lista blanca de roles, unicidad por correo/DNI,
 * normaliza la ubicación residencial (manzana/fracción y lote), asigna portales por defecto,
 * cifra la contraseña con bcrypt y persiste el alta en `users`.
 * POST /api/v1/auth/register
 *
 * @param {import('express').Request} req - Petición HTTP con los datos de alta en `req.body`.
 * @param {import('express').Response} res - Respuesta HTTP `201` con el usuario creado.
 * @returns {Promise<import('express').Response>}
 */
const register = async (req, res) => {
  try {
    // 1. Asegurar columnas evolutivas de portales/ubicación y extraer payload
    await ensureEvolutionSchema();

    const {
      country_id,
      role,
      first_name,
      last_name,
      dni,
      email,
      password,
      phone,
      fraction_type,
      fraction_number,
      fraction,
      lot_number,
      driver_license_url,
    } = req.body;

    // 2. Validar campos obligatorios y verificar que el rol esté permitido en registro público
    if (!role || !first_name || !last_name || !dni || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios para el registro.' });
    }

    const normalizedRole = String(role).trim().toLowerCase();
    if (!PUBLIC_ALLOWED_ROLES.includes(normalizedRole)) {
      return res.status(403).json({
        error: 'El rol solicitado no está habilitado para registro público.',
      });
    }

    // 3. Sanitizar identificadores y validar unicidad de email (insensible a mayúsculas) o DNI
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanDni = String(dni).trim();

    const userExists = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR dni = $2', [
      cleanEmail,
      cleanDni,
    ]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario registrado con ese correo electrónico o DNI.' });
    }

    // 4. Normalizar ubicación residencial: soporta alias `fraction` y deduce 'manzana' vs 'fraccion' si falta `fraction_type`
    const resolvedFractionNumber =
      fraction_number !== undefined && fraction_number !== null && String(fraction_number).trim() !== ''
        ? String(fraction_number).trim()
        : fraction !== undefined && fraction !== null && String(fraction).trim() !== ''
        ? String(fraction).trim()
        : null;

    const resolvedFractionType = fraction_type
      ? normalizeAreaType(fraction_type)
      : resolvedFractionNumber
      ? /^mz|^manzana/i.test(resolvedFractionNumber)
        ? 'manzana'
        : 'fraccion'
      : 'na';

    const resolvedLotNumber =
      lot_number !== undefined && lot_number !== null && String(lot_number).trim() !== ''
        ? String(lot_number).trim()
        : null;

    // 5. Resolver capacidades de portal según rol y generar hash bcrypt (factor de costo 10)
    const primaryPortal = getDefaultPrimaryPortal(normalizedRole);
    const canUseResident = ['owner', 'family', 'resident'].includes(normalizedRole);
    const canUseProvider = normalizedRole === 'provider';

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 6. Insertar registro en `users` con `initial_role` inmutable y `portals_configured = TRUE`
    const query = `
      INSERT INTO users (
        country_id, role, initial_role, first_name, last_name, dni, email, password_hash, phone,
        fraction_type, fraction_number, lot_number, driver_license_url,
        primary_portal, can_use_resident, can_use_provider, portals_configured
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, TRUE)
      RETURNING id, country_id, role, initial_role, first_name, last_name, dni, email, phone,
                fraction_type, fraction_number, lot_number,
                primary_portal, can_use_resident, can_use_provider,
                is_active, created_at;
    `;
    const values = [
      country_id || null,
      normalizedRole,
      normalizedRole,
      String(first_name).trim(),
      String(last_name).trim(),
      cleanDni,
      cleanEmail,
      passwordHash,
      phone ? String(phone).trim() : null,
      resolvedFractionType,
      resolvedFractionNumber,
      resolvedLotNumber,
      driver_license_url || null,
      primaryPortal,
      canUseResident,
      canUseProvider,
    ];

    const newUser = await db.query(query, values);

    return res.status(201).json({
      message: 'Usuario registrado exitosamente en la base de datos.',
      user: newUser.rows[0]
    });
  } catch (error) {
    console.error('Error en el registro:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar el registro.' });
  }
};

/**
 * Crea una cuenta privilegiada (`admin`, `superadmin` o `security`) desde Operaciones / Superadmin.
 * Regla de negocio: las cuentas `superadmin` son globales (`country_id = NULL`) y reciben
 * habilitación en ambos portales operativos (`can_use_resident` y `can_use_provider`),
 * mientras que `admin` y `security` quedan asociados a su `country_id`.
 * POST /api/v1/auth/privileged-users
 *
 * @param {import('express').Request} req - Petición HTTP con los datos de la cuenta privilegiada.
 * @param {import('express').Response} res - Respuesta HTTP `201` con la cuenta creada.
 * @returns {Promise<import('express').Response>}
 */
const createPrivilegedUser = async (req, res) => {
  try {
    // 1. Asegurar esquema evolutivo y validar presencia de campos requeridos
    await ensureEvolutionSchema();

    const { country_id, role, first_name, last_name, dni, email, password, phone } = req.body;

    if (!role || !first_name || !last_name || !dni || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios para crear la cuenta privilegiada.' });
    }

    // 2. Verificar que el rol solicitado pertenezca al conjunto privilegiado
    const normalizedRole = String(role).trim().toLowerCase();
    if (!PRIVILEGED_ALLOWED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: 'Rol privilegiado inválido (admin, superadmin o security).' });
    }

    // 3. Validar que el correo electrónico y el DNI no existan previamente en `users`
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanDni = String(dni).trim();

    const userExists = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR dni = $2', [
      cleanEmail,
      cleanDni,
    ]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario registrado con ese correo electrónico o DNI.' });
    }

    // 4. Cifrar contraseña y persistir cuenta privilegiada (superadmin sin country_id fijo y con ambos portales)
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const isSuper = normalizedRole === 'superadmin';
    const result = await db.query(
      `INSERT INTO users (
         country_id, role, initial_role, first_name, last_name, dni, email, password_hash, phone,
         primary_portal, can_use_resident, can_use_provider, portals_configured
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'resident', $10, $11, TRUE)
       RETURNING id, country_id, role, initial_role, first_name, last_name, dni, email, phone, is_active, created_at;`,
      [
        isSuper ? null : country_id || null,
        normalizedRole,
        normalizedRole,
        String(first_name).trim(),
        String(last_name).trim(),
        cleanDni,
        cleanEmail,
        passwordHash,
        phone ? String(phone).trim() : null,
        isSuper,
        isSuper,
      ]
    );

    return res.status(201).json({
      message: 'Cuenta privilegiada creada correctamente.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Error al crear cuenta privilegiada:', error);
    return res.status(500).json({ error: 'Error interno del servidor al crear la cuenta privilegiada.' });
  }
};

/**
 * Autentica un usuario por correo electrónico y contraseña, verificando que la cuenta
 * esté activa (`is_active = TRUE`) y emitiendo un JWT de sesión válido por 8 horas junto
 * con los metadatos de perfil, ubicación residencial y portales habilitados.
 * POST /api/v1/auth/login
 *
 * @param {import('express').Request} req - Petición HTTP con `{ email, password }`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ token, user }`.
 * @returns {Promise<import('express').Response>}
 */
const login = async (req, res) => {
  try {
    // 1. Asegurar esquema evolutivo y buscar al usuario por correo (insensible a mayúsculas)
    await ensureEvolutionSchema();
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [
      String(email || '').trim(),
    ]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];

    // 2. Bloquear acceso a cuentas suspendidas/inactivas y validar hash bcrypt
    if (!user.is_active) {
      return res.status(403).json({ error: 'La cuenta se encuentra inactiva.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // 3. Construir payload mínimo y firmar token JWT de sesión (vigencia 8 horas)
    const tokenPayload = {
      userId: user.id,
      countryId: user.country_id,
      role: user.role,
      email: user.email
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '8h' });

    // 4. Retornar token y snapshot saneado del usuario (con valores por defecto de ubicación/portales)
    return res.status(200).json({
      message: 'Inicio de sesión exitoso.',
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        country_id: user.country_id,
        fraction_type: user.fraction_type || 'na',
        fraction_number: user.fraction_number || null,
        lot_number: user.lot_number || null,
        primary_portal: user.primary_portal || getDefaultPrimaryPortal(user.role),
        can_use_resident: Boolean(user.can_use_resident),
        can_use_provider: Boolean(user.can_use_provider),
      }
    });
  } catch (error) {
    console.error('Error en el login:', error);
    return res.status(500).json({ error: 'Error interno del servidor al iniciar sesión.' });
  }
};

/**
 * Obtiene el listado completo de usuarios privilegiados (`superadmin`, `admin` y `security`)
 * para administración desde Ops Master, enriquecido con el nombre de la comunidad (`country_name`)
 * mediante `LEFT JOIN` (permanece `NULL` para cuentas globales `superadmin`).
 * GET /api/v1/auth/privileged-users
 *
 * @param {import('express').Request} req - Petición HTTP autenticada de Superadmin.
 * @param {import('express').Response} res - Respuesta HTTP con `{ count, users }`.
 * @returns {Promise<import('express').Response>}
 */
const getPrivilegedUsers = async (req, res) => {
  try {
    // Consulta los roles operativos internos ordenados del más reciente al más antiguo
    const query = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.dni, u.phone, u.role, u.country_id,
             c.name AS country_name, u.is_active, u.created_at
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE u.role IN ('superadmin', 'admin', 'security')
      ORDER BY u.created_at DESC;
    `;
    const result = await db.query(query);

    return res.status(200).json({
      count: result.rows.length,
      users: result.rows
    });
  } catch (error) {
    console.error('Error al obtener usuarios privilegiados:', error);
    return res.status(500).json({ error: 'Error interno del servidor al consultar usuarios.' });
  }
};

/**
 * Calcula métricas consolidadas de adquisición, identidad dual, activación del marketplace
 * y embudo operativo de visitas/pases/contratos/reseñas para Superadmin.
 * Excluye roles internos (`superadmin`, `admin`, `security`) de los indicadores del marketplace
 * (reportándolos aparte en `privileged_accounts`) para no distorsionar la relación Residente/Prestador.
 * Admite filtros opcionales `?country_id=<id>&period=all|7d|30d`.
 * GET /api/v1/auth/users/analytics
 *
 * @param {import('express').Request} req - Petición HTTP autenticada de Superadmin.
 * @param {import('express').Response} res - Respuesta HTTP con los 3 bloques de analítica.
 * @returns {Promise<import('express').Response>}
 */
const getUsersAnalytics = async (req, res) => {
  try {
    await ensureEvolutionSchema();

    // 1. Parsear filtros opcionales (comunidad y ventana temporal)
    const rawCountryId = req.query?.country_id;
    const countryId =
      rawCountryId !== undefined && rawCountryId !== '' && rawCountryId !== 'all'
        ? Number(rawCountryId)
        : null;
    if (countryId !== null && (!Number.isInteger(countryId) || countryId <= 0)) {
      return res.status(400).json({ error: 'country_id inválido.' });
    }

    const rawPeriod = String(req.query?.period || 'all').trim().toLowerCase();
    const period = ['7d', '30d', 'all'].includes(rawPeriod) ? rawPeriod : 'all';
    const intervalDays = period === '7d' ? 7 : period === '30d' ? 30 : null;

    // Helper para construir filtros parametrizados limpios
    const buildUserFilters = (alias = 'u', includePeriod = true) => {
      const clauses = [`LOWER(${alias}.role::text) NOT IN ('superadmin', 'admin', 'security')`];
      const params = [];
      if (countryId !== null) {
        params.push(countryId);
        clauses.push(`${alias}.country_id = $${params.length}`);
      }
      if (includePeriod && intervalDays !== null) {
        params.push(intervalDays);
        clauses.push(`${alias}.created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
      }
      return { whereSql: clauses.join(' AND '), params };
    };

    // 2. BLOQUE 1: Adquisición (`initial_role`) vs. Identidad Activa Hoy (`can_use_resident` / `can_use_provider`)
    const b1Filter = buildUserFilters('u', true);
    const block1Res = await db.query(
      `
      SELECT
        COUNT(*)::int AS total_community_users,
        COUNT(*) FILTER (WHERE u.is_active = TRUE)::int AS active_community_users,
        COUNT(*) FILTER (
          WHERE COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) IN ('owner', 'family', 'resident')
        )::int AS created_as_resident,
        COUNT(*) FILTER (
          WHERE COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider'
        )::int AS created_as_provider,
        COUNT(*) FILTER (WHERE COALESCE(u.can_use_resident, FALSE) = TRUE)::int AS active_resident_today,
        COUNT(*) FILTER (WHERE COALESCE(u.can_use_provider, FALSE) = TRUE)::int AS active_provider_today,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = FALSE
        )::int AS only_resident,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = FALSE AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )::int AS only_provider,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )::int AS dual_accounts,
        COUNT(*) FILTER (
          WHERE COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) IN ('owner', 'family', 'resident')
            AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )::int AS resident_to_provider_count,
        COUNT(*) FILTER (
          WHERE COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider'
            AND COALESCE(u.can_use_resident, FALSE) = TRUE
        )::int AS provider_to_resident_count
      FROM users u
      WHERE ${b1Filter.whereSql}
      `,
      b1Filter.params
    );

    const privCountRes = await db.query(
      countryId !== null
        ? `SELECT COUNT(*)::int AS cnt FROM users WHERE LOWER(role::text) IN ('superadmin', 'admin', 'security') AND (country_id = $1 OR LOWER(role::text) = 'superadmin')`
        : `SELECT COUNT(*)::int AS cnt FROM users WHERE LOWER(role::text) IN ('superadmin', 'admin', 'security')`,
      countryId !== null ? [countryId] : []
    );

    const b1Raw = block1Res.rows[0] || {};
    const createdAsResident = Number(b1Raw.created_as_resident || 0);
    const createdAsProvider = Number(b1Raw.created_as_provider || 0);
    const resToProv = Number(b1Raw.resident_to_provider_count || 0);
    const provToRes = Number(b1Raw.provider_to_resident_count || 0);

    const block1_identity = {
      total_community_users: Number(b1Raw.total_community_users || 0),
      active_community_users: Number(b1Raw.active_community_users || 0),
      created_as_resident: createdAsResident,
      created_as_provider: createdAsProvider,
      active_resident_today: Number(b1Raw.active_resident_today || 0),
      active_provider_today: Number(b1Raw.active_provider_today || 0),
      only_resident: Number(b1Raw.only_resident || 0),
      only_provider: Number(b1Raw.only_provider || 0),
      dual_accounts: Number(b1Raw.dual_accounts || 0),
      resident_to_provider_count: resToProv,
      resident_to_provider_pct:
        createdAsResident > 0 ? Math.round((resToProv / createdAsResident) * 100) : 0,
      provider_to_resident_count: provToRes,
      provider_to_resident_pct:
        createdAsProvider > 0 ? Math.round((provToRes / createdAsProvider) * 100) : 0,
      privileged_accounts: Number(privCountRes.rows[0]?.cnt || 0),
    };

    // 3. BLOQUE 2: Embudo de Activación (Salud del Marketplace, deduplicado por user_id)
    const b2Filter = buildUserFilters('u', true);
    const block2Res = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(u.can_use_provider, FALSE) = TRUE)::int AS providers_registered,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND EXISTS (
              SELECT 1 FROM providers p WHERE p.user_id = u.id AND p.status = 'approved'::provider_status
            )
        )::int AS providers_approved,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND NOT EXISTS (
              SELECT 1 FROM providers p WHERE p.user_id = u.id AND p.status = 'approved'::provider_status
            )
        )::int AS providers_pending_compliance,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND EXISTS (
              SELECT 1 FROM providers p
              WHERE p.user_id = u.id
                AND (
                  (p.criminal_record_expiry IS NOT NULL AND p.criminal_record_expiry < CURRENT_DATE)
                  OR (p.insurance_expiry IS NOT NULL AND p.insurance_expiry < CURRENT_DATE)
                )
            )
        )::int AS providers_with_expired_docs,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND (
              EXISTS (SELECT 1 FROM provider_availability_rules par WHERE par.user_id = u.id)
              OR EXISTS (
                SELECT 1 FROM provider_schedule_blocks psb
                JOIN providers p ON p.id = psb.provider_id
                WHERE p.user_id = u.id
              )
            )
        )::int AS providers_with_schedule,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND (
              EXISTS (
                SELECT 1 FROM visit_requests vr
                JOIN providers p ON p.id = vr.provider_id
                WHERE p.user_id = u.id
              )
              OR EXISTS (
                SELECT 1 FROM access_passes ap
                JOIN providers p ON p.id = ap.provider_id
                WHERE p.user_id = u.id
              )
            )
        )::int AS providers_with_activity,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND EXISTS (
              SELECT 1 FROM provider_subscriptions ps
              WHERE ps.user_id = u.id AND ps.status = 'active' AND ps.ends_at > NOW()
            )
        )::int AS providers_verified_members,
        COUNT(*) FILTER (WHERE COALESCE(u.can_use_resident, FALSE) = TRUE)::int AS residents_registered,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE
            AND u.lot_number IS NOT NULL AND BTRIM(u.lot_number::text) <> ''
        )::int AS residents_with_lot,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE
            AND (
              EXISTS (SELECT 1 FROM visit_requests vr WHERE vr.owner_id = u.id)
              OR EXISTS (SELECT 1 FROM access_passes ap WHERE ap.owner_id = u.id)
            )
        )::int AS residents_active_ops
      FROM users u
      WHERE ${b2Filter.whereSql}
      `,
      b2Filter.params
    );

    const b2Raw = block2Res.rows[0] || {};
    const providersApproved = Number(b2Raw.providers_approved || 0);
    const residentsRegistered = Number(b2Raw.residents_registered || 0);

    const block2_activation = {
      providers_registered: Number(b2Raw.providers_registered || 0),
      providers_approved: providersApproved,
      providers_pending_compliance: Number(b2Raw.providers_pending_compliance || 0),
      providers_with_expired_docs: Number(b2Raw.providers_with_expired_docs || 0),
      providers_with_schedule: Number(b2Raw.providers_with_schedule || 0),
      providers_with_activity: Number(b2Raw.providers_with_activity || 0),
      providers_verified_members: Number(b2Raw.providers_verified_members || 0),
      residents_registered: residentsRegistered,
      residents_with_lot: Number(b2Raw.residents_with_lot || 0),
      residents_active_ops: Number(b2Raw.residents_active_ops || 0),
      residents_per_approved_provider:
        providersApproved > 0 ? Number((residentsRegistered / providersApproved).toFixed(1)) : null,
    };

    // 4. BLOQUE 3A: Crecimiento reciente (7d y 30d) siempre sobre la comunidad filtrada
    const growthFilter = buildUserFilters('u', false);
    const growthRes = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '7 days')::int AS last_7d_total,
        COUNT(*) FILTER (
          WHERE u.created_at >= NOW() - INTERVAL '7 days'
            AND COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) IN ('owner', 'family', 'resident')
        )::int AS last_7d_residents,
        COUNT(*) FILTER (
          WHERE u.created_at >= NOW() - INTERVAL '7 days'
            AND COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider'
        )::int AS last_7d_providers,
        COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '30 days')::int AS last_30d_total,
        COUNT(*) FILTER (
          WHERE u.created_at >= NOW() - INTERVAL '30 days'
            AND COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) IN ('owner', 'family', 'resident')
        )::int AS last_30d_residents,
        COUNT(*) FILTER (
          WHERE u.created_at >= NOW() - INTERVAL '30 days'
            AND COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider'
        )::int AS last_30d_providers
      FROM users u
      WHERE ${growthFilter.whereSql}
      `,
      growthFilter.params
    );

    // 5. BLOQUE 3B: Embudo operativo de punta a punta (Visitas -> Acuerdos -> QR -> Garita -> Contratos -> Reseñas)
    const buildOpFilter = (tableAlias, countryColSql) => {
      const clauses = ['1=1'];
      const params = [];
      if (countryId !== null) {
        params.push(countryId);
        clauses.push(`${countryColSql} = $${params.length}`);
      }
      if (intervalDays !== null) {
        params.push(intervalDays);
        clauses.push(`${tableAlias}.created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
      }
      return { whereSql: clauses.join(' AND '), params };
    };

    const vrF = buildOpFilter('vr', 'ou.country_id');
    const apF = buildOpFilter('ap', 'ap.country_id');
    const scF = buildOpFilter('sc', 'ou.country_id');
    const prF = buildOpFilter('pr', 'ou.country_id');

    const [vrRes, apRes, scRes, prRes] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int AS requested,
           COUNT(*) FILTER (WHERE LOWER(vr.status) = 'confirmed')::int AS confirmed
         FROM visit_requests vr
         LEFT JOIN users ou ON ou.id = vr.owner_id
         WHERE ${vrF.whereSql}`,
        vrF.params
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS emitted,
           COUNT(*) FILTER (WHERE ap.status = 'used'::pass_status)::int AS used_gate
         FROM access_passes ap
         WHERE ${apF.whereSql}`,
        apF.params
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS created,
           COUNT(*) FILTER (WHERE sc.status = 'completed'::contract_status)::int AS completed
         FROM service_contracts sc
         LEFT JOIN users ou ON ou.id = sc.owner_id
         WHERE ${scF.whereSql}`,
        scF.params
      ),
      db.query(
        `SELECT COUNT(*)::int AS submitted
         FROM provider_reviews pr
         LEFT JOIN users ou ON ou.id = pr.owner_id
         WHERE ${prF.whereSql}`,
        prF.params
      ),
    ]);

    // 6. BLOQUE 3C: Desglose comparativo por comunidad
    const communityParams = [];
    let communityPeriodSql = '';
    if (intervalDays !== null) {
      communityParams.push(intervalDays);
      communityPeriodSql = `AND u.created_at >= NOW() - ($${communityParams.length}::int * INTERVAL '1 day')`;
    }
    let communityWhereSql = 'WHERE c.is_active = TRUE';
    if (countryId !== null) {
      communityParams.push(countryId);
      communityWhereSql += ` AND c.id = $${communityParams.length}`;
    }

    const byCommunityRes = await db.query(
      `
      SELECT
        c.id AS country_id,
        c.name AS country_name,
        COUNT(u.id)::int AS total_users,
        COUNT(u.id) FILTER (
          WHERE COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) IN ('owner', 'family', 'resident')
        )::int AS created_as_resident,
        COUNT(u.id) FILTER (
          WHERE COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider'
        )::int AS created_as_provider,
        COUNT(u.id) FILTER (WHERE COALESCE(u.can_use_resident, FALSE) = TRUE)::int AS active_resident_today,
        COUNT(u.id) FILTER (WHERE COALESCE(u.can_use_provider, FALSE) = TRUE)::int AS active_provider_today,
        COUNT(u.id) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )::int AS dual_accounts,
        COUNT(u.id) FILTER (
          WHERE COALESCE(u.can_use_provider, FALSE) = TRUE
            AND EXISTS (
              SELECT 1 FROM providers p WHERE p.user_id = u.id AND p.status = 'approved'::provider_status
            )
        )::int AS approved_providers
      FROM countries c
      LEFT JOIN users u
        ON u.country_id = c.id
       AND LOWER(u.role::text) NOT IN ('superadmin', 'admin', 'security')
       ${communityPeriodSql}
      ${communityWhereSql}
      GROUP BY c.id, c.name
      ORDER BY total_users DESC, c.id ASC
      `,
      communityParams
    );

    const gRaw = growthRes.rows[0] || {};
    return res.status(200).json({
      filters: { country_id: countryId, period },
      generated_at: new Date().toISOString(),
      block1_identity,
      block2_activation,
      block3_operations: {
        growth: {
          last_7d_total: Number(gRaw.last_7d_total || 0),
          last_7d_residents: Number(gRaw.last_7d_residents || 0),
          last_7d_providers: Number(gRaw.last_7d_providers || 0),
          last_30d_total: Number(gRaw.last_30d_total || 0),
          last_30d_residents: Number(gRaw.last_30d_residents || 0),
          last_30d_providers: Number(gRaw.last_30d_providers || 0),
        },
        funnel: {
          visits_requested: Number(vrRes.rows[0]?.requested || 0),
          visits_confirmed: Number(vrRes.rows[0]?.confirmed || 0),
          passes_emitted: Number(apRes.rows[0]?.emitted || 0),
          passes_used_gate: Number(apRes.rows[0]?.used_gate || 0),
          contracts_created: Number(scRes.rows[0]?.created || 0),
          contracts_completed: Number(scRes.rows[0]?.completed || 0),
          reviews_submitted: Number(prRes.rows[0]?.submitted || 0),
        },
        by_community: byCommunityRes.rows,
      },
    });
  } catch (error) {
    console.error('Error al calcular analítica de usuarios y comunidad:', error);
    return res.status(500).json({ error: 'Error interno al calcular las métricas de usuarios.' });
  }
};

/**
 * Actualiza de forma parcial los datos, rol, comunidad asignada, estado activo o contraseña
 * de una cuenta privilegiada existente (`superadmin`, `admin` o `security`).
 * Si el rol pasa a ser `superadmin`, fuerza `country_id = NULL` (alcance global).
 * PUT/PATCH /api/v1/auth/privileged-users/:id
 *
 * @param {import('express').Request} req - Petición HTTP con `:id` en params y campos opcionales en body.
 * @param {import('express').Response} res - Respuesta HTTP con la cuenta actualizada.
 * @returns {Promise<import('express').Response>}
 */
const updatePrivilegedUser = async (req, res) => {
  try {
    // 1. Extraer identificador y validar el nuevo rol privilegiado si fue incluido en la petición
    const { id } = req.params;
    const { first_name, last_name, email, dni, phone, password, role, country_id, is_active } = req.body;

    if (role !== undefined && !PRIVILEGED_ALLOWED_ROLES.includes(String(role).toLowerCase())) {
      return res.status(400).json({ error: 'Rol inválido (admin, superadmin o security).' });
    }

    // 2. Resolver `country_id` según regla de negocio: superadmin siempre limpia comunidad a NULL
    const normalizedRole = role !== undefined ? String(role).toLowerCase() : null;
    const resolvedCountryId =
      normalizedRole === 'superadmin'
        ? null
        : country_id !== undefined
        ? country_id === '' || country_id === null
          ? null
          : Number(country_id)
        : undefined;

    // 3. Construir cláusulas SET dinámicas para campos opcionales (teléfono, comunidad y nueva contraseña)
    let extraSet = '';
    const values = [first_name, last_name, email, dni, normalizedRole, is_active, id];

    if (phone !== undefined) {
      values.push(phone ? String(phone).trim() : null);
      extraSet += `, phone = $${values.length}`;
    }

    if (resolvedCountryId !== undefined) {
      values.push(resolvedCountryId);
      extraSet += `, country_id = $${values.length}`;
    }

    if (password && password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      values.push(hashedPassword);
      extraSet += `, password_hash = $${values.length}`;
    }

    // 4. Actualizar usando COALESCE para conservar valores previos en campos no enviados, restringido a roles privilegiados
    const query = `
      UPDATE users
      SET first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          email = COALESCE($3, email),
          dni = COALESCE($4, dni),
          role = COALESCE($5, role),
          is_active = COALESCE($6, is_active)
          ${extraSet}
      WHERE id = $7 AND role IN ('superadmin', 'admin', 'security')
      RETURNING id, first_name, last_name, email, dni, phone, role, country_id, is_active, created_at;
    `;

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario privilegiado no encontrado.' });
    }

    return res.status(200).json({
      message: 'Usuario actualizado exitosamente.',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar usuario privilegiado:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el usuario.' });
  }
};

/**
 * Solicita recuperación de contraseña generando un token temporal (30 min) almacenado como hash SHA-256.
 * Nunca revela si el correo existe o está activo en la base de datos (mitiga enumeración de cuentas).
 * Invalida tokens previos pendientes del mismo usuario antes de emitir el nuevo.
 * POST /api/v1/auth/forgot-password
 *
 * @param {import('express').Request} req - Petición HTTP con `{ email }`.
 * @param {import('express').Response} res - Respuesta HTTP genérica (incluye `dev_reset_token` fuera de producción).
 * @returns {Promise<import('express').Response>}
 */
const forgotPassword = async (req, res) => {
  try {
    // 1. Garantizar existencia de tabla y normalizar correo recibido
    await ensurePasswordResetTable();
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();

    if (!cleanEmail) {
      return res.status(400).json({ error: 'Ingresá tu correo electrónico para recuperar la cuenta.' });
    }

    const genericResponse = {
      message:
        'Si el correo corresponde a una cuenta activa, se generó un código de recuperación válido por 30 minutos.',
    };

    // 2. Buscar cuenta activa; si no existe o está inactiva, responder igual que un caso válido (anti-enumeración)
    const userRes = await db.query(
      'SELECT id, email, is_active FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [cleanEmail]
    );

    if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
      return res.status(200).json(genericResponse);
    }

    // 3. Generar token criptográfico aleatorio (48 caracteres hex) y derivar su hash SHA-256 para almacenamiento seguro
    const userId = userRes.rows[0].id;
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // 4. Invalidar tokens previos sin usar del mismo usuario y registrar el nuevo con vencimiento de 30 minutos
    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
      [userId]
    );

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
      [userId, tokenHash]
    );

    // 5. En entornos de desarrollo/pruebas se devuelve el token plano para facilitar validación local
    if (process.env.NODE_ENV !== 'production') {
      return res.status(200).json({
        ...genericResponse,
        dev_reset_token: rawToken,
      });
    }

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error('Error en forgotPassword:', error);
    return res.status(500).json({ error: 'Error interno al solicitar recuperación de contraseña.' });
  }
};

/**
 * Restablece la contraseña de un usuario validando un token temporal vigente y no consumido.
 * Calcula el hash SHA-256 del token recibido para localizarlo, actualiza `users.password_hash`
 * con bcrypt y marca el token como utilizado (`used_at = NOW()`) para evitar reutilización.
 * POST /api/v1/auth/reset-password
 *
 * @param {import('express').Request} req - Petición HTTP con `{ token, new_password }`.
 * @param {import('express').Response} res - Respuesta HTTP confirmando el cambio de contraseña.
 * @returns {Promise<import('express').Response>}
 */
const resetPassword = async (req, res) => {
  try {
    // 1. Asegurar tabla de tokens y validar presencia del código y longitud mínima de la nueva clave
    await ensurePasswordResetTable();
    const rawToken = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.new_password || '');

    if (!rawToken || newPassword.length < 6) {
      return res.status(400).json({
        error: 'Debe ingresar el código de recuperación y una nueva contraseña de al menos 6 caracteres.',
      });
    }

    // 2. Buscar el registro por hash SHA-256 y verificar vigencia temporal y que no haya sido consumido
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const tokenRes = await db.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token_hash = $1
       LIMIT 1`,
      [tokenHash]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ error: 'El código de recuperación es inválido o expiró.' });
    }

    const record = tokenRes.rows[0];
    if (record.used_at || new Date(record.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'El código de recuperación ya fue utilizado o expiró.' });
    }

    // 3. Cifrar la nueva contraseña, actualizar `users` y marcar el token como consumido
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, record.user_id]);
    await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);

    return res.status(200).json({
      message: 'Contraseña actualizada correctamente. Ya podés iniciar sesión.',
    });
  } catch (error) {
    console.error('Error en resetPassword:', error);
    return res.status(500).json({ error: 'Error interno al restablecer la contraseña.' });
  }
};

/**
 * Lista con paginación y filtros las cuentas generales de la comunidad (Residentes, Prestadores y Duales),
 * excluyendo roles privilegiados internos (`superadmin`, `admin`, `security`).
 * Expone tanto el origen inmutable de registro (`initial_origin`) como el perfil activo actual (`current_profile`)
 * para trazabilidad directa con el tablero de métricas.
 * GET /api/v1/auth/users/community
 *
 * @param {import('express').Request} req - Petición HTTP autenticada de Superadmin con filtros opcionales en query.
 * @param {import('express').Response} res - Respuesta HTTP con `{ users, summary, pagination }`.
 * @returns {Promise<import('express').Response>}
 */
const getCommunityUsers = async (req, res) => {
  try {
    await ensureEvolutionSchema();

    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query?.limit, 10) || 10));
    const offset = (page - 1) * limit;

    const search = String(req.query?.search || '').trim();
    const rawCountryId = req.query?.country_id;
    const countryId =
      rawCountryId !== undefined && rawCountryId !== '' && rawCountryId !== 'all'
        ? Number(rawCountryId)
        : null;
    if (countryId !== null && (!Number.isInteger(countryId) || countryId <= 0)) {
      return res.status(400).json({ error: 'country_id inválido.' });
    }

    const initialOrigin = String(req.query?.initial_origin || 'all').trim().toLowerCase();
    const currentProfile = String(req.query?.current_profile || 'all').trim().toLowerCase();
    const statusFilter = String(req.query?.status || 'all').trim().toLowerCase();

    // Base siempre restringida a usuarios comunitarios (excluye operadores internos)
    const baseClauses = [`LOWER(u.role::text) NOT IN ('superadmin', 'admin', 'security')`];
    const baseParams = [];
    if (countryId !== null) {
      baseParams.push(countryId);
      baseClauses.push(`u.country_id = $${baseParams.length}`);
    }

    // Resumen rápido de composición sobre la comunidad filtrada (para los chips del directorio)
    const summaryRes = await db.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = FALSE
        )::int AS only_resident,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = FALSE AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )::int AS only_provider,
        COUNT(*) FILTER (
          WHERE COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )::int AS dual,
        COUNT(*) FILTER (WHERE u.is_active = FALSE)::int AS inactive
      FROM users u
      WHERE ${baseClauses.join(' AND ')}
      `,
      baseParams
    );

    // Filtros dinámicos del listado paginado
    const clauses = [...baseClauses];
    const params = [...baseParams];

    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      clauses.push(
        `(
          u.first_name ILIKE ${p}
          OR u.last_name ILIKE ${p}
          OR (u.first_name || ' ' || u.last_name) ILIKE ${p}
          OR u.email ILIKE ${p}
          OR u.dni ILIKE ${p}
          OR COALESCE(u.lot_number, '') ILIKE ${p}
          OR COALESCE(u.fraction_number, '') ILIKE ${p}
          OR COALESCE(c.name, '') ILIKE ${p}
        )`
      );
    }

    if (initialOrigin === 'resident') {
      clauses.push(
        `COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) IN ('owner', 'family', 'resident')`
      );
    } else if (initialOrigin === 'provider') {
      clauses.push(
        `COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider'`
      );
    }

    if (currentProfile === 'only_resident') {
      clauses.push(
        `COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = FALSE`
      );
    } else if (currentProfile === 'only_provider') {
      clauses.push(
        `COALESCE(u.can_use_resident, FALSE) = FALSE AND COALESCE(u.can_use_provider, FALSE) = TRUE`
      );
    } else if (currentProfile === 'dual') {
      clauses.push(
        `COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = TRUE`
      );
    }

    if (statusFilter === 'active') {
      clauses.push(`u.is_active = TRUE`);
    } else if (statusFilter === 'inactive') {
      clauses.push(`u.is_active = FALSE`);
    }

    const whereSql = clauses.join(' AND ');

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       LEFT JOIN countries c ON c.id = u.country_id
       WHERE ${whereSql}`,
      params
    );
    const totalFiltered = Number(countRes.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));

    const dataParams = [...params, limit, offset];
    const limitIdx = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    const listRes = await db.query(
      `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.dni,
        u.phone,
        u.role,
        COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) AS initial_role,
        CASE
          WHEN COALESCE(NULLIF(LOWER(u.initial_role), ''), LOWER(u.role::text)) = 'provider' THEN 'provider'
          ELSE 'resident'
        END AS initial_origin,
        CASE
          WHEN COALESCE(u.can_use_resident, FALSE) = TRUE AND COALESCE(u.can_use_provider, FALSE) = TRUE THEN 'dual'
          WHEN COALESCE(u.can_use_provider, FALSE) = TRUE THEN 'only_provider'
          ELSE 'only_resident'
        END AS current_profile,
        COALESCE(u.can_use_resident, FALSE) AS can_use_resident,
        COALESCE(u.can_use_provider, FALSE) AS can_use_provider,
        COALESCE(u.primary_portal, 'resident') AS primary_portal,
        u.country_id,
        c.name AS country_name,
        COALESCE(u.fraction_type, 'na') AS fraction_type,
        u.fraction_number,
        u.lot_number,
        u.is_active,
        u.created_at,
        (SELECT COUNT(*)::int FROM providers p WHERE p.user_id = u.id) AS provider_specialties_count,
        EXISTS (
          SELECT 1 FROM providers p WHERE p.user_id = u.id AND p.status = 'approved'::provider_status
        ) AS provider_approved
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE ${whereSql}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataParams
    );

    const sRaw = summaryRes.rows[0] || {};
    return res.status(200).json({
      users: listRes.rows,
      summary: {
        total: Number(sRaw.total || 0),
        only_resident: Number(sRaw.only_resident || 0),
        only_provider: Number(sRaw.only_provider || 0),
        dual: Number(sRaw.dual || 0),
        inactive: Number(sRaw.inactive || 0),
      },
      pagination: {
        page,
        limit,
        total: totalFiltered,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error al listar cuentas generales de comunidad:', error);
    return res.status(500).json({ error: 'Error interno al consultar las cuentas de comunidad.' });
  }
};

/**
 * Activa o suspende de forma segura una cuenta comunitaria (Residente, Prestador o Dual)
 * sin alterar su historial ni permitir operar sobre cuentas privilegiadas.
 * PATCH /api/v1/auth/users/community/:id/toggle
 *
 * @param {import('express').Request} req - Petición HTTP con `:id` en params y `{ is_active }` en body.
 * @param {import('express').Response} res - Respuesta HTTP con la cuenta actualizada.
 * @returns {Promise<import('express').Response>}
 */
const toggleCommunityUserStatus = async (req, res) => {
  try {
    const userId = Number(req.params?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'ID de usuario inválido.' });
    }
    if (typeof req.body?.is_active !== 'boolean') {
      return res.status(400).json({ error: 'Debe indicar el campo booleano is_active.' });
    }

    const result = await db.query(
      `
      UPDATE users
      SET is_active = $1
      WHERE id = $2
        AND LOWER(role::text) NOT IN ('superadmin', 'admin', 'security')
      RETURNING id, first_name, last_name, email, is_active
      `,
      [req.body.is_active, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cuenta comunitaria no encontrada.' });
    }

    return res.status(200).json({
      message: req.body.is_active
        ? 'Cuenta reactivada correctamente.'
        : 'Cuenta suspendida correctamente.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar estado de cuenta comunitaria:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el estado de la cuenta.' });
  }
};

module.exports = {
  listPublicCountries,
  register,
  login,
  forgotPassword,
  resetPassword,
  createPrivilegedUser,
  getPrivilegedUsers,
  updatePrivilegedUser,
  getUsersAnalytics,
  getCommunityUsers,
  toggleCommunityUserStatus,
};