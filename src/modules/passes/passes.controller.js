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

/**
 * Asegura la existencia de la tabla gate_access_logs para auditar validaciones de Consola Garita.
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

const maskQrToken = (token) => {
  if (!token) return null;
  const clean = String(token).trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 8)}...${clean.slice(-6)}`;
};

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

const findActiveLocalSuspension = async (countryId, providerId) => {
  if (!countryId || !providerId) return null;
  try {
    const tableCheck = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'provider_local_suspensions'
       LIMIT 1`
    );
    if (tableCheck.rows.length === 0) return null;

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
 * Crea o actualiza de forma idempotente la tabla visit_requests y sus columnas.
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
      notes TEXT NULL,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_provider',
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS country_id INTEGER NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS fraction_number VARCHAR(100) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS lot_number VARCHAR(100) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS preferred_date VARCHAR(50) NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS notes TEXT NULL;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE visit_requests ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending_provider';`);
};

/**
 * Crea o actualiza de forma idempotente la tabla provider_schedule_blocks
 * para gestionar horarios no laborables, visitas externas y bloqueos automáticos de TrustLink.
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

  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS block_type VARCHAR(30) NOT NULL DEFAULT 'unavailable';`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS title VARCHAR(160) NULL;`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS start_at TIMESTAMP WITHOUT TIME ZONE NULL;`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS end_at TIMESTAMP WITHOUT TIME ZONE NULL;`);
  await db.query(`ALTER TABLE provider_schedule_blocks ADD COLUMN IF NOT EXISTS source_ref VARCHAR(80) NULL;`);
};

/**
 * Registra un bloque de agenda para un prestador evitando duplicados exactos por source_ref.
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
  const parsedStart = new Date(startAt);
  if (Number.isNaN(parsedStart.getTime())) return;

  const parsedEnd = endAt
    ? new Date(endAt)
    : new Date(parsedStart.getTime() + 2 * 60 * 60 * 1000);
  const safeEnd = Number.isNaN(parsedEnd.getTime()) || parsedEnd <= parsedStart
    ? new Date(parsedStart.getTime() + 2 * 60 * 60 * 1000)
    : parsedEnd;

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
 * Normaliza el campo messages de una solicitud de visita a un array.
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
 * Marca como 'expired' los pases 'pending' cuya end_time ya venció en UTC.
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
 * Verifica si existe la columna vehicle_plate en access_passes para compatibilidad de esquema.
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
 * Obtiene y valida la ubicación residencial registrada del residente en la tabla `users`.
 * - Toma automáticamente `fraction_type` ('manzana' | 'fraccion' | 'na'), `fraction_number` y `lot_number`.
 * - Exige que el residente tenga un `lot_number` cargado en su cuenta.
 * - Si se recibe un `lot_number` o `fraction_number` distinto al registrado del residente, rechaza la operación
 *   para garantizar que el residente solo pida visitas o emita pases hacia su propia ubicación registrada.
 */
const resolveResidentLocation = async (residentUserId, requestedFractionNumber, requestedLotNumber) => {
  await ensureEvolutionSchema();

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
 * Obtiene la agenda del prestador (bloques manuales/externos/automáticos + pases QR vigentes/pendientes).
 * GET /api/v1/passes/schedule/provider
 */
const getProviderSchedule = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    await expireOverduePasses();

    const userId = Number(req.user?.userId || req.user?.id);
    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );
    const providerIds = providerProfilesRes.rows.map((r) => Number(r.id)).filter(Boolean);

    if (providerIds.length === 0) {
      return res.status(200).json({ blocks: [], passes: [] });
    }

    const blocksRes = await db.query(
      `SELECT *
       FROM provider_schedule_blocks
       WHERE provider_id = ANY($1::int[])
       ORDER BY start_at ASC, id DESC`,
      [providerIds]
    );

    const passesRes = await db.query(
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
    );

    return res.status(200).json({
      blocks: blocksRes.rows,
      passes: passesRes.rows,
    });
  } catch (error) {
    console.error('Error al obtener agenda del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar la agenda del prestador.' });
  }
};

/**
 * Crea un bloque manual en la agenda del prestador (horario no laborable o visita externa).
 * POST /api/v1/passes/schedule/blocks
 */
const createScheduleBlock = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    const userId = Number(req.user?.userId || req.user?.id);
    const { block_type, title, start_at, end_at } = req.body;

    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1 ORDER BY id ASC LIMIT 1',
      [userId]
    );

    if (providerProfilesRes.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontró un perfil de prestador asociado.' });
    }

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

    const cleanTitle =
      String(title || '').trim() ||
      (normalizedType === 'external_visit' ? 'Visita externa agendada' : 'Horario no laborable');

    const inserted = await db.query(
      `INSERT INTO provider_schedule_blocks (provider_id, block_type, title, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [providerId, normalizedType, cleanTitle, startDate.toISOString(), endDate.toISOString()]
    );

    return res.status(201).json({
      message:
        normalizedType === 'external_visit'
          ? 'Visita externa registrada y franja bloqueada en tu agenda.'
          : 'Horario no laborable bloqueado en tu agenda.',
      block: inserted.rows[0],
    });
  } catch (error) {
    console.error('Error al crear bloque de agenda:', error);
    return res.status(500).json({ error: 'Error interno al guardar el bloque en la agenda.' });
  }
};

/**
 * Elimina un bloque manual de agenda del prestador.
 * DELETE /api/v1/passes/schedule/blocks/:blockId
 */
const deleteScheduleBlock = async (req, res) => {
  try {
    await ensureScheduleBlocksTable();
    const blockId = Number(req.params.blockId);
    const userId = Number(req.user?.userId || req.user?.id);

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: 'ID de bloque inválido.' });
    }

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
 * Toma automáticamente Manzana/Fracción/N/A y Lote desde el registro del residente en `users`.
 * POST /api/v1/passes/visit-requests
 */
const createVisitCoordination = async (req, res) => {
  try {
    await ensureVisitRequestsTable();

    const ownerId = Number(req.user?.userId || req.user?.id);
    const countryId = req.user?.countryId ? Number(req.user.countryId) : null;
    const {
      provider_id,
      fraction_number,
      lot_number,
      preferred_date,
      notes,
    } = req.body;

    if (!ownerId) {
      return res.status(401).json({
        error: 'Sesión de residente inválida o expirada. Volvé a iniciar sesión.',
      });
    }

    if (!provider_id || !notes || !String(notes).trim()) {
      return res.status(400).json({
        error: 'Indicá el prestador y el detalle/mensaje de coordinación de la visita.',
      });
    }

    const providerCheck = await db.query(
      `SELECT p.id, u.country_id
       FROM providers p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1
       LIMIT 1`,
      [Number(provider_id)]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
    }

    const locationResult = await resolveResidentLocation(ownerId, fraction_number, lot_number);
    if (locationResult.error) {
      return res.status(400).json({ error: locationResult.error });
    }

    const effectiveCountryId = countryId || providerCheck.rows[0].country_id || null;
    const cleanNotes = String(notes).trim();
    const initialMessages = [
      {
        id: `msg-${Date.now()}`,
        sender_role: 'owner',
        sender_id: ownerId,
        text: cleanNotes,
        created_at: new Date().toISOString(),
      },
    ];

    const inserted = await db.query(
      `INSERT INTO visit_requests (
         country_id, owner_id, provider_id, fraction_number, lot_number,
         preferred_date, notes, messages, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending_provider')
       RETURNING *`,
      [
        effectiveCountryId,
        ownerId,
        Number(provider_id),
        locationResult.fractionDisplay,
        locationResult.lotNumber,
        preferred_date ? String(preferred_date).trim() : null,
        cleanNotes,
        JSON.stringify(initialMessages),
      ]
    );

    const row = inserted.rows[0];
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
 * Lista las solicitudes de visita del residente autenticado.
 * GET /api/v1/passes/visit-requests/my
 */
const listMyVisitRequests = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
    const ownerId = Number(req.user?.userId || req.user?.id);

    const result = await db.query(
      `SELECT
         vr.*,
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
 * Lista las solicitudes de visita recibidas por el prestador autenticado.
 * GET /api/v1/passes/visit-requests/provider
 */
const listProviderVisitRequests = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
    const userId = Number(req.user?.userId || req.user?.id);

    const providerProfilesRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1',
      [userId]
    );

    const providerIds = providerProfilesRes.rows.map((r) => Number(r.id)).filter(Boolean);
    if (providerIds.length === 0) {
      return res.status(200).json({ visits: [] });
    }

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
 * Agrega un mensaje dentro del hilo de coordinación de una visita.
 * POST /api/v1/passes/visit-requests/:id/messages
 */
const addVisitRequestMessage = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
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
 * Responde a una solicitud de visita (confirmar, proponer horario o rechazar) y bloquea agenda si se confirma.
 * PATCH /api/v1/passes/visit-requests/:id/respond
 */
const respondVisitRequest = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
    const visitId = Number(req.params.id);
    const userId = Number(req.user?.userId || req.user?.id);
    const { action, preferred_date, reply_text } = req.body;

    if (!Number.isInteger(visitId) || visitId <= 0) {
      return res.status(400).json({ error: 'ID de visita inválido.' });
    }

    const normalizedAction = String(action || '').toLowerCase();
    if (!['confirm', 'decline', 'propose'].includes(normalizedAction)) {
      return res.status(400).json({ error: 'Acción inválida (confirm | propose | decline).' });
    }

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

    const nextStatus =
      normalizedAction === 'confirm'
        ? 'confirmed'
        : normalizedAction === 'decline'
        ? 'declined'
        : 'pending_provider';

    const nextDate = preferred_date ? String(preferred_date).trim() : visit.preferred_date;
    const currentMessages = parseMessagesArray(visit.messages);

    const autoSummaryText =
      String(reply_text || '').trim() ||
      (normalizedAction === 'confirm'
        ? `Disponibilidad confirmada${nextDate ? ` para ${nextDate}` : ''}. Ya podés emitir el Pase QR.`
        : normalizedAction === 'decline'
        ? 'No tengo disponibilidad para esa visita en este momento.'
        : `Propongo coordinar para ${nextDate || 'otro horario'}.`);

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

    const updated = await db.query(
      `UPDATE visit_requests
       SET status = $1,
           preferred_date = $2,
           messages = $3::jsonb
       WHERE id = $4
       RETURNING *`,
      [nextStatus, nextDate, JSON.stringify(updatedMessages), visitId]
    );

    if (normalizedAction === 'confirm' && nextDate) {
      await upsertScheduleBlock({
        providerId: visit.provider_id,
        blockType: 'trustlink_visit',
        title: `Visita TrustLink #${visitId} (${visit.fraction_number || ''} ${visit.lot_number || ''})`.trim(),
        startAt: nextDate,
        sourceRef: `visit-${visitId}`,
      });
    }

    const row = updated.rows[0];
    return res.status(200).json({
      message:
        normalizedAction === 'confirm'
          ? 'Disponibilidad confirmada y horario bloqueado en tu agenda.'
          : normalizedAction === 'decline'
          ? 'Visita marcada como sin disponibilidad.'
          : 'Propuesta enviada al residente.',
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
 * Emite un nuevo Pase QR para un prestador.
 * Toma automáticamente Manzana/Fracción/N/A y Lote del residente registrado en `users`
 * y bloquea la franja horaria en la agenda del prestador.
 * POST /api/v1/passes/create
 */
const createPass = async (req, res) => {
  try {
    const ownerId = Number(req.user?.userId || req.user?.id);
    const countryId = req.user?.countryId ? Number(req.user.countryId) : null;
    const {
      provider_id,
      fraction_number,
      lot_number,
      vehicle_plate,
      start_time,
      end_time,
    } = req.body;

    if (!provider_id || !start_time || !end_time) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios (provider_id, start_time, end_time).',
      });
    }

    const providerCheck = await db.query(
      `SELECT p.id, u.country_id
       FROM providers p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1
       LIMIT 1`,
      [Number(provider_id)]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
    }

    const locationResult = await resolveResidentLocation(ownerId, fraction_number, lot_number);
    if (locationResult.error) {
      return res.status(400).json({ error: locationResult.error });
    }

    const effectiveCountryId = countryId || providerCheck.rows[0].country_id || null;
    const qrToken = crypto.randomBytes(32).toString('hex');
    const supportsPlate = await hasVehiclePlateColumn();

    const insertSql = supportsPlate
      ? `INSERT INTO access_passes (
           country_id, owner_id, provider_id, fraction_number, lot_number,
           vehicle_plate, qr_token, start_time, end_time, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         RETURNING *`
      : `INSERT INTO access_passes (
           country_id, owner_id, provider_id, fraction_number, lot_number,
           qr_token, start_time, end_time, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING *`;

    const params = supportsPlate
      ? [
          effectiveCountryId,
          ownerId,
          Number(provider_id),
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          vehicle_plate ? String(vehicle_plate).trim().toUpperCase() : null,
          qrToken,
          start_time,
          end_time,
        ]
      : [
          effectiveCountryId,
          ownerId,
          Number(provider_id),
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          qrToken,
          start_time,
          end_time,
        ];

    const created = await db.query(insertSql, params);
    const createdPass = created.rows[0];

    await upsertScheduleBlock({
      providerId: Number(provider_id),
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
 * Lista los pases QR emitidos por el residente/familia autenticado.
 * GET /api/v1/passes/my
 */
const getMyPasses = async (req, res) => {
  try {
    await expireOverduePasses();
    const ownerId = req.user.userId;
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
         ap.qr_token,
         ap.start_time,
         ap.end_time,
         ap.status,
         ap.created_at,
         TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
         p.specialty AS provider_specialty,
         c.name AS country_name
       FROM access_passes ap
       LEFT JOIN providers p ON ap.provider_id = p.id
       LEFT JOIN users u_prov ON p.user_id = u_prov.id
       LEFT JOIN countries c ON ap.country_id = c.id
       WHERE ap.owner_id = $1
       ORDER BY ap.id DESC`,
      [ownerId]
    );

    return res.status(200).json({ passes: result.rows });
  } catch (error) {
    console.error('Error al obtener pases del residente:', error);
    return res.status(500).json({ error: 'Error interno al consultar los pases QR.' });
  }
};

/**
 * Lista los pases QR asignados al prestador autenticado.
 * GET /api/v1/passes/provider
 */
const listProviderPasses = async (req, res) => {
  try {
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
         ap.qr_token,
         ap.start_time,
         ap.end_time,
         ap.status,
         ap.created_at,
         u_owner.first_name AS owner_first_name,
         u_owner.last_name AS owner_last_name,
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

    return res.status(200).json({ passes: result.rows });
  } catch (error) {
    console.error('Error al listar pases QR del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar los pases QR del prestador.' });
  }
};

/**
 * Permite editar un pase QR vigente propio del residente/familia.
 * Conserva y valida que la ubicación pertenezca a la cuenta registrada del residente.
 * PATCH /api/v1/passes/:id
 */
const updatePass = async (req, res) => {
  try {
    await expireOverduePasses();
    const passId = Number(req.params.id);
    const ownerId = Number(req.user.userId);

    if (!Number.isInteger(passId) || passId <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const currentRes = await db.query(
      `SELECT
         id, owner_id, status, start_time, end_time,
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

    const { fraction_number, lot_number, vehicle_plate, start_time, end_time } = req.body;
    const locationResult = await resolveResidentLocation(ownerId, fraction_number, lot_number);
    if (locationResult.error) {
      return res.status(400).json({ error: locationResult.error });
    }

    const supportsPlate = await hasVehiclePlateColumn();

    const updateSql = supportsPlate
      ? `UPDATE access_passes
         SET fraction_number = $1,
             lot_number = $2,
             vehicle_plate = $3,
             start_time = COALESCE($4, start_time),
             end_time = COALESCE($5, end_time)
         WHERE id = $6
         RETURNING *`
      : `UPDATE access_passes
         SET fraction_number = $1,
             lot_number = $2,
             start_time = COALESCE($3, start_time),
             end_time = COALESCE($4, end_time)
         WHERE id = $5
         RETURNING *`;

    const normalizedPlate =
      vehicle_plate && String(vehicle_plate).trim() !== ''
        ? String(vehicle_plate).trim().toUpperCase()
        : null;

    const params = supportsPlate
      ? [
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          normalizedPlate,
          start_time || null,
          end_time || null,
          passId,
        ]
      : [
          locationResult.fractionDisplay,
          locationResult.lotNumber,
          start_time || null,
          end_time || null,
          passId,
        ];

    const updated = await db.query(updateSql, params);

    return res.status(200).json({
      message: 'Pase QR actualizado correctamente.',
      pass: updated.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar pase QR:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el pase QR.' });
  }
};

/**
 * Cancela un pase QR pendiente propio o por rol administrativo y libera el bloque automático de agenda.
 * PATCH /api/v1/passes/:id/cancel
 */
const cancelPass = async (req, res) => {
  try {
    await expireOverduePasses();
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
 * Valida un pase QR en garita / consola de seguridad.
 * POST /api/v1/passes/verify
 */
const verifyPassByQR = async (req, res) => {
  const integrationLabel = `Consola Garita (${req.user?.role || 'security'})`;
  const { qr_token } = req.body || {};

  try {
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
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        p.specialty AS provider_specialty,
        p.status AS compliance_status,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        pv.vehicle_type,
        pv.brand,
        pv.model,
        pv.color,
        pv.plate
      FROM access_passes ap
      JOIN providers p ON ap.provider_id = p.id
      JOIN users u_prov ON p.user_id = u_prov.id
      JOIN users u_owner ON ap.owner_id = u_owner.id
      LEFT JOIN provider_vehicles pv ON pv.provider_id = p.id
      WHERE ap.qr_token = $1
      LIMIT 1
    `;

    const result = await db.query(query, [String(qr_token).trim()]);

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

    // Consumo atómico de ingreso único: cambia de 'pending' a 'used'
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

    return res.status(200).json({
      authorized: true,
      code: 'ACCESS_GRANTED',
      message: grantedMsg,
      details: {
        pass_id: passInfo.pass_id,
        status: 'used',
        provider_name: `${passInfo.provider_first_name} ${passInfo.provider_last_name}`,
        provider_dni: passInfo.provider_dni,
        specialty: passInfo.provider_specialty,
        authorized_by: `${passInfo.owner_first_name} ${passInfo.owner_last_name}`,
        fraction_number: passInfo.fraction_number,
        lot_number: passInfo.lot_number,
        start_time: passInfo.start_time,
        end_time: passInfo.end_time,
        vehicle:
          passInfo.brand || passInfo.plate
            ? {
                vehicle_type: passInfo.vehicle_type,
                brand: passInfo.brand,
                model: passInfo.model,
                color: passInfo.color,
                plate: passInfo.plate,
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

module.exports = {
  getProviderSchedule,
  createScheduleBlock,
  deleteScheduleBlock,
  createVisitCoordination,
  listMyVisitRequests,
  listProviderVisitRequests,
  addVisitRequestMessage,
  respondVisitRequest,
  createPass,
  getMyPasses,
  listProviderPasses,
  updatePass,
  cancelPass,
  verifyPassByQR,
};