/**
 * @file passes.controller.js
 * @description Lógica de negocio completa para la emisión, consulta, edición de pases QR
 * vigentes por residentes (incluyendo patente del vehículo en `access_passes`)
 * y validación perimetral en tiempo real en la garita.
 * @location /trustlink-backend/src/modules/passes/passes.controller.js
 */

const db = require('../../config/db');
const crypto = require('crypto');

/**
 * Asegura de forma idempotente que `access_passes` cuente con la columna `vehicle_plate`
 * para persistir tanto el alta como la edición de vehículo en pases vigentes.
 */
const ensureVehiclePlateColumn = async () => {
  await db.query(`
    ALTER TABLE public.access_passes
    ADD COLUMN IF NOT EXISTS vehicle_plate VARCHAR(20) NULL;
  `);
};

/**
 * Marca como 'expired' en PostgreSQL los pases 'pending' cuya franja end_time ya venció.
 */
const expireOverduePasses = async () => {
  await db.query(`
    UPDATE public.access_passes
    SET status = 'expired'::public.pass_status
    WHERE status = 'pending'::public.pass_status
      AND (end_time AT TIME ZONE 'UTC') < NOW();
  `);
};

/**
 * Genera un nuevo pase de acceso con un token QR único cifrado y patente opcional.
 * Roles permitidos: 'owner', 'family'
 */
const createPass = async (req, res) => {
  try {
    await ensureVehiclePlateColumn();

    const {
      provider_id,
      fraction_number,
      lot_number,
      vehicle_plate,
      start_time,
      end_time
    } = req.body;
    const owner_id = req.user.userId;
    const country_id = req.user.countryId;

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
    const cleanPlate = vehicle_plate ? String(vehicle_plate).trim().toUpperCase() : null;

    const query = `
      INSERT INTO public.access_passes (
        country_id,
        owner_id,
        provider_id,
        fraction_number,
        lot_number,
        vehicle_plate,
        qr_token,
        start_time,
        end_time,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9::timestamp, 'pending')
      RETURNING
        id,
        qr_token,
        fraction_number,
        lot_number,
        vehicle_plate,
        start_time,
        end_time,
        status::text AS status,
        created_at;
    `;

    const values = [
      country_id,
      owner_id,
      provider_id,
      fraction_number || null,
      lot_number || null,
      cleanPlate,
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
 * Lista los pases QR emitidos por el residente/familia logueado.
 * Sincroniza previamente los pases vencidos a estado 'expired'.
 */
const getMyPasses = async (req, res) => {
  try {
    await ensureVehiclePlateColumn();
    await expireOverduePasses();

    const ownerId = req.user.userId;

    const query = `
      SELECT
        ap.id,
        ap.country_id,
        ap.owner_id,
        ap.provider_id,
        ap.fraction_number,
        ap.lot_number,
        ap.vehicle_plate,
        ap.qr_token,
        ap.start_time,
        ap.end_time,
        ap.status::text AS status,
        ap.created_at,
        TRIM(CONCAT(COALESCE(u_prov.first_name, ''), ' ', COALESCE(u_prov.last_name, ''))) AS provider_name,
        p.specialty AS provider_specialty
      FROM public.access_passes ap
      LEFT JOIN public.providers p ON p.id = ap.provider_id
      LEFT JOIN public.users u_prov ON u_prov.id = p.user_id
      WHERE ap.owner_id = $1
      ORDER BY ap.id DESC;
    `;

    const result = await db.query(query, [ownerId]);
    return res.status(200).json({
      count: result.rows.length,
      passes: result.rows
    });
  } catch (error) {
    console.error('Error al consultar pases del residente:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al consultar los pases QR.'
    });
  }
};

/**
 * Permite al residente/familia editar un pase QR que esté realmente VIGENTE
 * (estado 'pending' y end_time en el futuro), incluyendo `vehicle_plate`.
 * Bloquea pases 'expired', 'cancelled' o 'used'.
 */
const updatePass = async (req, res) => {
  try {
    await ensureVehiclePlateColumn();
    await expireOverduePasses();

    const passId = parseInt(req.params.id, 10);
    const ownerId = req.user.userId;
    const { fraction_number, lot_number, vehicle_plate, start_time, end_time } = req.body;

    if (!Number.isInteger(passId) || passId <= 0) {
      return res.status(400).json({ error: 'ID de pase inválido.' });
    }

    const existingRes = await db.query(
      `
        SELECT
          id,
          owner_id,
          status::text AS status,
          start_time,
          end_time,
          (EXTRACT(EPOCH FROM (end_time AT TIME ZONE 'UTC')) * 1000)::bigint AS end_utc_ms,
          (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_utc_ms
        FROM public.access_passes
        WHERE id = $1
        LIMIT 1;
      `,
      [passId]
    );

    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pase QR no encontrado.' });
    }

    const currentPass = existingRes.rows[0];
    if (Number(currentPass.owner_id) !== Number(ownerId) && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'No autorizado para editar este pase QR.' });
    }

    const currentStatus = String(currentPass.status || '').toLowerCase();
    const isExpiredByTime =
      currentPass.end_utc_ms !== null &&
      currentPass.now_utc_ms !== null &&
      Number(currentPass.end_utc_ms) < Number(currentPass.now_utc_ms);

    if (currentStatus !== 'pending' || isExpiredByTime) {
      return res.status(400).json({
        error:
          'Solo se pueden editar pases QR vigentes (no cancelados, vencidos ni utilizados).'
      });
    }

    const nextStartDate = start_time ? new Date(start_time) : new Date(currentPass.start_time);
    const nextEndDate = end_time ? new Date(end_time) : new Date(currentPass.end_time);

    if (Number.isNaN(nextStartDate.getTime()) || Number.isNaN(nextEndDate.getTime())) {
      return res.status(400).json({ error: 'Formato de fecha/hora inválido.' });
    }

    if (nextEndDate <= nextStartDate) {
      return res.status(400).json({
        error: 'La fecha/hora de fin debe ser posterior a la de inicio.'
      });
    }

    const cleanPlate =
      vehicle_plate !== undefined && vehicle_plate !== null && String(vehicle_plate).trim()
        ? String(vehicle_plate).trim().toUpperCase()
        : null;

    const updateQuery = `
      UPDATE public.access_passes
      SET fraction_number = COALESCE($1, fraction_number),
          lot_number = COALESCE($2, lot_number),
          vehicle_plate = $3,
          start_time = $4::timestamp,
          end_time = $5::timestamp
      WHERE id = $6
      RETURNING
        id,
        qr_token,
        fraction_number,
        lot_number,
        vehicle_plate,
        start_time,
        end_time,
        status::text AS status;
    `;

    const values = [
      fraction_number !== undefined ? String(fraction_number).trim() || null : null,
      lot_number !== undefined ? String(lot_number).trim() || null : null,
      cleanPlate,
      nextStartDate.toISOString(),
      nextEndDate.toISOString(),
      passId
    ];

    const updated = await db.query(updateQuery, values);

    return res.status(200).json({
      message: `Pase #${passId} actualizado correctamente.`,
      pass: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar pase QR vigente:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al actualizar el pase QR.'
    });
  }
};

/**
 * Valida un pase de acceso en la garita mediante el token QR.
 * Prioriza `ap.vehicle_plate` si fue asignada en el pase y cae en `pv.plate` si no.
 * Roles permitidos: 'security', 'admin', 'superadmin'
 */
const verifyPassByQR = async (req, res) => {
  try {
    await ensureVehiclePlateColumn();
    await expireOverduePasses();

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
        ap.status::text AS pass_status,
        ap.start_time,
        ap.end_time,
        ap.country_id,
        ap.vehicle_plate AS pass_vehicle_plate,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        p.status::text AS provider_compliance_status,
        pv.brand,
        pv.model,
        pv.color,
        COALESCE(ap.vehicle_plate, pv.plate) AS plate,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        ap.fraction_number,
        ap.lot_number
      FROM public.access_passes ap
      JOIN public.providers p ON ap.provider_id = p.id
      JOIN public.users u_prov ON p.user_id = u_prov.id
      JOIN public.users u_owner ON ap.owner_id = u_owner.id
      LEFT JOIN public.provider_vehicles pv
        ON pv.provider_id = p.id
       AND (ap.vehicle_plate IS NULL OR UPPER(pv.plate) = UPPER(ap.vehicle_plate))
      WHERE ap.qr_token = $1
      ORDER BY pv.id DESC NULLS LAST
      LIMIT 1;
    `;

    const result = await db.query(query, [qr_token]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        authorized: false,
        error: 'Pase QR inválido o inexistente.'
      });
    }

    const passInfo = result.rows[0];

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

    if (
      passInfo.pass_status === 'cancelled' ||
      passInfo.pass_status === 'expired' ||
      passInfo.pass_status === 'used'
    ) {
      return res.status(400).json({
        authorized: false,
        error: `El pase se encuentra ${passInfo.pass_status}.`
      });
    }

    const startMs = new Date(`${String(passInfo.start_time).replace(' ', 'T')}Z`).getTime();
    const endMs = new Date(`${String(passInfo.end_time).replace(' ', 'T')}Z`).getTime();
    const nowMs = Date.now();

    const parsedStartMs = Number.isNaN(startMs)
      ? new Date(passInfo.start_time).getTime()
      : startMs;
    const parsedEndMs = Number.isNaN(endMs) ? new Date(passInfo.end_time).getTime() : endMs;

    if (nowMs < parsedStartMs || nowMs > parsedEndMs) {
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
  getMyPasses,
  updatePass,
  verifyPassByQR
};