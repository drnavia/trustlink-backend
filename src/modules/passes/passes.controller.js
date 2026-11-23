/**
 * @file passes.controller.js
 * @description Controlador para coordinación previa de visitas, emisión de pases QR,
 * consulta (residente y prestador), edición, cancelación y validación perimetral.
 * @location /trustlink-backend/src/modules/passes/passes.controller.js
 */

const crypto = require('crypto');
const db = require('../../config/db');

const ensureVisitRequestsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS visit_requests (
      id SERIAL PRIMARY KEY,
      country_id INTEGER NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      fraction_number VARCHAR(100) NULL,
      lot_number VARCHAR(100) NULL,
      preferred_date VARCHAR(50) NULL,
      notes TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'coordinated',
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

const expireOverduePasses = async () => {
  await db.query(
    `UPDATE access_passes
     SET status = 'expired'::pass_status
     WHERE status = 'pending'::pass_status
       AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`
  );
};

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
 * Registra la coordinación/solicitud de visita dentro de TrustLink antes de emitir el QR.
 * POST /api/v1/passes/visit-requests
 */
const createVisitCoordination = async (req, res) => {
  try {
    await ensureVisitRequestsTable();
    const ownerId = req.user.userId;
    const countryId = req.user.countryId || null;
    const {
      provider_id,
      fraction_number,
      lot_number,
      preferred_date,
      notes,
    } = req.body;

    if (!provider_id || !notes || !String(notes).trim()) {
      return res.status(400).json({
        error: 'Indicá el prestador y el detalle/mensaje de coordinación de la visita.',
      });
    }

    const providerCheck = await db.query(
      'SELECT id, country_id FROM providers WHERE id = $1 LIMIT 1',
      [Number(provider_id)]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
    }

    const effectiveCountryId = countryId || providerCheck.rows[0].country_id || null;

    const inserted = await db.query(
      `INSERT INTO visit_requests (
         country_id, owner_id, provider_id, fraction_number, lot_number, preferred_date, notes, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'coordinated')
       RETURNING *`,
      [
        effectiveCountryId,
        ownerId,
        Number(provider_id),
        fraction_number ? String(fraction_number).trim() : null,
        lot_number ? String(lot_number).trim() : null,
        preferred_date ? String(preferred_date).trim() : null,
        String(notes).trim(),
      ]
    );

    return res.status(201).json({
      message: 'Visita coordinada en TrustLink. Ya podés emitir el Pase QR correspondiente.',
      visit: inserted.rows[0],
    });
  } catch (error) {
    console.error('Error al registrar coordinación de visita:', error);
    return res.status(500).json({ error: 'Error interno al registrar la visita.' });
  }
};

const createPass = async (req, res) => {
  try {
    const ownerId = req.user.userId;
    const countryId = req.user.countryId || null;
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
      'SELECT id, country_id FROM providers WHERE id = $1 LIMIT 1',
      [Number(provider_id)]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El prestador seleccionado no existe.' });
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
          fraction_number ? String(fraction_number).trim() : null,
          lot_number ? String(lot_number).trim() : null,
          vehicle_plate ? String(vehicle_plate).trim().toUpperCase() : null,
          qrToken,
          start_time,
          end_time,
        ]
      : [
          effectiveCountryId,
          ownerId,
          Number(provider_id),
          fraction_number ? String(fraction_number).trim() : null,
          lot_number ? String(lot_number).trim() : null,
          qrToken,
          start_time,
          end_time,
        ];

    const created = await db.query(insertSql, params);

    return res.status(201).json({
      message: 'Pase QR emitido correctamente.',
      pass: created.rows[0],
    });
  } catch (error) {
    console.error('Error al emitir pase QR:', error);
    return res.status(500).json({ error: 'Error interno al emitir el pase QR.' });
  }
};

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

const updatePass = async (req, res) => {
  try {
    await expireOverduePasses();
    const passId = Number(req.params.id);
    const ownerId = req.user.userId;

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
    if (Number(currentPass.owner_id) !== Number(ownerId)) {
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
    const supportsPlate = await hasVehiclePlateColumn();

    const updateSql = supportsPlate
      ? `UPDATE access_passes
         SET fraction_number = COALESCE($1, fraction_number),
             lot_number = COALESCE($2, lot_number),
             vehicle_plate = $3,
             start_time = COALESCE($4, start_time),
             end_time = COALESCE($5, end_time)
         WHERE id = $6
         RETURNING *`
      : `UPDATE access_passes
         SET fraction_number = COALESCE($1, fraction_number),
             lot_number = COALESCE($2, lot_number),
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
          fraction_number !== undefined ? String(fraction_number).trim() || null : null,
          lot_number !== undefined ? String(lot_number).trim() || null : null,
          normalizedPlate,
          start_time || null,
          end_time || null,
          passId,
        ]
      : [
          fraction_number !== undefined ? String(fraction_number).trim() || null : null,
          lot_number !== undefined ? String(lot_number).trim() || null : null,
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

    return res.status(200).json({
      message: `Pase QR #${passId} cancelado correctamente.`,
      pass: updated.rows[0],
    });
  } catch (error) {
    console.error('Error al cancelar pase QR:', error);
    return res.status(500).json({ error: 'Error interno al cancelar el pase QR.' });
  }
};

const verifyPassByQR = async (req, res) => {
  try {
    await expireOverduePasses();
    const { qr_token } = req.body;

    if (!qr_token || !String(qr_token).trim()) {
      return res.status(400).json({
        authorized: false,
        error: 'Debe proporcionar el token QR para validar el acceso.',
      });
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
      return res.status(404).json({
        authorized: false,
        error: 'Pase QR inválido o inexistente.',
      });
    }

    const passInfo = result.rows[0];

    if (passInfo.compliance_status !== 'approved') {
      return res.status(403).json({
        authorized: false,
        error: `El prestador no posee compliance aprobado (estado: ${passInfo.compliance_status}).`,
      });
    }

    if (passInfo.pass_status !== 'pending') {
      return res.status(400).json({
        authorized: false,
        error: `El pase se encuentra en estado ${passInfo.pass_status}.`,
      });
    }

    const startMs = Number(passInfo.start_utc_ms);
    const endMs = Number(passInfo.end_utc_ms);
    const nowMs = Number(passInfo.now_utc_ms);

    if (nowMs < startMs || nowMs > endMs) {
      return res.status(400).json({
        authorized: false,
        error: 'El pase se encuentra fuera de la franja horaria autorizada.',
      });
    }

    return res.status(200).json({
      authorized: true,
      message: 'Acceso autorizado.',
      details: {
        pass_id: passInfo.pass_id,
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
      error: 'Error interno del servidor al validar el acceso.',
    });
  }
};

module.exports = {
  createVisitCoordination,
  createPass,
  getMyPasses,
  listProviderPasses,
  updatePass,
  cancelPass,
  verifyPassByQR,
};