/**
 * @file passes.controller.js
 * @description Lógica de negocio para emisión de pases QR por residentes, consulta del historial
 * propio del residente, cancelación segura de pases y validación perimetral en garita.
 * @location /trustlink-backend/src/modules/passes/passes.controller.js
 */

const db = require('../../config/db');
const crypto = require('crypto');

/**
 * Persiste en PostgreSQL el estado 'expired'::pass_status para pases en estado 'pending'
 * cuya end_time (almacenada en UTC sin zona horaria) ya superó el instante actual (NOW()).
 * @param {number|null} passId
 * @param {number|null} ownerId
 */
const expireOverduePasses = async (passId = null, ownerId = null) => {
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

    if (ownerId !== null && ownerId !== undefined) {
      await db.query(
        `
          UPDATE access_passes
          SET status = 'expired'::pass_status
          WHERE owner_id = $1
            AND status = 'pending'::pass_status
            AND end_time IS NOT NULL
            AND (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
        `,
        [ownerId]
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

/**
 * Genera un nuevo pase de acceso con un token QR único cifrado.
 * Roles permitidos: 'owner', 'family'
 */
const createPass = async (req, res) => {
  try {
    const {
      provider_id,
      country_id: bodyCountryId,
      fraction,
      lot_number,
      fraction_number,
      start_time,
      end_time
    } = req.body;

    const owner_id = req.user.userId;
    const country_id = bodyCountryId || req.user.countryId || 1;
    const finalFraction = (fraction_number || fraction || '').trim() || null;
    const finalLot = String(lot_number || '').trim() || null;

    if (!provider_id || !start_time || !end_time) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios (provider_id, start_time, end_time).'
      });
    }

    const startDate = new Date(start_time);
    const endDate = new Date(end_time);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({
        error: 'Las fechas de inicio y fin no tienen un formato válido.'
      });
    }

    if (endDate <= startDate) {
      return res.status(400).json({
        error: 'La fecha/hora de fin debe ser posterior a la de inicio.'
      });
    }

    const qr_token = crypto.randomBytes(32).toString('hex');

    const query = `
      INSERT INTO access_passes (
        country_id,
        owner_id,
        provider_id,
        fraction_number,
        lot_number,
        qr_token,
        start_time,
        end_time,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, 'pending'::pass_status)
      RETURNING
        id,
        country_id,
        owner_id,
        provider_id,
        fraction_number,
        lot_number,
        qr_token,
        start_time,
        end_time,
        (EXTRACT(EPOCH FROM (start_time AT TIME ZONE 'UTC')) * 1000)::bigint AS start_utc_ms,
        (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
        status,
        created_at;
    `;

    const values = [
      country_id,
      owner_id,
      provider_id,
      finalFraction,
      finalLot,
      qr_token,
      startDate.toISOString(),
      endDate.toISOString()
    ];

    const newPass = await db.query(query, values);

    return res.status(201).json({
      message: 'Pase de acceso generado exitosamente.',
      pass: newPass.rows[0]
    });
  } catch (error) {
    console.error('Error al generar el pase de acceso:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al crear el pase.'
    });
  }
};

/**
 * Lista los pases QR emitidos por el residente/propietario autenticado.
 * Roles permitidos: 'owner', 'family'
 */
const listMyPasses = async (req, res) => {
  try {
    const ownerId = req.user.userId;
    await expireOverduePasses(null, ownerId);

    const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
    const searchFilter = String(req.query.search || '').trim();

    const conditions = ['ap.owner_id = $1'];
    const params = [ownerId];

    if (['pending', 'used', 'expired', 'cancelled'].includes(statusFilter)) {
      params.push(statusFilter);
      conditions.push(`ap.status = $${params.length}::pass_status`);
    }

    if (searchFilter) {
      params.push(`%${searchFilter}%`);
      const idx = params.length;
      conditions.push(
        `(ap.qr_token ILIKE $${idx} OR COALESCE(u_prov.first_name, '') ILIKE $${idx} OR COALESCE(u_prov.last_name, '') ILIKE $${idx} OR COALESCE(p.specialty, '') ILIKE $${idx} OR COALESCE(ap.fraction_number, '') ILIKE $${idx} OR COALESCE(ap.lot_number, '') ILIKE $${idx})`
      );
    }

    const query = `
      SELECT
        ap.id,
        ap.country_id,
        c.name AS country_name,
        ap.owner_id,
        ap.provider_id,
        TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
        p.specialty,
        p.status AS compliance_status,
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
      LEFT JOIN countries c ON ap.country_id = c.id
      LEFT JOIN providers p ON ap.provider_id = p.id
      LEFT JOIN users u_prov ON p.user_id = u_prov.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ap.id DESC
      LIMIT 50;
    `;

    const result = await db.query(query, params);

    return res.status(200).json({
      count: result.rows.length,
      passes: result.rows
    });
  } catch (error) {
    console.error('Error al listar pases del residente:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al consultar tus pases QR.'
    });
  }
};

/**
 * Cancela un pase QR pendiente emitido por el residente autenticado (o admin/superadmin).
 */
const cancelPass = async (req, res) => {
  try {
    const passId = parseInt(req.params.id, 10);
    if (!Number.isInteger(passId) || passId <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    await expireOverduePasses(passId, null);

    const passRes = await db.query(
      'SELECT id, owner_id, status, qr_token FROM access_passes WHERE id = $1',
      [passId]
    );
    if (passRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    const passRow = passRes.rows[0];
    const isPrivileged = ['admin', 'superadmin'].includes(req.user?.role);
    if (!isPrivileged && Number(passRow.owner_id) !== Number(req.user?.userId)) {
      return res.status(403).json({ error: 'No tenés permiso para cancelar este pase QR.' });
    }

    if (passRow.status !== 'pending') {
      return res.status(400).json({
        error: `No se puede cancelar un pase en estado '${passRow.status}'.`
      });
    }

    const updated = await db.query(
      `
        UPDATE access_passes
        SET status = 'cancelled'::pass_status
        WHERE id = $1
        RETURNING id, qr_token, status, start_time, end_time
      `,
      [passId]
    );

    return res.status(200).json({
      message: `Pase QR #${passId} cancelado correctamente.`,
      pass: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al cancelar pase QR:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al cancelar el pase QR.'
    });
  }
};

/**
 * Valida un pase de acceso en la garita mediante el token QR.
 * Roles permitidos: 'security', 'admin', 'superadmin'
 */
const verifyPassByQR = async (req, res) => {
  try {
    const { qr_token } = req.body;
    const securityCountryId = req.user.countryId;

    if (!qr_token) {
      return res.status(400).json({
        authorized: false,
        error: 'Debe proporcionar el token QR para la validación.'
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
        ap.country_id,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        p.status AS provider_compliance_status,
        pv.brand,
        pv.model,
        pv.color,
        pv.plate,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        ap.fraction_number,
        ap.lot_number
      FROM access_passes ap
      JOIN providers p ON ap.provider_id = p.id
      JOIN users u_prov ON p.user_id = u_prov.id
      JOIN users u_owner ON ap.owner_id = u_owner.id
      LEFT JOIN provider_vehicles pv ON pv.provider_id = p.id
      WHERE ap.qr_token = $1
      LIMIT 1;
    `;

    const result = await db.query(query, [qr_token]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        authorized: false,
        error: 'Pase QR inválido o inexistente.'
      });
    }

    let passInfo = result.rows[0];

    const parsedStartMs =
      passInfo.start_utc_ms !== null && passInfo.start_utc_ms !== undefined
        ? Number(passInfo.start_utc_ms)
        : new Date(passInfo.start_time).getTime();
    const parsedEndMs =
      passInfo.end_utc_ms !== null && passInfo.end_utc_ms !== undefined
        ? Number(passInfo.end_utc_ms)
        : new Date(passInfo.end_time).getTime();
    const nowMs =
      passInfo.now_utc_ms !== null && passInfo.now_utc_ms !== undefined
        ? Number(passInfo.now_utc_ms)
        : Date.now();

    if (
      passInfo.pass_status === 'pending' &&
      !Number.isNaN(parsedEndMs) &&
      nowMs > parsedEndMs
    ) {
      await expireOverduePasses(passInfo.pass_id, null);
      passInfo = { ...passInfo, pass_status: 'expired' };
    }

    if (
      securityCountryId &&
      passInfo.country_id &&
      Number(passInfo.country_id) !== Number(securityCountryId)
    ) {
      return res.status(403).json({
        authorized: false,
        error: 'Este pase pertenece a otra comunidad / barrio privado.'
      });
    }

    if (passInfo.provider_compliance_status !== 'approved') {
      return res.status(403).json({
        authorized: false,
        error: `El prestador no cuenta con compliance aprobado (estado actual: ${passInfo.provider_compliance_status}).`
      });
    }

    if (passInfo.pass_status === 'cancelled' || passInfo.pass_status === 'expired') {
      return res.status(400).json({
        authorized: false,
        error: `El pase se encuentra ${passInfo.pass_status}.`
      });
    }

    if (
      (!Number.isNaN(parsedStartMs) && nowMs < parsedStartMs) ||
      (!Number.isNaN(parsedEndMs) && nowMs > parsedEndMs)
    ) {
      return res.status(400).json({
        authorized: false,
        error: 'El pase se encuentra fuera de la franja horaria autorizada.',
        valid_from: new Date(parsedStartMs).toISOString(),
        valid_to: new Date(parsedEndMs).toISOString()
      });
    }

    return res.status(200).json({
      authorized: true,
      message: 'Acceso autorizado con éxito.',
      details: {
        provider_first_name: passInfo.provider_first_name,
        provider_last_name: passInfo.provider_last_name,
        provider_dni: passInfo.provider_dni,
        brand: passInfo.brand,
        model: passInfo.model,
        color: passInfo.color,
        plate: passInfo.plate,
        fraction_number: passInfo.fraction_number,
        lot_number: passInfo.lot_number,
        authorized_by: `${passInfo.owner_first_name} ${passInfo.owner_last_name}`
      }
    });
  } catch (error) {
    console.error('Error al validar el pase en garita:', error);
    return res.status(500).json({
      authorized: false,
      error: 'Error interno del servidor al validar el acceso.'
    });
  }
};

module.exports = {
  createPass,
  listMyPasses,
  cancelPass,
  verifyPassByQR
};