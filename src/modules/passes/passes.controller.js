/**
 * @file passes.controller.js
 * @description Controlador para agenda online del prestador (horarios bloqueados, visitas externas
 * y bloqueo automático), coordinación bidireccional de visitas, emisión con ubicación automática
 * y bloqueada desde los datos del residente (Manzana/Fracción/N/A y Lote), consulta, edición,
 * cancelación y validación perimetral en garita.
 * @location /trustlink-backend/src/modules/passes/passes.controller.js
 */

const crypto = require('crypto');
const db = require('../../config/db');
const { ensureEvolutionSchema } = require('../../config/ensureEvolutionSchema');
const {
  findComplianceExpiryViolation,
  hydrateAuthorizedEmployeesExpiry,
} = require('../../utils/complianceExpiry');
const {
  normalizeWeeklyRulesInput,
  mergeWithDefaultRules,
  buildScheduleSummaryText,
  buildMultiDayAvailability,
} = require('../../utils/scheduleAvailability');

/**
 * Asegura de forma idempotente la tabla `provider_availability_rules` (Fase 5.4)
 * donde cada prestador configura su jornada semanal (días laborables, desde/hasta e intervalo 30/60 min).
 *
 * @returns {Promise<void>}
 */
const ensureAvailabilityRulesTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.provider_availability_rules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      day_of_week SMALLINT NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
      is_working BOOLEAN NOT NULL DEFAULT TRUE,
      start_time VARCHAR(5) NOT NULL DEFAULT '08:00',
      end_time VARCHAR(5) NOT NULL DEFAULT '18:00',
      slot_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (slot_minutes IN (30, 60)),
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, day_of_week)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_provider_availability_rules_user
    ON public.provider_availability_rules (user_id, day_of_week);
  `);
};

/**
 * Asegura de forma idempotente la existencia de la tabla `gate_access_logs`
 * para auditar cada validación ejecutada desde la Consola Garita.
 *
 * @returns {Promise<void>}
 */
const ensureGateAccessLogsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gate_access_logs (
      id SERIAL PRIMARY KEY,
      qr_token VARCHAR(255) NULL,
      pass_id INTEGER NULL,
      country_id INTEGER NULL,
      integration_label VARCHAR(120) NULL,
      auth_mode VARCHAR(40) NOT NULL DEFAULT 'jwt',
      authorized BOOLEAN NOT NULL DEFAULT FALSE,
      reason_code VARCHAR(80) NOT NULL,
      message TEXT NOT NULL,
      http_status INTEGER NOT NULL DEFAULT 200,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Enmascara un token QR conservando sus primeros 8 y últimos 6 caracteres
 * para registrar trazabilidad en auditoría sin exponer el token íntegro.
 *
 * @param {string|null|undefined} token - Token QR original.
 * @returns {string|null} Token enmascarado o `null` si no fue provisto.
 */
const maskQrToken = (token) => {
  if (!token) return null;
  const clean = String(token).trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 8)}...${clean.slice(-6)}`;
};

/**
 * Registra de forma tolerante a fallos un evento de validación QR en `gate_access_logs`.
 * Si ocurre un error de escritura, se loguea en consola sin bloquear la respuesta de garita.
 *
 * @param {Object} params - Metadatos del intento de acceso.
 * @param {string} [params.qrToken] - Token QR evaluado (se guarda enmascarado).
 * @param {number|null} [params.passId=null] - ID del pase si se encontró.
 * @param {number|null} [params.countryId=null] - ID de la comunidad correspondiente.
 * @param {string} [params.integrationLabel='Consola Garita'] - Origen de la validación.
 * @param {string} [params.authMode='jwt'] - Modo de autenticación utilizado.
 * @param {boolean} [params.authorized=false] - Resultado de la autorización.
 * @param {string} [params.reasonCode='UNKNOWN'] - Código normalizado del resultado.
 * @param {string} [params.message=''] - Mensaje descriptivo mostrado al operador.
 * @param {number} [params.httpStatus=200] - Código HTTP devuelto por el endpoint.
 * @returns {Promise<void>}
 */
const recordGateAccessLog = async ({
  qrToken,
  passId = null,
  countryId = null,
  integrationLabel = 'Consola Garita',
  authMode = 'jwt',
  authorized = false,
  reasonCode = 'UNKNOWN',
  message = '',
  httpStatus = 200,
}) => {
  try {
    await ensureGateAccessLogsTable();
    await db.query(
      `INSERT INTO gate_access_logs (
         qr_token, pass_id, country_id, integration_label, auth_mode,
         authorized, reason_code, message, http_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        maskQrToken(qrToken),
        passId,
        countryId,
        integrationLabel,
        authMode,
        authorized,
        reasonCode,
        message,
        httpStatus,
      ]
    );
  } catch (err) {
    console.error('Error al registrar auditoría en gate_access_logs:', err);
  }
};

/**
 * Busca si existe una suspensión operativa local activa para un prestador dentro
 * de una comunidad específica (`provider_local_suspensions`).
 * Verifica primero la existencia de la tabla para mantener compatibilidad con esquemas parciales.
 *
 * @param {number|string|null} countryId - ID de la comunidad donde se intenta ingresar.
 * @param {number|string|null} providerId - ID del perfil de prestador.
 * @returns {Promise<{id: number, reason: string}|null>} Registro de suspensión activa o `null`.
 */
const findActiveLocalSuspension = async (countryId, providerId) => {
  if (!countryId || !providerId) return null;
  try {
    // Paso 1: Comprobar si la tabla de suspensiones locales existe en el esquema `public`
    const tableCheck = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'provider_local_suspensions'
       LIMIT 1`
    );
    if (tableCheck.rows.length === 0) return null;

    // Paso 2: Obtener la suspensión activa más reciente para el par (comunidad, prestador)
    const res = await db.query(
      `SELECT id, reason
       FROM public.provider_local_suspensions
       WHERE country_id = $1 AND provider_id = $2 AND active = TRUE
       ORDER BY id DESC
       LIMIT 1`,
      [Number(countryId), Number(providerId)]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('Aviso al consultar suspensiones locales en garita:', err.message);
    return null;
  }
};

/**
 * Crea o actualiza de forma idempotente la tabla `visit_requests` y todas sus columnas
 * para soportar el flujo de coordinación bidireccional de visitas entre residentes y prestadores.
 *
 * @returns {Promise<void>}
 */
const ensureVisitRequestsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS visit_requests (
      id SERIAL PRIMARY KEY,
      country_id INTEGER NULL,
      owner_id INTEGER NOT NULL,
      provider_id INTEGER NOT NULL,
      fraction_number VARCHAR(100) NULL,
      lot_number VARCHAR(100) NULL,
      preferred_date VARCHAR(50) NULL,
      preferred_end_date VARCHAR(40) NULL,
      service_title VARCHAR(160) NULL,
      service_specialty VARCHAR(120) NULL,
      notes TEXT NULL,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_provider',
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  // Garantizar columnas adicionales en instalaciones creadas con versiones anteriores
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS country_id INTEGER NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS fraction_number VARCHAR(100) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS lot_number VARCHAR(100) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS preferred_date VARCHAR(50) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS preferred_end_date VARCHAR(40) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS service_title VARCHAR(160) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS service_specialty VARCHAR(120) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS notes TEXT NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending_provider';`);
};

/**
 * Calcula una fecha/hora de fin válida para una solicitud de visita asegurando un mínimo
 * obligatorio de 60 minutos desde el inicio (contemplando visita y traslado entre barrios).
 *
 * @param {string|null|undefined} startRaw - Fecha/hora de inicio propuesta.
 * @param {string|null|undefined} endRaw - Fecha/hora de fin opcional enviada por el cliente.
 * @param {number} [durationMinutes=60] - Duración deseada en minutos (mínimo 60).
 * @returns {string|null} ISO UTC de fin o `null` si no hay fecha de inicio válida.
 */
const resolveVisitEndDate = (startRaw, endRaw = null, durationMinutes = 60) => {
  if (!startRaw) return null;
  const startDate = new Date(startRaw);
  if (Number.isNaN(startDate.getTime())) return null;

  const minEndMs = startDate.getTime() + 60 * 60 * 1000; // Mínimo 1 hora
  if (endRaw) {
    const parsedEnd = new Date(endRaw);
    if (!Number.isNaN(parsedEnd.getTime()) && parsedEnd.getTime() >= minEndMs) {
      return parsedEnd.toISOString();
    }
  }
  const safeDuration = Math.max(60, Number(durationMinutes) || 60);
  return new Date(startDate.getTime() + safeDuration * 60 * 1000).toISOString();
};

/**
 * Crea o actualiza de forma idempotente la tabla `provider_schedule_blocks`
 * para gestionar horarios no laborables (`unavailable`), visitas externas (`external_visit`)
 * y reservas automáticas vinculadas a visitas/pases de TrustLink (`trustlink_visit`, `trustlink_pass`).
 *
 * @returns {Promise<void>}
 */
const ensureScheduleBlocksTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_schedule_blocks (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL,
      block_type VARCHAR(30) NOT NULL DEFAULT 'unavailable',
      title VARCHAR(160) NOT NULL,
      start_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      end_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      source_ref VARCHAR(80) NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  // Asegurar columnas requeridas en esquemas previos
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS block_type VARCHAR(30) NOT NULL DEFAULT 'unavailable';`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS title VARCHAR(160) NULL;`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS start_at TIMESTAMP WITHOUT TIME ZONE NULL;`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS end_at TIMESTAMP WITHOUT TIME ZONE NULL;`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS source_ref VARCHAR(80) NULL;`);
};

/**
 * Inserta o actualiza (upsert) un bloque en la agenda del prestador evitando duplicados
 * cuando coincide `source_ref` (por ejemplo `visit-<id>` o `pass-<id>`).
 * Si `endAt` no es provisto o es anterior/igual a `startAt`, asigna una duración por defecto de 2 horas.
 *
 * @param {Object} params - Datos del bloque horario.
 * @param {number|string} params.providerId - ID del prestador dueño de la agenda.
 * @param {string} params.blockType - Tipo de bloque (`unavailable`, `external_visit`, `trustlink_visit`, `trustlink_pass`).
 * @param {string} params.title - Título descriptivo visible en el calendario.
 * @param {string|Date} params.startAt - Fecha/hora de inicio.
 * @param {string|Date} [params.endAt] - Fecha/hora de fin (opcional; fallback +2h).
 * @param {string|null} [params.sourceRef=null] - Referencia única para actualizar en lugar de duplicar.
 * @returns {Promise<void>}
 */
const upsertScheduleBlock = async ({
  providerId,
  blockType,
  title,
  startAt,
  endAt,
  sourceRef = null,
}) => {
  await ensureScheduleBlocksTable();

  // Paso 1: Validar inicio y garantizar un fin válido (mínimo +2 horas por defecto)
  const parsedStart = new Date(startAt);
  if (Number.isNaN(parsedStart.getTime())) return;

  const parsedEnd = endAt
    ? new Date(endAt)
    : new Date(parsedStart.getTime() + 2 * 60 * 60 * 1000);
  const safeEnd = Number.isNaN(parsedEnd.getTime()) || parsedEnd <= parsedStart
    ? new Date(parsedStart.getTime() + 2 * 60 * 60 * 1000)
    : parsedEnd;

  // Paso 2: Si existe bloque previo con el mismo `source_ref`, actualizarlo en sitio
  if (sourceRef) {
    const existing = await db.query(
      'SELECT id FROM provider_schedule_blocks WHERE provider_id = $1 AND source_ref = $2 LIMIT 1',
      [Number(providerId), String(sourceRef)]
    );
    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE provider_schedule_blocks
         SET block_type = $1, title = $2, start_at = $3, end_at = $4
         WHERE id = $5`,
        [blockType, title, parsedStart.toISOString(), safeEnd.toISOString(), existing.rows[0].id]
      );
      return;
    }
  }

  // Paso 3: Insertar nuevo bloque en la agenda del prestador
  await db.query(
    `INSERT INTO provider_schedule_blocks (provider_id, block_type, title, start_at, end_at, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      Number(providerId),
      blockType,
      title,
      parsedStart.toISOString(),
      safeEnd.toISOString(),
      sourceRef,
    ]
  );
};

/**
 * Normaliza el campo JSONB `messages` de una solicitud de visita a un arreglo seguro,
 * soportando tanto arreglos ya parseados por `pg` como cadenas JSON serializadas.
 *
 * @param {Array|string|null|undefined} rawMessages - Valor crudo del campo `messages`.
 * @returns {Array<Object>} Arreglo de mensajes del hilo de coordinación.
 */
const parseMessagesArray = (rawMessages) => {
  if (Array.isArray(rawMessages)) return rawMessages;
  if (typeof rawMessages === 'string' && rawMessages.trim()) {
    try {
      const parsed = JSON.parse(rawMessages);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Marca automáticamente como `'expired'::pass_status` todos los pases en estado `'pending'`
 * cuya columna `end_time` (en UTC) ya superó la hora actual del servidor PostgreSQL.
 *
 * @returns {Promise<void>}
 */
const expireOverduePasses = async () => {
  await db.query(
    `UPDATE access_passes
     SET status = 'expired'::pass_status
     WHERE status = 'pending'::pass_status
       AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`
  );
};

/**
 * Verifica dinámicamente en `information_schema` si existe la columna `vehicle_plate`
 * en `access_passes` para mantener compatibilidad con bases de datos previas a esa migración.
 *
 * @returns {Promise<boolean>} `true` si la columna `vehicle_plate` existe.
 */
const hasVehiclePlateColumn = async () => {
  const res = await db.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_passes'
       AND column_name = 'vehicle_plate'
     LIMIT 1`
  );
  return res.rows.length > 0;
};

/**
 * Asegura de forma idempotente la columna `authorized_employees` (JSONB) en `access_passes`
 * para almacenar el snapshot de la cuadrilla/ayudantes habilitados en un Pase QR.
 *
 * @returns {Promise<void>}
 */
const ensureAuthorizedEmployeesColumn = async () => {
  await db.query(`
    ALTER TABLE public.access_passes
      ADD COLUMN IF NOT EXISTS authorized_employees JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
};

/**
 * Normaliza el campo JSONB `authorized_employees` a un arreglo seguro de ayudantes,
 * tolerando valores ya deserializados, cadenas JSON válidas o valores nulos/corruptos.
 *
 * @param {Array|string|null|undefined} rawVal - Valor crudo de `authorized_employees`.
 * @returns {Array<Object>} Arreglo de empleados autorizados en el pase.
 */
const parseAuthorizedEmployeesArray = (rawVal) => {
  if (Array.isArray(rawVal)) return rawVal;
  if (typeof rawVal === 'string' && rawVal.trim()) {
    try {
      const parsed = JSON.parse(rawVal);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Resuelve un snapshot validado de ayudantes/cuadrilla activos pertenecientes al mismo
 * usuario prestador (`p_emp.user_id = p_target.user_id`) a partir de sus IDs.
 * Deduplica IDs, filtra únicamente empleados activos e incluye su fecha de vencimiento de seguro
 * para validación de compliance al emitir o verificar el pase.
 *
 * @param {number|string} providerId - ID del perfil de prestador objetivo del pase.
 * @param {Array<number|string>} rawEmployeeIds - Lista de IDs de `provider_employees` solicitados.
 * @returns {Promise<Array<{id: number, full_name: string, dni: string|null, role_label: string, insurance_expiry: string|null}>>}
 */
const resolveAuthorizedEmployeesSnapshot = async (providerId, rawEmployeeIds) => {
  if (!Array.isArray(rawEmployeeIds) || rawEmployeeIds.length === 0) {
    return [];
  }

  // Paso 1: Sanitizar y deduplicar los IDs enteros positivos recibidos
  const cleanIds = [
    ...new Set(
      rawEmployeeIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  if (cleanIds.length === 0) return [];

  // Paso 2: Consultar empleados activos verificando pertenencia al mismo usuario prestador
  const empRes = await db.query(
    `SELECT
       pe.id,
       COALESCE(pe.full_name, TRIM(CONCAT(COALESCE(u_emp.first_name, ''), ' ', COALESCE(u_emp.last_name, '')))) AS full_name,
       COALESCE(pe.dni, u_emp.dni) AS dni,
       COALESCE(pe.role_label, 'Ayudante') AS role_label,
       pe.insurance_expiry
     FROM public.provider_employees pe
     JOIN public.providers p_emp ON p_emp.id = pe.provider_id
     JOIN public.providers p_target ON p_target.id = $1
     LEFT JOIN public.users u_emp ON u_emp.id = pe.employee_user_id
     WHERE pe.id = ANY($2::int[])
       AND p_emp.user_id = p_target.user_id
       AND COALESCE(pe.is_active, TRUE) = TRUE
     ORDER BY pe.id ASC`,
    [Number(providerId), cleanIds]
  );

  // Paso 3: Normalizar formato del snapshot (incluyendo fecha `YYYY-MM-DD` del seguro)
  return empRes.rows.map((row) => ({
    id: row.id,
    full_name: row.full_name || 'Ayudante',
    dni: row.dni || null,
    role_label: row.role_label || 'Ayudante',
    insurance_expiry: row.insurance_expiry
      ? new Date(row.insurance_expiry).toISOString().slice(0, 10)
      : null,
  }));
};

/**
 * Obtiene y valida la ubicación residencial registrada del residente en la tabla `users`.
 * - Toma automáticamente `fraction_type` (`'manzana'` | `'fraccion'` | `'na'`), `fraction_number` y `lot_number`.
 * - Exige que el residente tenga un `lot_number` cargado en su cuenta.
 * - Si el cliente envía un `lot_number` o `fraction_number` distinto al registrado, rechaza la operación
 *   como protección anti-suplantación para que cada residente solo opere sobre su propio lote.
 *
 * @param {number|string} residentUserId - ID del usuario residente autenticado.
 * @param {string|null|undefined} requestedFractionNumber - Fracción/Manzana recibida opcionalmente en el body.
 * @param {string|null|undefined} requestedLotNumber - Número de lote recibido opcionalmente en el body.
 * @returns {Promise<{fractionType?: string, fractionNumber?: string|null, fractionDisplay?: string, lotNumber?: string, error?: string}>}
 */
const resolveResidentLocation = async (residentUserId, requestedFractionNumber, requestedLotNumber) => {
  await ensureEvolutionSchema();

  // Paso 1: Consultar ubicación oficial almacenada en el perfil del residente
  const res = await db.query(
    `SELECT
       COALESCE(fraction_type, 'na') AS fraction_type,
       fraction_number,
       lot_number
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [Number(residentUserId)]
  );

  if (res.rows.length === 0) {
    return { error: 'No se encontró el registro del residente en la base de datos.' };
  }

  // Paso 2: Validar que el lote esté configurado y coincida con el solicitado (anti-spoofing)
  const resident = res.rows[0];
  const registeredLot = resident.lot_number ? String(resident.lot_number).trim() : '';

  if (!registeredLot) {
    return {
      error: 'Tu cuenta aún no tiene un número de Lote registrado. Complétalo en Mi Cuenta antes de solicitar visitas o emitir pases.',
    };
  }

  if (
    requestedLotNumber !== undefined &&
    requestedLotNumber !== null &&
    String(requestedLotNumber).trim() !== '' &&
    String(requestedLotNumber).trim().toLowerCase() !== registeredLot.toLowerCase()
  ) {
    return {
      error: `Solo podés solicitar visitas o emitir pases para tu Lote registrado (${registeredLot}).`,
    };
  }

  // Paso 3: Construir etiqueta legible para Manzana/Fracción/N/A según `fraction_type`
  const registeredFractionType = String(resident.fraction_type || 'na').toLowerCase();
  const rawStoredFraction = resident.fraction_number ? String(resident.fraction_number).trim() : '';
  const hasStoredFraction =
    rawStoredFraction !== '' && !['N/A', 'NA', 'NO APLICA', '-'].includes(rawStoredFraction.toUpperCase());

  const registeredFractionNum = hasStoredFraction ? rawStoredFraction : null;

  const fractionDisplay = !registeredFractionNum
    ? 'N/A'
    : registeredFractionType === 'fraccion' && /^\d+$/.test(registeredFractionNum)
    ? `Fracción ${registeredFractionNum}`
    : registeredFractionType === 'manzana' && /^\d+$/.test(registeredFractionNum)
    ? `Manzana ${registeredFractionNum}`
    : registeredFractionNum;

  // Paso 4: Verificar que la Manzana/Fracción enviada (si se envió) coincida con la registrada
  const cleanRequestedFraction =
    requestedFractionNumber !== undefined && requestedFractionNumber !== null
      ? String(requestedFractionNumber).trim()
      : '';

  if (cleanRequestedFraction !== '' && !['N/A', 'NA'].includes(cleanRequestedFraction.toUpperCase())) {
    const allowedMatches = [registeredFractionNum, fractionDisplay]
      .filter(Boolean)
      .map((v) => v.toLowerCase());
    if (!allowedMatches.includes(cleanRequestedFraction.toLowerCase())) {
      return {
        error: 'Solo podés solicitar visitas o emitir pases para tu Manzana/Fracción registrada.',
      };
    }
  }

  return {
    fractionType: registeredFractionType,
    fractionNumber: registeredFractionNum,
    fractionDisplay,
    lotNumber: registeredLot,
  };
};

/**
 * Obtiene la agenda completa del prestador autenticado: bloques manuales/externos/automáticos
 * (`provider_schedule_blocks`) y pases QR vigentes o utilizados (`pending` / `used`).
 * GET /api/v1/passes/schedule/provider
 *
 * @param {import('express').Request} req - Solicitud autenticada del prestador.
 * @param {import('express').Response} res - Respuesta HTTP con `{ blocks, passes }`.
 */
const getProviderSchedule = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    await ensureAvailabilityRulesTable();
    await ensureVisitRequestsTable();
    await expireOverduePasses();

    // Etapa 1: Resolver todos los perfiles de prestador y parámetros de proyección del calendario
    const userId = Number(req.user?.userId || req.user?.id);
    const startDateParam = req.query.start_date ? String(req.query.start_date).trim() : undefined;
    const daysParam = req.query.days ? Number(req.query.days) : 7;
    const tzOffsetParam =
      req.query.tz_offset !== undefined && !Number.isNaN(Number(req.query.tz_offset))
        ? Number(req.query.tz_offset)
        : 180;

    const [providerProfilesRes, rulesRes] = await Promise.all([
      db.query('SELECT id FROM providers WHERE user_id = $1', [userId]),
      db.query(
        `SELECT day_of_week, is_working, start_time, end_time, slot_minutes
         FROM public.provider_availability_rules
         WHERE user_id = $1
         ORDER BY day_of_week ASC`,
        [userId]
      ),
    ]);
    const providerIds = providerProfilesRes.rows.map((r) => Number(r.id)).filter(Boolean);
    const mergedRules = mergeWithDefaultRules(rulesRes.rows);

    if (providerIds.length === 0) {
      const emptyCalendar = buildMultiDayAvailability({
        startDateStr: startDateParam,
        days: daysParam,
        rules: mergedRules,
        blocks: [],
        tentativeVisits: [],
        tzOffsetMinutes: tzOffsetParam,
        includeBlockDetails: true,
      });
      return res.status(200).json({
        rules: emptyCalendar.rules,
        schedule_summary: emptyCalendar.schedule_summary,
        slot_minutes: emptyCalendar.slot_minutes,
        calendar_days: emptyCalendar.days,
        blocks: [],
        tentative_visits: [],
        passes: [],
      });
    }

    // Etapa 2: Consultar bloqueos confirmados, potenciales visitas pendientes y pases QR en paralelo
    const [blocksRes, tentativeVisitsRes, passesRes] = await Promise.all([
      db.query(
        `SELECT
           id,
           provider_id,
           block_type,
           title,
           TO_CHAR(start_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start_at,
           TO_CHAR(end_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_at,
           source_ref,
           created_at
         FROM provider_schedule_blocks
         WHERE provider_id = ANY($1::int[])
         ORDER BY start_at ASC, id DESC`,
        [providerIds]
      ),
      db.query(
        `SELECT
           vr.id,
           vr.provider_id,
           vr.status,
           vr.fraction_number,
           vr.lot_number,
           vr.preferred_date,
           vr.preferred_end_date,
           vr.notes,
           TRIM(CONCAT(COALESCE(u_owner.first_name, ''), ' ', COALESCE(u_owner.last_name, ''))) AS owner_name
         FROM visit_requests vr
         LEFT JOIN users u_owner ON vr.owner_id = u_owner.id
         WHERE vr.provider_id = ANY($1::int[])
           AND vr.status IN ('pending_provider', 'pending_resident')
           AND vr.preferred_date IS NOT NULL
         ORDER BY vr.id DESC`,
        [providerIds]
      ),
      db.query(
        `SELECT
           ap.id,
           ap.provider_id,
           ap.fraction_number,
           ap.lot_number,
           ap.start_time,
           ap.end_time,
           ap.status,
           TRIM(CONCAT(COALESCE(u_owner.first_name, ''), ' ', COALESCE(u_owner.last_name, ''))) AS owner_name
         FROM access_passes ap
         LEFT JOIN users u_owner ON ap.owner_id = u_owner.id
         WHERE ap.provider_id = ANY($1::int[])
           AND ap.status IN ('pending'::pass_status, 'used'::pass_status)
         ORDER BY ap.start_time ASC`,
        [providerIds]
      ),
    ]);

    // Etapa 3: Construir la proyección de calendario vivo (incluyendo potenciales visitas para el prestador)
    const calendar = buildMultiDayAvailability({
      startDateStr: startDateParam,
      days: daysParam,
      rules: mergedRules,
      blocks: blocksRes.rows,
      tentativeVisits: tentativeVisitsRes.rows,
      tzOffsetMinutes: tzOffsetParam,
      includeBlockDetails: true,
    });

    return res.status(200).json({
      rules: calendar.rules,
      schedule_summary: calendar.schedule_summary,
      slot_minutes: calendar.slot_minutes,
      calendar_days: calendar.days,
      blocks: blocksRes.rows,
      tentative_visits: tentativeVisitsRes.rows,
      passes: passesRes.rows,
    });
  } catch (error) {
    console.error('Error al obtener agenda del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar la agenda del prestador.' });
  }
};

/**
 * Guarda la configuración de jornada semanal del prestador autenticado (días laborables,
 * hora de inicio/fin por día e intervalo de turnos de 30 o 60 minutos).
 * PUT /api/v1/passes/schedule/rules
 *
 * @param {import('express').Request} req - Body: `{ rules: Array<{ day_of_week, is_working, start_time, end_time, slot_minutes? }>, slot_minutes? }`.
 * @param {import('express').Response} res - Respuesta HTTP 200 con la jornada semanal normalizada.
 */
const saveProviderAvailabilityRules = async (req, res) => {
  try {
    await ensureAvailabilityRulesTable();
    const userId = Number(req.user?.userId || req.user?.id);
    const { rules: rawRules, slot_minutes } = req.body || {};

    const { rules: normalizedRules, error: validationError } = normalizeWeeklyRulesInput(
      rawRules,
      slot_minutes
    );
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    for (const rule of normalizedRules) {
      await db.query(
        `INSERT INTO public.provider_availability_rules (
           user_id, day_of_week, is_working, start_time, end_time, slot_minutes, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, day_of_week)
         DO UPDATE SET
           is_working = EXCLUDED.is_working,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           slot_minutes = EXCLUDED.slot_minutes,
           updated_at = NOW()`,
        [
          userId,
          rule.day_of_week,
          rule.is_working,
          rule.start_time,
          rule.end_time,
          rule.slot_minutes,
        ]
      );
    }

    const hydrated = mergeWithDefaultRules(normalizedRules);
    return res.status(200).json({
      message: 'Jornada semanal y disponibilidad actualizadas correctamente.',
      rules: hydrated,
      schedule_summary: buildScheduleSummaryText(hydrated),
      slot_minutes: hydrated[0]?.slot_minutes || 30,
    });
  } catch (error) {
    console.error('Error al guardar jornada semanal del prestador:', error);
    return res.status(500).json({ error: 'Error interno al guardar la configuración de agenda.' });
  }
};

/**
 * Devuelve al residente la disponibilidad viva (7 días por defecto, franjas cada 30/60 min)
 * de un prestador específico (`providerUserId`) sin exponer datos privados de trabajos externos
 * ni lotes de otros vecinos (`includeBlockDetails = false`).
 * GET /api/v1/passes/schedule/availability/:providerUserId
 *
 * @param {import('express').Request} req - Param `providerUserId` y query opcional `start_date`, `days`, `tz_offset`.
 * @param {import('express').Response} res - Respuesta HTTP 200 con resumen semanal y grilla libre/ocupado.
 */
const getProviderPublicAvailability = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    await ensureAvailabilityRulesTable();

    const providerUserId = Number(req.params.providerUserId);
    if (!Number.isInteger(providerUserId) || providerUserId <= 0) {
      return res.status(400).json({ error: 'Identificador de prestador inválido.' });
    }

    const startDateParam = req.query.start_date ? String(req.query.start_date).trim() : undefined;
    const daysParam = req.query.days ? Number(req.query.days) : 7;
    const tzOffsetParam =
      req.query.tz_offset !== undefined && !Number.isNaN(Number(req.query.tz_offset))
        ? Number(req.query.tz_offset)
        : 180;

    const [profilesRes, rulesRes] = await Promise.all([
      db.query('SELECT id FROM providers WHERE user_id = $1', [providerUserId]),
      db.query(
        `SELECT day_of_week, is_working, start_time, end_time, slot_minutes
         FROM public.provider_availability_rules
         WHERE user_id = $1
         ORDER BY day_of_week ASC`,
        [providerUserId]
      ),
    ]);

    if (profilesRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    const providerIds = profilesRes.rows.map((r) => Number(r.id)).filter(Boolean);
    const blocksRes = await db.query(
      `SELECT
         id,
         provider_id,
         block_type,
         TO_CHAR(start_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start_at,
         TO_CHAR(end_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_at
       FROM provider_schedule_blocks
       WHERE provider_id = ANY($1::int[])
         AND end_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day'
       ORDER BY start_at ASC`,
      [providerIds]
    );

    const availability = buildMultiDayAvailability({
      startDateStr: startDateParam,
      days: daysParam,
      rules: rulesRes.rows,
      blocks: blocksRes.rows,
      tzOffsetMinutes: tzOffsetParam,
      includeBlockDetails: false,
    });

    return res.status(200).json({
      provider_user_id: providerUserId,
      ...availability,
    });
  } catch (error) {
    console.error('Error al consultar disponibilidad pública del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar la disponibilidad.' });
  }
};

/**
 * Crea un bloque manual en la agenda del prestador para marcar horarios no laborables
 * (`unavailable`) o visitas agendadas por fuera de TrustLink (`external_visit`).
 * POST /api/v1/passes/schedule/blocks
 *
 * @param {import('express').Request} req - Body: `{ block_type?, title?, start_at, end_at }`.
 * @param {import('express').Response} res - Respuesta HTTP 201 con el bloque creado.
 */
const createScheduleBlock = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    const userId = Number(req.user?.userId || req.user?.id);
    const { block_type, title, start_at, end_at } = req.body;

    // Etapa 1: Identificar el perfil principal de prestador del usuario autenticado
    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1 ORDER BY id ASC LIMIT 1',
      [userId]
    );

    if (providerProfilesRes.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontró un perfil de prestador asociado.' });
    }

    // Etapa 2: Normalizar tipo de bloque y validar coherencia del rango horario
    const providerId = Number(providerProfilesRes.rows[0].id);
    const normalizedType =
      String(block_type || '').toLowerCase() === 'external_visit'
        ? 'external_visit'
        : 'unavailable';

    if (!start_at || !end_at) {
      return res.status(400).json({ error: 'Completá fecha/hora de inicio y fin.' });
    }

    const startDate = new Date(start_at);
    const endDate = new Date(end_at);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
      return res.status(400).json({ error: 'El rango horario es inválido.' });
    }

    // Etapa 3: Persistir el bloqueo manual en `provider_schedule_blocks` devolviendo UTC ISO explícito
    const cleanTitle =
      String(title || '').trim() ||
      (normalizedType === 'external_visit' ? 'Trabajo externo agendado' : 'Horario no laborable');

    const inserted = await db.query(
      `INSERT INTO provider_schedule_blocks (provider_id, block_type, title, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id,
         provider_id,
         block_type,
         title,
         TO_CHAR(start_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start_at,
         TO_CHAR(end_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_at,
         source_ref,
         created_at`,
      [providerId, normalizedType, cleanTitle, startDate.toISOString(), endDate.toISOString()]
    );

    return res.status(201).json({
      message:
        normalizedType === 'external_visit'
          ? 'Trabajo externo registrado y franja bloqueada en tu agenda.'
          : 'Horario no laborable bloqueado en tu agenda.',
      block: inserted.rows[0],
    });
  } catch (error) {
    console.error('Error al crear bloque de agenda:', error);
    return res.status(500).json({ error: 'Error interno al guardar el bloque en la agenda.' });
  }
};

/**
 * Elimina un bloque manual de la agenda del prestador verificando que pertenezca
 * a alguno de los perfiles `providers` del usuario autenticado.
 * DELETE /api/v1/passes/schedule/blocks/:blockId
 *
 * @param {import('express').Request} req - Param `blockId`.
 * @param {import('express').Response} res - Respuesta HTTP confirmando la eliminación.
 */
const deleteScheduleBlock = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    const blockId = Number(req.params.blockId);
    const userId = Number(req.user?.userId || req.user?.id);

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: 'ID de bloque inválido.' });
    }

    // Obtener todos los perfiles de prestador del usuario para restringir el DELETE por pertenencia
    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );
    const providerIds = providerProfilesRes.rows.map((r) => Number(r.id)).filter(Boolean);

    const deleted = await db.query(
      `DELETE FROM provider_schedule_blocks
       WHERE id = $1
         AND provider_id = ANY($2::int[])
       RETURNING id`,
      [blockId, providerIds]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Bloque no encontrado o sin permisos.' });
    }

    return res.status(200).json({ message: 'Bloque eliminado de la agenda.' });
  } catch (error) {
    console.error('Error al eliminar bloque de agenda:', error);
    return res.status(500).json({ error: 'Error interno al eliminar el bloque.' });
  }
};

/**
 * Crea una solicitud de visita/coordinación bidireccional del residente hacia un prestador.
 * Resuelve y bloquea automáticamente Manzana/Fracción/N/A y Lote desde la cuenta del residente
 * e inicializa el hilo de mensajes en estado `'pending_provider'`.
 * POST /api/v1/passes/visit-requests
 *
 * @param {import('express').Request} req - Body: `{ provider_id, fraction_number?, lot_number?, preferred_date?, notes }`.
 * @param {import('express').Response} res - Respuesta HTTP 201 con la solicitud de visita creada.
 */
const createVisitCoordination = async (req, res) => {
  try {
    await ensureVisitRequestsTable();

    // Etapa 1: Validar sesión del residente y campos obligatorios del pedido
    const ownerId = Number(req.user?.userId || req.user?.id);
    const countryId = req.user?.countryId ? Number(req.user.countryId) : null;
    const {
      provider_id,
      fraction_number,
      lot_number,
      preferred_date,
      preferred_end_date,
      duration_minutes,
      service_title,
      service_specialty,
      notes,
    } = req.body;

    if (!ownerId) {
      return res.status(401).json({
        error: 'Sesión de residente inválida o expirada. Volvé a iniciar sesión.',
      });
    }

    const cleanServiceTitle = service_title ? String(service_title).trim().slice(0, 160) : '';
    const cleanNotes = String(notes || '').trim() || cleanServiceTitle;

    if (!provider_id || !cleanNotes) {
      return res.status(400).json({
        error: 'Indicá el prestador y el trabajo o mensaje de coordinación de la visita.',
      });
    }

    // Etapa 2: Comprobar existencia del prestador destino y resolver el `provider_id` exacto del rubro elegido
    const providerCheck = await db.query(
      `SELECT p.id, p.user_id, p.specialty, u.country_id
       FROM providers p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1
       LIMIT 1`,
      [Number(provider_id)]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
    }

    let resolvedProviderId = Number(providerCheck.rows[0].id);
    const requestedSpecialty = service_specialty ? String(service_specialty).trim().slice(0, 120) : '';
    const baseSpecialty = providerCheck.rows[0].specialty
      ? String(providerCheck.rows[0].specialty).trim()
      : '';

    // Si el prestador tiene múltiples rubros, imputar la visita al `provider_id` exacto del rubro solicitado
    if (
      requestedSpecialty &&
      providerCheck.rows[0].user_id &&
      requestedSpecialty.toLowerCase() !== baseSpecialty.toLowerCase()
    ) {
      const specialtyMatch = await db.query(
        `SELECT id
         FROM providers
         WHERE user_id = $1
           AND LOWER(TRIM(COALESCE(specialty, ''))) = LOWER(TRIM($2))
         ORDER BY CASE WHEN status = 'approved'::provider_status THEN 0 ELSE 1 END, id ASC
         LIMIT 1`,
        [Number(providerCheck.rows[0].user_id), requestedSpecialty]
      );
      if (specialtyMatch.rows.length > 0) {
        resolvedProviderId = Number(specialtyMatch.rows[0].id);
      }
    }

    // Etapa 3: Resolver y validar la ubicación residencial registrada del solicitante
    const locationResult = await resolveResidentLocation(ownerId, fraction_number, lot_number);
    if (locationResult.error) {
      return res.status(400).json({ error: locationResult.error });
    }

    // Etapa 4: Inicializar el hilo de mensajería y persistir la solicitud en `visit_requests`
    const effectiveCountryId = countryId || providerCheck.rows[0].country_id || null;
    const cleanServiceSpecialty = requestedSpecialty || (baseSpecialty ? baseSpecialty.slice(0, 120) : null);
    const initialMessages = [
      {
        id: `msg-${Date.now()}`,
        sender_role: 'owner',
        sender_id: ownerId,
        text: cleanNotes,
        created_at: new Date().toISOString(),
      },
    ];

    const cleanPreferredDate = preferred_date ? String(preferred_date).trim() : null;
    const cleanPreferredEndDate = resolveVisitEndDate(
      cleanPreferredDate,
      preferred_end_date,
      duration_minutes || 60
    );

    const inserted = await db.query(
      `INSERT INTO visit_requests (
         country_id, owner_id, provider_id, fraction_number, lot_number,
         preferred_date, preferred_end_date, service_title, service_specialty,
         notes, messages, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'pending_provider')
       RETURNING *`,
      [
        effectiveCountryId,
        ownerId,
        resolvedProviderId,
        locationResult.fractionDisplay,
        locationResult.lotNumber,
        cleanPreferredDate,
        cleanPreferredEndDate,
        cleanServiceTitle || null,
        cleanServiceSpecialty,
        cleanNotes,
        JSON.stringify(initialMessages),
      ]
    );

    const row = inserted.rows[0];
    // Retornar solicitud creada con el hilo de mensajes normalizado como arreglo
    return res.status(201).json({
      message: 'Solicitud enviada al prestador. Esperá o coordiná su confirmación antes de emitir el QR.',
      visit: {
        ...row,
        messages: parseMessagesArray(row.messages),
      },
    });
  } catch (error) {
    console.error('Error al registrar coordinación de visita:', error);
    return res.status(500).json({
      error: `Error interno al registrar la visita: ${error.message}`,
    });
  }
};

/**
 * Lista todas las solicitudes de visita creadas por el residente autenticado,
 * enriquecidas con nombre y especialidad del prestador.
 * GET /api/v1/passes/visit-requests/my
 *
 * @param {import('express').Request} req - Solicitud autenticada del residente.
 * @param {import('express').Response} res - Respuesta HTTP con `{ visits }`.
 */
const listMyVisitRequests = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
    const ownerId = Number(req.user?.userId || req.user?.id);

    // Consultar solicitudes del residente ordenadas de la más reciente a la más antigua
    const result = await db.query(
      `SELECT
         vr.*,
         p.user_id AS provider_user_id,
         TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
         p.specialty AS provider_specialty
       FROM visit_requests vr
       LEFT JOIN providers p ON vr.provider_id = p.id
       LEFT JOIN users u_prov ON p.user_id = u_prov.id
       WHERE vr.owner_id = $1
       ORDER BY vr.id DESC`,
      [ownerId]
    );

    const visits = result.rows.map((r) => ({
      ...r,
      messages: parseMessagesArray(r.messages),
    }));

    return res.status(200).json({ visits });
  } catch (error) {
    console.error('Error al listar visitas del residente:', error);
    return res.status(500).json({ error: 'Error interno al consultar las visitas del residente.' });
  }
};

/**
 * Lista las solicitudes de visita recibidas por cualquiera de los perfiles de prestador
 * del usuario autenticado, incluyendo datos de contacto del residente solicitante.
 * GET /api/v1/passes/visit-requests/provider
 *
 * @param {import('express').Request} req - Solicitud autenticada del prestador.
 * @param {import('express').Response} res - Respuesta HTTP con `{ visits }`.
 */
const listProviderVisitRequests = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
    const userId = Number(req.user?.userId || req.user?.id);

    // Etapa 1: Obtener todos los perfiles de prestador vinculados al usuario
    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );

    const providerIds = providerProfilesRes.rows.map((r) => Number(r.id)).filter(Boolean);
    if (providerIds.length === 0) {
      return res.status(200).json({ visits: [] });
    }

    // Etapa 2: Consultar solicitudes entrantes junto a nombre y teléfono del residente
    const result = await db.query(
      `SELECT
         vr.*,
         TRIM(CONCAT(COALESCE(u_owner.first_name, ''), ' ', COALESCE(u_owner.last_name, ''))) AS owner_name,
         u_owner.phone AS owner_phone,
         p.specialty AS provider_specialty
       FROM visit_requests vr
       LEFT JOIN users u_owner ON vr.owner_id = u_owner.id
       LEFT JOIN providers p ON vr.provider_id = p.id
       WHERE vr.provider_id = ANY($1::int[])
       ORDER BY vr.id DESC`,
      [providerIds]
    );

    const visits = result.rows.map((r) => ({
      ...r,
      messages: parseMessagesArray(r.messages),
    }));

    return res.status(200).json({ visits });
  } catch (error) {
    console.error('Error al listar visitas del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar las visitas del prestador.' });
  }
};

/**
 * Agrega un nuevo mensaje al hilo JSONB de coordinación de una visita existente.
 * Solo pueden escribir el residente creador, el prestador asignado o un administrador.
 * POST /api/v1/passes/visit-requests/:id/messages
 *
 * @param {import('express').Request} req - Param `id`; body `{ text }` o `{ message }`.
 * @param {import('express').Response} res - Respuesta HTTP con la visita y su historial actualizado.
 */
const addVisitRequestMessage = async (req, res) => {
  try {
    await ensureVisitRequestsTable();

    // Etapa 1: Validar ID de visita y contenido no vacío del mensaje
    const visitId = Number(req.params.id);
    const userId = Number(req.user?.userId || req.user?.id);
    const userRole = String(req.user?.role || '').toLowerCase();
    const text = String(req.body?.text || req.body?.message || '').trim();

    if (!Number.isInteger(visitId) || visitId <= 0) {
      return res.status(400).json({ error: 'ID de visita inválido.' });
    }
    if (!text) {
      return res.status(400).json({ error: 'Escribí un mensaje antes de enviar.' });
    }

    // Etapa 2: Recuperar la visita y validar autorización de participación (residente, prestador asignado o admin)
    const visitRes = await db.query('SELECT * FROM visit_requests WHERE id = $1 LIMIT 1', [visitId]);
    if (visitRes.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitud de visita no encontrada.' });
    }

    const visit = visitRes.rows[0];
    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );
    const myProviderIds = providerProfilesRes.rows.map((r) => Number(r.id));

    const isOwner = Number(visit.owner_id) === userId;
    const isAssignedProvider = myProviderIds.includes(Number(visit.provider_id));
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';

    if (!isOwner && !isAssignedProvider && !isAdmin) {
      return res.status(403).json({ error: 'No tenés permiso para participar en esta visita.' });
    }

    // Etapa 3: Anexar mensaje al arreglo JSONB y persistir en `visit_requests`
    const currentMessages = parseMessagesArray(visit.messages);
    const newMsg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender_role: isAssignedProvider ? 'provider' : 'owner',
      sender_id: userId,
      text,
      created_at: new Date().toISOString(),
    };

    const updatedMessages = [...currentMessages, newMsg];
    const updated = await db.query(
      `UPDATE visit_requests
       SET messages = $1::jsonb
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(updatedMessages), visitId]
    );

    const row = updated.rows[0];
    return res.status(200).json({
      message: 'Mensaje agregado al hilo de coordinación.',
      visit: {
        ...row,
        messages: parseMessagesArray(row.messages),
      },
    });
  } catch (error) {
    console.error('Error al enviar mensaje de visita:', error);
    return res.status(500).json({ error: 'Error interno al enviar el mensaje.' });
  }
};

/**
 * Permite al prestador asignado responder una solicitud de visita (`confirm`, `propose` o `decline`).
 * Actualiza estado, fecha propuesta e historial de mensajes; si se confirma con fecha,
 * bloquea automáticamente esa franja en la agenda del prestador (`upsertScheduleBlock`).
 * PATCH /api/v1/passes/visit-requests/:id/respond
 *
 * @param {import('express').Request} req - Param `id`; body `{ action, preferred_date?, reply_text? }`.
 * @param {import('express').Response} res - Respuesta HTTP con la solicitud actualizada.
 */
const respondVisitRequest = async (req, res) => {
  try {
    await ensureVisitRequestsTable();

    // Etapa 1: Validar ID de visita y acción solicitada (`confirm` | `propose` | `decline`)
    const visitId = Number(req.params.id);
    const userId = Number(req.user?.userId || req.user?.id);
    const { action, preferred_date, preferred_end_date, duration_minutes, reply_text } = req.body;

    if (!Number.isInteger(visitId) || visitId <= 0) {
      return res.status(400).json({ error: 'ID de visita inválido.' });
    }

    const normalizedAction = String(action || '').toLowerCase();
    if (!['confirm', 'decline', 'propose'].includes(normalizedAction)) {
      return res.status(400).json({ error: 'Acción inválida (confirm | propose | decline).' });
    }

    // Etapa 2: Verificar existencia de la visita y que el usuario sea el prestador asignado
    const visitRes = await db.query('SELECT * FROM visit_requests WHERE id = $1 LIMIT 1', [visitId]);
    if (visitRes.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitud de visita no encontrada.' });
    }

    const visit = visitRes.rows[0];
    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );
    const myProviderIds = providerProfilesRes.rows.map((r) => Number(r.id));

    if (!myProviderIds.includes(Number(visit.provider_id))) {
      return res.status(403).json({ error: 'Solo el prestador asignado puede responder esta visita.' });
    }

    // Etapa 3: Validar fecha al repactar y resolver nuevo estado de la máquina bilateral
    const cleanProposedDate = preferred_date ? String(preferred_date).trim() : '';
    if (normalizedAction === 'propose' && !cleanProposedDate) {
      return res.status(400).json({
        error: 'Indicá la nueva fecha y horario propuesto para repactar la visita.',
      });
    }

    const nextStatus =
      normalizedAction === 'confirm'
        ? 'confirmed'
        : normalizedAction === 'decline'
        ? 'declined'
        : 'pending_resident';

    const nextDate = cleanProposedDate || visit.preferred_date;
    // Conservar duración previa o mínimo 60 min si se propuso una nueva fecha sin fin explícito
    const prevDurationMin =
      visit.preferred_date && visit.preferred_end_date
        ? Math.max(
            60,
            Math.round(
              (new Date(visit.preferred_end_date).getTime() - new Date(visit.preferred_date).getTime()) /
                60000
            )
          )
        : 60;
    const nextEndDate = resolveVisitEndDate(
      nextDate,
      preferred_end_date || (!cleanProposedDate ? visit.preferred_end_date : null),
      duration_minutes || prevDurationMin
    );
    const currentMessages = parseMessagesArray(visit.messages);

    const readableNextDate = nextDate
      ? (() => {
          const d = new Date(nextDate);
          return Number.isNaN(d.getTime())
            ? nextDate
            : d.toLocaleString('es-AR', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              });
        })()
      : '';

    const autoSummaryText =
      String(reply_text || '').trim() ||
      (normalizedAction === 'confirm'
        ? `Disponibilidad confirmada${readableNextDate ? ` para ${readableNextDate}` : ''}. Ya podés emitir el Pase QR.`
        : normalizedAction === 'decline'
        ? 'No tengo disponibilidad para esa visita en este momento.'
        : `Propongo repactar la visita para ${readableNextDate || 'otro horario'}. Confirmame si te queda bien.`);

    const updatedMessages = [
      ...currentMessages,
      {
        id: `msg-${Date.now()}`,
        sender_role: 'provider',
        sender_id: userId,
        text: autoSummaryText,
        created_at: new Date().toISOString(),
      },
    ];

    // Etapa 4: Persistir cambio de estado/mensajes y sincronizar agenda viva del prestador
    const updated = await db.query(
      `UPDATE visit_requests
       SET status = $1,
           preferred_date = $2,
           preferred_end_date = $3,
           messages = $4::jsonb
       WHERE id = $5
       RETURNING *`,
      [nextStatus, nextDate, nextEndDate, JSON.stringify(updatedMessages), visitId]
    );

    if (normalizedAction === 'confirm' && nextDate) {
      await upsertScheduleBlock({
        providerId: visit.provider_id,
        blockType: 'trustlink_visit',
        title: `Visita TrustLink #${visitId} (${visit.fraction_number || ''} ${visit.lot_number || ''})`.trim(),
        startAt: nextDate,
        endAt: nextEndDate,
        sourceRef: `visit-${visitId}`,
      });
    } else if (normalizedAction === 'decline') {
      await ensureScheduleBlocksTable();
      await db.query('DELETE FROM provider_schedule_blocks WHERE source_ref = $1', [
        `visit-${visitId}`,
      ]);
    }

    const row = updated.rows[0];
    return res.status(200).json({
      message:
        normalizedAction === 'confirm'
          ? 'Disponibilidad confirmada y horario bloqueado en tu agenda.'
          : normalizedAction === 'decline'
          ? 'Visita marcada como sin disponibilidad.'
          : 'Contrapropuesta enviada al residente. Esperando su confirmación.',
      visit: {
        ...row,
        messages: parseMessagesArray(row.messages),
      },
    });
  } catch (error) {
    console.error('Error al responder solicitud de visita:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la solicitud de visita.' });
  }
};

/**
 * Permite al residente dueño de la solicitud responder una contrapropuesta del prestador
 * (`accept` para acordar mutuamente el horario y reservar en la agenda viva, `propose` para
 * sugerir otro día/horario volviendo a `pending_provider`, o `cancel` para cancelar el pedido).
 * PATCH /api/v1/passes/visit-requests/:id/resident-respond
 *
 * @param {import('express').Request} req - Param `id`; body `{ action, preferred_date?, preferred_end_date?, duration_minutes?, reply_text? }`.
 * @param {import('express').Response} res - Respuesta HTTP 200 con la visita actualizada.
 */
const respondVisitRequestAsResident = async (req, res) => {
  try {
    await ensureVisitRequestsTable();

    const visitId = Number(req.params.id);
    const userId = Number(req.user?.userId || req.user?.id);
    const isSuperadmin = String(req.user?.role || '').toLowerCase() === 'superadmin';
    const { action, preferred_date, preferred_end_date, duration_minutes, reply_text } = req.body || {};

    if (!Number.isInteger(visitId) || visitId <= 0) {
      return res.status(400).json({ error: 'ID de visita inválido.' });
    }

    const normalizedAction = String(action || '').toLowerCase();
    if (!['accept', 'propose', 'cancel'].includes(normalizedAction)) {
      return res.status(400).json({ error: 'Acción inválida (accept | propose | cancel).' });
    }

    const visitRes = await db.query('SELECT * FROM visit_requests WHERE id = $1 LIMIT 1', [visitId]);
    if (visitRes.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitud de visita no encontrada.' });
    }

    const visit = visitRes.rows[0];
    if (!isSuperadmin && Number(visit.owner_id) !== userId) {
      return res.status(403).json({
        error: 'Solo el residente que solicitó esta visita puede responderla.',
      });
    }

    const cleanProposedDate = preferred_date ? String(preferred_date).trim() : '';
    if (normalizedAction === 'propose' && !cleanProposedDate) {
      return res.status(400).json({
        error: 'Seleccioná una nueva fecha y horario de la agenda del prestador.',
      });
    }

    const nextStatus =
      normalizedAction === 'accept'
        ? 'confirmed'
        : normalizedAction === 'cancel'
        ? 'cancelled'
        : 'pending_provider';
    const nextDate = cleanProposedDate || visit.preferred_date;
    const prevDurationMin =
      visit.preferred_date && visit.preferred_end_date
        ? Math.max(
            60,
            Math.round(
              (new Date(visit.preferred_end_date).getTime() - new Date(visit.preferred_date).getTime()) /
                60000
            )
          )
        : 60;
    const nextEndDate = resolveVisitEndDate(
      nextDate,
      preferred_end_date || (!cleanProposedDate ? visit.preferred_end_date : null),
      duration_minutes || prevDurationMin
    );

    const readableNextDate = nextDate
      ? (() => {
          const d = new Date(nextDate);
          return Number.isNaN(d.getTime())
            ? nextDate
            : d.toLocaleString('es-AR', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              });
        })()
      : '';

    const autoText =
      String(reply_text || '').trim() ||
      (normalizedAction === 'accept'
        ? `Acepto el horario propuesto${readableNextDate ? ` (${readableNextDate})` : ''}. Visita acordada.`
        : normalizedAction === 'cancel'
        ? 'Solicitud de visita cancelada por el residente.'
        : `Propongo otro horario: ${readableNextDate || 'a convenir'}. ¿Te sirve?`);

    const currentMessages = parseMessagesArray(visit.messages);
    const updatedMessages = [
      ...currentMessages,
      {
        id: `msg-${Date.now()}`,
        sender_role: 'owner',
        sender_id: userId,
        text: autoText,
        created_at: new Date().toISOString(),
      },
    ];

    const updated = await db.query(
      `UPDATE visit_requests
       SET status = $1,
           preferred_date = $2,
           preferred_end_date = $3,
           messages = $4::jsonb
       WHERE id = $5
       RETURNING *`,
      [nextStatus, nextDate, nextEndDate, JSON.stringify(updatedMessages), visitId]
    );

    if (normalizedAction === 'accept' && nextDate) {
      await upsertScheduleBlock({
        providerId: visit.provider_id,
        blockType: 'trustlink_visit',
        title: `Visita TrustLink #${visitId} (${visit.fraction_number || ''} ${visit.lot_number || ''})`.trim(),
        startAt: nextDate,
        endAt: nextEndDate,
        sourceRef: `visit-${visitId}`,
      });
    } else if (normalizedAction === 'cancel') {
      await ensureScheduleBlocksTable();
      await db.query('DELETE FROM provider_schedule_blocks WHERE source_ref = $1', [
        `visit-${visitId}`,
      ]);
    }

    const row = updated.rows[0];
    return res.status(200).json({
      message:
        normalizedAction === 'accept'
          ? '¡Visita acordada por ambas partes! Ya quedó reservada en la agenda del prestador y habilitaste el Pase QR.'
          : normalizedAction === 'cancel'
          ? 'Solicitud de visita cancelada.'
          : 'Nueva propuesta enviada al prestador. Esperando su confirmación.',
      visit: {
        ...row,
        messages: parseMessagesArray(row.messages),
      },
    });
  } catch (error) {
    console.error('Error al responder visita desde residente:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la visita.' });
  }
};

/**
 * Emite un nuevo Pase QR para un prestador (y su cuadrilla opcional).
 * Resuelve y bloquea la ubicación residencial desde `users`, impide la emisión si existen
 * documentos vencidos (antecedentes o seguros del titular/cuadrilla), genera un token QR
 * criptográfico de 32 bytes y bloquea la franja horaria en la agenda del prestador.
 * POST /api/v1/passes/create
 *
 * @param {import('express').Request} req - Body: `{ provider_id, fraction_number?, lot_number?, vehicle_plate?, employee_ids?, start_time, end_time }`.
 * @param {import('express').Response} res - Respuesta HTTP 201 con el pase emitido o 403 si hay bloqueo documental.
 */
const createPass = async (req, res) => {
  try {
    await ensureAuthorizedEmployeesColumn();
    await db.query(`ALTER TABLE public.access_passes ADD COLUMN IF NOT EXISTS visit_request_id INTEGER NULL;`);

    // Etapa 1: Validar campos obligatorios y existencia del prestador (junto a fechas de compliance)
    const ownerId = Number(req.user?.userId || req.user?.id);
    const userRole = String(req.user?.role || '').toLowerCase();
    const countryId = req.user?.countryId ? Number(req.user.countryId) : null;
    const {
      provider_id,
      visit_request_id,
      fraction_number,
      lot_number,
      vehicle_plate,
      employee_ids,
      start_time,
      end_time,
    } = req.body;

    if (!provider_id || !start_time || !end_time) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios (provider_id, start_time, end_time).',
      });
    }

    let resolvedVisitRequestId = null;
    let visitProviderId = null;
    if (visit_request_id !== undefined && visit_request_id !== null && String(visit_request_id).trim() !== '') {
      const numericVisitId = Number(visit_request_id);
      if (!Number.isNaN(numericVisitId) && numericVisitId > 0) {
        await ensureVisitRequestsTable();
        const vrCheck = await db.query(
          'SELECT id, owner_id, provider_id FROM visit_requests WHERE id = $1 LIMIT 1',
          [numericVisitId]
        );
        if (vrCheck.rows.length > 0) {
          if (userRole === 'superadmin' || Number(vrCheck.rows[0].owner_id) === ownerId) {
            resolvedVisitRequestId = numericVisitId;
            visitProviderId = Number(vrCheck.rows[0].provider_id) || null;
          }
        }
      }
    }

    const effectiveProviderId = visitProviderId || Number(provider_id);

    const providerCheck = await db.query(
      `SELECT p.id, p.criminal_record_expiry, p.criminal_record_issued_at, p.insurance_expiry, u.country_id
       FROM providers p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1
       LIMIT 1`,
      [effectiveProviderId]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
    }

    // Etapa 2: Validar que la ubicación pertenezca a la cuenta registrada del residente
    const locationResult = await resolveResidentLocation(ownerId, fraction_number, lot_number);
    if (locationResult.error) {
      return res.status(400).json({ error: locationResult.error });
    }

    // Etapa 2.5: Consultar ventana de vigencia de Antecedentes Penales configurada por la comunidad del residente
    const effectiveCountryId = countryId || providerCheck.rows[0].country_id || null;
    let communityCriminalWindowDays = 180;
    if (effectiveCountryId) {
      const countryWinRes = await db
        .query('SELECT COALESCE(criminal_record_max_age_days, 180) AS max_days FROM countries WHERE id = $1 LIMIT 1', [
          Number(effectiveCountryId),
        ])
        .catch(() => ({ rows: [] }));
      if (countryWinRes.rows[0]?.max_days) {
        communityCriminalWindowDays = Number(countryWinRes.rows[0].max_days);
      }
    }

    // Etapa 3: Construir snapshot de ayudantes y bloquear emisión ante vencimiento documental (titular o cuadrilla)
    const authorizedEmployees = await resolveAuthorizedEmployeesSnapshot(
      effectiveProviderId,
      employee_ids
    );

    const expiryViolation = findComplianceExpiryViolation({
      criminalRecordIssuedAt: providerCheck.rows[0].criminal_record_issued_at,
      criminalRecordExpiry: providerCheck.rows[0].criminal_record_expiry,
      criminalRecordMaxAgeDays: communityCriminalWindowDays,
      insuranceExpiry: providerCheck.rows[0].insurance_expiry,
      authorizedEmployees,
      context: 'create',
    });
    if (expiryViolation) {
      return res.status(403).json({
        code: expiryViolation.code,
        expiry_date: expiryViolation.expiry_date,
        error: expiryViolation.message,
      });
    }

    // Etapa 4: Generar token QR seguro e insertar el pase adaptándose a la existencia de `vehicle_plate`
    const qrToken = crypto.randomBytes(32).toString('hex');
    const supportsPlate = await hasVehiclePlateColumn();

    const insertSql = supportsPlate
      ? `INSERT INTO access_passes (
           country_id, owner_id, provider_id, visit_request_id, fraction_number, lot_number,
           vehicle_plate, authorized_employees, qr_token, start_time, end_time, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 'pending')
         RETURNING *`
      : `INSERT INTO access_passes (
           country_id, owner_id, provider_id, visit_request_id, fraction_number, lot_number,
           authorized_employees, qr_token, start_time, end_time, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'pending')
         RETURNING *`;

    // Armar arreglo de parámetros posicionales acorde al esquema detectado (con o sin `vehicle_plate`)
    const params = supportsPlate
      ? [
          effectiveCountryId,
          ownerId,
          effectiveProviderId,
          resolvedVisitRequestId,
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          vehicle_plate ? String(vehicle_plate).trim().toUpperCase() : null,
          JSON.stringify(authorizedEmployees),
          qrToken,
          start_time,
          end_time,
        ]
      : [
          effectiveCountryId,
          ownerId,
          effectiveProviderId,
          resolvedVisitRequestId,
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          JSON.stringify(authorizedEmployees),
          qrToken,
          start_time,
          end_time,
        ];

    const created = await db.query(insertSql, params);
    const createdPass = {
      ...created.rows[0],
      authorized_employees: parseAuthorizedEmployeesArray(created.rows[0].authorized_employees),
    };

    // Etapa 5: Reservar automáticamente la franja horaria en la agenda del prestador
    await upsertScheduleBlock({
      providerId: effectiveProviderId,
      blockType: 'trustlink_pass',
      title: `Pase QR #${createdPass.id} (${locationResult.fractionDisplay} · Lote ${locationResult.lotNumber})`,
      startAt: start_time,
      endAt: end_time,
      sourceRef: `pass-${createdPass.id}`,
    });

    return res.status(201).json({
      message: 'Pase QR emitido correctamente y franja reservada en la agenda del prestador.',
      pass: createdPass,
    });
  } catch (error) {
    console.error('Error al emitir pase QR:', error);
    return res.status(500).json({ error: 'Error interno al emitir el pase QR.' });
  }
};

/**
 * Lista los pases QR emitidos por el residente/familia autenticado,
 * actualizando previamente pases vencidos y adjuntando datos del prestador, cuadrilla y comunidad.
 * GET /api/v1/passes/my
 *
 * @param {import('express').Request} req - Solicitud autenticada del residente.
 * @param {import('express').Response} res - Respuesta HTTP con `{ passes }`.
 */
const getMyPasses = async (req, res) => {
  try {
    // Etapa 1: Sincronizar esquema/vencimientos y resolver proyección opcional de patente
    await ensureAuthorizedEmployeesColumn();
    await ensureVisitRequestsTable();
    await db.query(`ALTER TABLE public.access_passes ADD COLUMN IF NOT EXISTS visit_request_id INTEGER NULL;`);
    await expireOverduePasses();
    const ownerId = req.user.userId;
    const supportsPlate = await hasVehiclePlateColumn();
    const plateSelect = supportsPlate ? 'ap.vehicle_plate,' : 'NULL::text AS vehicle_plate,';

    // Etapa 2: Consultar pases emitidos por el residente enriquecidos con prestador, servicio y comunidad
    const result = await db.query(
      `SELECT
         ap.id,
         ap.country_id,
         ap.owner_id,
         ap.provider_id,
         ap.visit_request_id,
         ap.fraction_number,
         ap.lot_number,
         ${plateSelect}
         COALESCE(ap.authorized_employees, '[]'::jsonb) AS authorized_employees,
         ap.qr_token,
         ap.start_time,
         ap.end_time,
         ap.status,
         ap.created_at,
         vr.service_title AS visit_service_title,
         vr.service_specialty AS visit_service_specialty,
         TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
         u_prov.phone AS provider_phone,
         p.specialty AS provider_specialty,
         c.name AS country_name
       FROM access_passes ap
       LEFT JOIN visit_requests vr ON vr.id = ap.visit_request_id
       LEFT JOIN providers p ON ap.provider_id = p.id
       LEFT JOIN users u_prov ON p.user_id = u_prov.id
       LEFT JOIN countries c ON ap.country_id = c.id
       WHERE ap.owner_id = $1
       ORDER BY ap.id DESC`,
      [ownerId]
    );

    const passes = result.rows.map((row) => ({
      ...row,
      authorized_employees: parseAuthorizedEmployeesArray(row.authorized_employees),
    }));

    return res.status(200).json({ passes });
  } catch (error) {
    console.error('Error al obtener pases del residente:', error);
    return res.status(500).json({ error: 'Error interno al consultar los pases QR.' });
  }
};

/**
 * Lista todos los pases QR asignados a cualquiera de los perfiles de prestador del usuario autenticado,
 * incluyendo datos de contacto del residente autorizante y la cuadrilla incluida.
 * GET /api/v1/passes/provider
 *
 * @param {import('express').Request} req - Solicitud autenticada del prestador.
 * @param {import('express').Response} res - Respuesta HTTP con `{ passes }`.
 */
const listProviderPasses = async (req, res) => {
  try {
    // Etapa 1: Sincronizar vencimientos y resolver todos los IDs de prestador del usuario
    await ensureAuthorizedEmployeesColumn();
    await expireOverduePasses();
    const userId = req.user.userId;

    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );

    const providerIds = providerProfilesRes.rows.map((row) => Number(row.id)).filter(Boolean);

    if (providerIds.length === 0) {
      return res.status(200).json({ passes: [] });
    }

    // Etapa 2: Consultar pases asignados junto a datos del residente autorizante y comunidad
    const supportsPlate = await hasVehiclePlateColumn();
    const plateSelect = supportsPlate ? 'ap.vehicle_plate,' : 'NULL::text AS vehicle_plate,';

    const result = await db.query(
      `SELECT
         ap.id,
         ap.country_id,
         ap.owner_id,
         ap.provider_id,
         ap.fraction_number,
         ap.lot_number,
         ${plateSelect}
         COALESCE(ap.authorized_employees, '[]'::jsonb) AS authorized_employees,
         ap.qr_token,
         ap.start_time,
         ap.end_time,
         ap.status,
         ap.created_at,
         u_owner.first_name AS owner_first_name,
         u_owner.last_name AS owner_last_name,
         u_owner.phone AS owner_phone,
         TRIM(CONCAT(COALESCE(u_owner.first_name, ''), ' ', COALESCE(u_owner.last_name, ''))) AS authorized_by,
         p.specialty AS provider_specialty,
         c.name AS country_name
       FROM access_passes ap
       LEFT JOIN users u_owner ON ap.owner_id = u_owner.id
       LEFT JOIN providers p ON ap.provider_id = p.id
       LEFT JOIN countries c ON ap.country_id = c.id
       WHERE ap.provider_id = ANY($1::int[])
       ORDER BY ap.id DESC`,
      [providerIds]
    );

    // Normalizar la cuadrilla autorizada en cada pase antes de responder
    const passes = result.rows.map((row) => ({
      ...row,
      authorized_employees: parseAuthorizedEmployeesArray(row.authorized_employees),
    }));

    return res.status(200).json({ passes });
  } catch (error) {
    console.error('Error al listar pases QR del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar los pases QR del prestador.' });
  }
};

/**
 * Permite al residente/familia editar un pase QR propio mientras se encuentre vigente
 * (`status === 'pending'` y `end_time > NOW()` en UTC).
 * Valida pertenencia de ubicación registrada y vigencia del seguro de cualquier ayudante agregado.
 * PATCH /api/v1/passes/:id
 *
 * @param {import('express').Request} req - Param `id`; body opcional con `fraction_number`, `lot_number`, `vehicle_plate`, `employee_ids`, `start_time`, `end_time`.
 * @param {import('express').Response} res - Respuesta HTTP con el pase actualizado.
 */
const updatePass = async (req, res) => {
  try {
    await ensureAuthorizedEmployeesColumn();
    await expireOverduePasses();

    // Etapa 1: Validar ID y obtener registro actual del pase junto con marcas UTC de vigencia
    const passId = Number(req.params.id);
    const ownerId = Number(req.user.userId);

    if (!Number.isInteger(passId) || passId <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const currentRes = await db.query(
      `SELECT
         id, owner_id, provider_id, status, start_time, end_time,
         COALESCE(authorized_employees, '[]'::jsonb) AS authorized_employees,
         (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
         (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_utc_ms
       FROM access_passes
       WHERE id = $1
       LIMIT 1`,
      [passId]
    );

    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    // Etapa 2: Verificar propiedad del residente y que el pase siga vigente (`pending` y no vencido)
    const currentPass = currentRes.rows[0];
    if (Number(currentPass.owner_id) !== ownerId) {
      return res.status(403).json({ error: 'No tenés permiso para editar este pase.' });
    }

    const isActivePending =
      String(currentPass.status || '').toLowerCase() === 'pending' &&
      Number(currentPass.end_utc_ms) > Number(currentPass.now_utc_ms);

    if (!isActivePending) {
      return res.status(400).json({
        error: 'Solo se pueden editar pases que se encuentren vigentes.',
      });
    }

    // Etapa 3: Validar ubicación registrada del residente (anti-suplantación)
    const { fraction_number, lot_number, vehicle_plate, employee_ids, start_time, end_time } = req.body;
    const locationResult = await resolveResidentLocation(ownerId, fraction_number, lot_number);
    if (locationResult.error) {
      return res.status(400).json({ error: locationResult.error });
    }

    // Etapa 4: Recalcular cuadrilla si fue enviada y bloquear si algún ayudante tiene seguro vencido
    const nextAuthorizedEmployees = Array.isArray(employee_ids)
      ? await resolveAuthorizedEmployeesSnapshot(Number(currentPass.provider_id), employee_ids)
      : parseAuthorizedEmployeesArray(currentPass.authorized_employees);

    if (Array.isArray(employee_ids) && nextAuthorizedEmployees.length > 0) {
      const crewViolation = findComplianceExpiryViolation({
        authorizedEmployees: nextAuthorizedEmployees,
        context: 'create',
      });
      if (crewViolation) {
        return res.status(403).json({
          code: crewViolation.code,
          expiry_date: crewViolation.expiry_date,
          error: crewViolation.message,
        });
      }
    }

    // Etapa 5: Persistir actualización en `access_passes` adaptándose a la columna opcional `vehicle_plate`
    const supportsPlate = await hasVehiclePlateColumn();

    const updateSql = supportsPlate
      ? `UPDATE access_passes
         SET fraction_number = $1,
             lot_number = $2,
             vehicle_plate = $3,
             authorized_employees = $4::jsonb,
             start_time = COALESCE($5, start_time),
             end_time = COALESCE($6, end_time)
         WHERE id = $7
         RETURNING *`
      : `UPDATE access_passes
         SET fraction_number = $1,
             lot_number = $2,
             authorized_employees = $3::jsonb,
             start_time = COALESCE($4, start_time),
             end_time = COALESCE($5, end_time)
         WHERE id = $6
         RETURNING *`;

    const normalizedPlate =
      vehicle_plate && String(vehicle_plate).trim() !== ''
        ? String(vehicle_plate).trim().toUpperCase()
        : null;

    // Armar arreglo de parámetros posicionales acorde al esquema detectado (con o sin `vehicle_plate`)
    const params = supportsPlate
      ? [
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          normalizedPlate,
          JSON.stringify(nextAuthorizedEmployees),
          start_time || null,
          end_time || null,
          passId,
        ]
      : [
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          JSON.stringify(nextAuthorizedEmployees),
          start_time || null,
          end_time || null,
          passId,
        ];

    const updated = await db.query(updateSql, params);
    const updatedPass = {
      ...updated.rows[0],
      authorized_employees: parseAuthorizedEmployeesArray(updated.rows[0].authorized_employees),
    };

    return res.status(200).json({
      message: 'Pase QR actualizado correctamente.',
      pass: updatedPass,
    });
  } catch (error) {
    console.error('Error al actualizar pase QR:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el pase QR.' });
  }
};

/**
 * Cancela un pase QR pendiente propio del residente o por un rol administrativo (`admin`/`superadmin`)
 * y libera automáticamente el bloque de agenda asociado (`source_ref = 'pass-<id>'`).
 * PATCH /api/v1/passes/:id/cancel
 *
 * @param {import('express').Request} req - Param `id` del pase QR.
 * @param {import('express').Response} res - Respuesta HTTP con el pase cancelado.
 */
const cancelPass = async (req, res) => {
  try {
    await expireOverduePasses();

    // Etapa 1: Validar ID y obtener estado/propietario del pase
    const passId = Number(req.params.id);
    const userId = req.user.userId;
    const userRole = String(req.user.role || '').toLowerCase();

    if (!Number.isInteger(passId) || passId <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const currentRes = await db.query(
      'SELECT id, owner_id, status FROM access_passes WHERE id = $1 LIMIT 1',
      [passId]
    );

    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    // Etapa 2: Verificar permisos (propietario del pase o rol administrativo) y estado cancelable
    const passRecord = currentRes.rows[0];
    const isAdminRole = userRole === 'admin' || userRole === 'superadmin';

    if (!isAdminRole && Number(passRecord.owner_id) !== Number(userId)) {
      return res.status(403).json({ error: 'No tenés permiso para cancelar este pase QR.' });
    }

    const currentStatus = String(passRecord.status || '').toLowerCase();
    if (currentStatus === 'cancelled') {
      return res.status(200).json({
        message: 'El pase QR ya se encontraba cancelado.',
        pass: passRecord,
      });
    }

    if (currentStatus !== 'pending') {
      return res.status(400).json({
        error: `No se puede cancelar un pase en estado ${currentStatus}.`,
      });
    }

    // Etapa 3: Cambiar estado a `cancelled` y liberar el bloque automático en `provider_schedule_blocks`
    const updated = await db.query(
      `UPDATE access_passes
       SET status = 'cancelled'::pass_status
       WHERE id = $1
       RETURNING *`,
      [passId]
    );

    await db.query('DELETE FROM provider_schedule_blocks WHERE source_ref = $1', [`pass-${passId}`]);

    return res.status(200).json({
      message: `Pase QR #${passId} cancelado correctamente y franja liberada en la agenda.`,
      pass: updated.rows[0],
    });
  } catch (error) {
    console.error('Error al cancelar pase QR:', error);
    return res.status(500).json({ error: 'Error interno al cancelar el pase QR.' });
  }
};

/**
 * Valida un pase QR en tiempo real desde la Consola Garita / consola de seguridad interna.
 * Verifica existencia del pase, compliance aprobado, vencimientos documentales de titular y
 * cuadrilla hidratada, suspensión operativa local en la comunidad, estado pendiente, franja
 * horaria UTC vigente y ejecuta el consumo atómico de ingreso único (`pending` -> `used`).
 * Cada intento queda auditado en `gate_access_logs`.
 * POST /api/v1/passes/verify
 *
 * @param {import('express').Request} req - Body: `{ qr_token }`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ authorized, code, message, details? }`.
 */
const verifyPassByQR = async (req, res) => {
  const integrationLabel = `Consola Garita (${req.user?.role || 'security'})`;
  const { qr_token } = req.body || {};

  try {
    // Etapa 1: Preparar columnas, vencer pases expirados y validar presencia obligatoria de `qr_token`
    await ensureAuthorizedEmployeesColumn();
    await expireOverduePasses();

    if (!qr_token || !String(qr_token).trim()) {
      const msg = 'Debe proporcionar el token QR para validar el acceso.';
      await recordGateAccessLog({
        qrToken: qr_token,
        countryId: req.user?.countryId || null,
        integrationLabel,
        authorized: false,
        reasonCode: 'MISSING_QR_TOKEN',
        message: msg,
        httpStatus: 400,
      });
      return res.status(400).json({
        authorized: false,
        code: 'MISSING_QR_TOKEN',
        error: msg,
        message: msg,
      });
    }

    // Etapa 2: Consultar el pase junto a prestador, compliance, residente, cuadrilla y vehículo (si aplica)
    const supportsPlate = await hasVehiclePlateColumn();
    const plateSelect = supportsPlate ? 'ap.vehicle_plate,' : 'NULL::text AS vehicle_plate,';

    const query = `
      SELECT
        ap.id AS pass_id,
        ap.country_id,
        ap.provider_id,
        ap.status AS pass_status,
        ap.start_time,
        ap.end_time,
        (EXTRACT(EPOCH FROM (ap.start_time AT TIME ZONE 'UTC')) * 1000)::bigint AS start_utc_ms,
        (EXTRACT(EPOCH FROM (ap.end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
        (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_utc_ms,
        ap.fraction_number,
        ap.lot_number,
        ${plateSelect}
        COALESCE(ap.authorized_employees, '[]'::jsonb) AS authorized_employees,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        u_prov.phone AS provider_phone,
        p.specialty AS provider_specialty,
        p.status AS compliance_status,
        p.criminal_record_issued_at,
        p.criminal_record_expiry,
        p.insurance_expiry,
        COALESCE(c_pass.criminal_record_max_age_days, 180) AS criminal_record_max_age_days,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        u_owner.phone AS owner_phone,
        pv.vehicle_type,
        pv.brand,
        pv.model,
        pv.color,
        pv.plate
      FROM access_passes ap
      JOIN providers p ON ap.provider_id = p.id
      JOIN users u_prov ON p.user_id = u_prov.id
      JOIN users u_owner ON ap.owner_id = u_owner.id
      LEFT JOIN countries c_pass ON c_pass.id = ap.country_id
      LEFT JOIN provider_vehicles pv ON pv.provider_id = p.id
        AND (${supportsPlate ? 'ap.vehicle_plate IS NULL OR UPPER(pv.plate) = UPPER(ap.vehicle_plate)' : 'TRUE'})
      WHERE ap.qr_token = $1
      ORDER BY pv.id DESC
      LIMIT 1
    `;

    const result = await db.query(query, [String(qr_token).trim()]);

    // Rechazar y auditar cuando el token no corresponde a ningún pase registrado
    if (result.rows.length === 0) {
      const msg = 'Pase QR inválido o inexistente.';
      await recordGateAccessLog({
        qrToken: qr_token,
        countryId: req.user?.countryId || null,
        integrationLabel,
        authorized: false,
        reasonCode: 'PASS_NOT_FOUND',
        message: msg,
        httpStatus: 404,
      });
      return res.status(404).json({
        authorized: false,
        code: 'PASS_NOT_FOUND',
        error: msg,
        message: msg,
      });
    }

    const passInfo = result.rows[0];

    // Etapa 3: Validar que el prestador cuente con compliance aprobado (`approved`)
    if (passInfo.compliance_status !== 'approved') {
      const msg = `El prestador no posee compliance aprobado (estado: ${passInfo.compliance_status}).`;
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id,
        integrationLabel,
        authorized: false,
        reasonCode: 'COMPLIANCE_NOT_APPROVED',
        message: msg,
        httpStatus: 403,
      });
      return res.status(403).json({
        authorized: false,
        code: 'COMPLIANCE_NOT_APPROVED',
        error: msg,
        message: msg,
      });
    }

    // Etapa 4: Hidratar vencimientos vigentes de la cuadrilla y bloquear ante cualquier documento expirado
    const parsedCrew = parseAuthorizedEmployeesArray(passInfo.authorized_employees);
    const hydratedCrew = await hydrateAuthorizedEmployeesExpiry(db, parsedCrew);
    const expiryViolation = findComplianceExpiryViolation({
      criminalRecordIssuedAt: passInfo.criminal_record_issued_at,
      criminalRecordExpiry: passInfo.criminal_record_expiry,
      criminalRecordMaxAgeDays: passInfo.criminal_record_max_age_days,
      insuranceExpiry: passInfo.insurance_expiry,
      authorizedEmployees: hydratedCrew,
      context: 'gate',
    });
    if (expiryViolation) {
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id,
        integrationLabel,
        authorized: false,
        reasonCode: expiryViolation.code,
        message: expiryViolation.message,
        httpStatus: 403,
      });
      return res.status(403).json({
        authorized: false,
        code: expiryViolation.code,
        expiry_date: expiryViolation.expiry_date,
        error: expiryViolation.message,
        message: expiryViolation.message,
      });
    }

    // Etapa 5: Verificar si existe una suspensión operativa local activa en la comunidad
    const activeSuspension = await findActiveLocalSuspension(
      passInfo.country_id || req.user?.countryId,
      passInfo.provider_id
    );
    if (activeSuspension) {
      const msg = `Ingreso bloqueado por suspensión operativa local en la comunidad: ${activeSuspension.reason}`;
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id || req.user?.countryId || null,
        integrationLabel,
        authorized: false,
        reasonCode: 'LOCAL_SUSPENSION_ACTIVE',
        message: msg,
        httpStatus: 403,
      });
      return res.status(403).json({
        authorized: false,
        code: 'LOCAL_SUSPENSION_ACTIVE',
        error: msg,
        message: msg,
      });
    }

    // Etapa 6: Validar estado del pase (rechazar pases ya usados o en estado distinto de `pending`)
    if (passInfo.pass_status === 'used') {
      const msg = 'El pase QR ya fue utilizado para un ingreso previo.';
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id,
        integrationLabel,
        authorized: false,
        reasonCode: 'PASS_ALREADY_USED',
        message: msg,
        httpStatus: 403,
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_ALREADY_USED',
        error: msg,
        message: msg,
      });
    }

    if (passInfo.pass_status !== 'pending') {
      const msg = `El pase se encuentra en estado ${passInfo.pass_status}.`;
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id,
        integrationLabel,
        authorized: false,
        reasonCode: 'PASS_NOT_ELIGIBLE',
        message: msg,
        httpStatus: 400,
      });
      return res.status(400).json({
        authorized: false,
        code: 'PASS_NOT_ELIGIBLE',
        error: msg,
        message: msg,
      });
    }

    // Etapa 7: Comprobar que la hora UTC actual esté dentro de la franja autorizada [startMs, endMs]
    const startMs = Number(passInfo.start_utc_ms);
    const endMs = Number(passInfo.end_utc_ms);
    const nowMs = Number(passInfo.now_utc_ms);

    if (nowMs < startMs || nowMs > endMs) {
      const msg = 'El pase se encuentra fuera de la franja horaria autorizada.';
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id,
        integrationLabel,
        authorized: false,
        reasonCode: 'OUT_OF_TIME_WINDOW',
        message: msg,
        httpStatus: 400,
      });
      return res.status(400).json({
        authorized: false,
        code: 'OUT_OF_TIME_WINDOW',
        error: msg,
        message: msg,
      });
    }

    // Etapa 8: Consumo atómico de ingreso único (`pending` -> `used`) para evitar reuso concurrente
    const consumedRes = await db.query(
      `UPDATE access_passes
       SET status = 'used'::pass_status
       WHERE id = $1 AND status = 'pending'::pass_status
       RETURNING id, status`,
      [passInfo.pass_id]
    );

    if (consumedRes.rows.length === 0) {
      const msg = 'El pase QR ya fue utilizado para un ingreso previo.';
      await recordGateAccessLog({
        qrToken: qr_token,
        passId: passInfo.pass_id,
        countryId: passInfo.country_id,
        integrationLabel,
        authorized: false,
        reasonCode: 'PASS_ALREADY_USED',
        message: msg,
        httpStatus: 403,
      });
      return res.status(403).json({
        authorized: false,
        code: 'PASS_ALREADY_USED',
        error: msg,
        message: msg,
      });
    }

    // Etapa 9: Registrar auditoría de ingreso concedido y devolver ficha visual para Consola Garita
    const grantedMsg = 'Acceso autorizado. Pase QR marcado como utilizado (ingreso único).';
    await recordGateAccessLog({
      qrToken: qr_token,
      passId: passInfo.pass_id,
      countryId: passInfo.country_id,
      integrationLabel,
      authorized: true,
      reasonCode: 'ACCESS_GRANTED',
      message: grantedMsg,
      httpStatus: 200,
    });

    // Resolver patente efectiva priorizando la declarada en el pase sobre la ficha del vehículo
    const authorizedEmployees = hydratedCrew;
    const effectivePlate = passInfo.vehicle_plate || passInfo.plate || null;

    return res.status(200).json({
      authorized: true,
      code: 'ACCESS_GRANTED',
      message: grantedMsg,
      details: {
        pass_id: passInfo.pass_id,
        status: 'used',
        provider_name: `${passInfo.provider_first_name} ${passInfo.provider_last_name}`,
        provider_dni: passInfo.provider_dni,
        provider_phone: passInfo.provider_phone || null,
        specialty: passInfo.provider_specialty,
        authorized_by: `${passInfo.owner_first_name} ${passInfo.owner_last_name}`,
        owner_phone: passInfo.owner_phone || null,
        fraction_number: passInfo.fraction_number,
        lot_number: passInfo.lot_number,
        start_time: passInfo.start_time,
        end_time: passInfo.end_time,
        vehicle_plate: effectivePlate,
        authorized_employees: authorizedEmployees,
        vehicle:
          passInfo.brand || effectivePlate
            ? {
                vehicle_type: passInfo.vehicle_type,
                brand: passInfo.brand,
                model: passInfo.model,
                color: passInfo.color,
                plate: effectivePlate,
              }
            : null,
      },
    });
  } catch (error) {
    console.error('Error al validar pase en garita:', error);
    return res.status(500).json({
      authorized: false,
      code: 'INTERNAL_SERVER_ERROR',
      error: 'Error interno del servidor al validar el acceso.',
    });
  }
};

// Exportaciones públicas del módulo de agenda, coordinación de visitas, pases QR y Consola Garita
module.exports = {
  getProviderSchedule,
  saveProviderAvailabilityRules,
  getProviderPublicAvailability,
  createScheduleBlock,
  deleteScheduleBlock,
  createVisitCoordination,
  listMyVisitRequests,
  listProviderVisitRequests,
  addVisitRequestMessage,
  respondVisitRequest,
  respondVisitRequestAsResident,
  createPass,
  getMyPasses,
  listProviderPasses,
  updatePass,
  cancelPass,
  verifyPassByQR,
};