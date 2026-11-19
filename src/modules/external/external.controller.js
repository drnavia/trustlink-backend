/**
 * @file external.controller.js
 * @description Endpoint de integración para aplicaciones y sistemas de garita de barrios privados.
 * Valida tokens QR emitidos por TrustLink y devuelve información estructurada del pase,
 * prestador, compliance y vehículo.
 * @location /trustlink-backend/src/modules/external/external.controller.js
 */

const db = require('../../config/db');

/**
 * Valida un token QR para sistemas externos de barrios privados.
 * Soporta autenticación por API Key de integración (x-api-key) o Bearer JWT (admin, superadmin, security).
 */
const verifyExternalPassByQR = async (req, res) => {
  try {
    const { qr_token, country_id: bodyCountryId } = req.body;
    const apiKeyHeader = req.headers['x-api-key'];
    const configuredApiKey = process.env.EXTERNAL_GATE_API_KEY;

    if (!qr_token) {
      return res.status(400).json({
        authorized: false,
        code: 'MISSING_QR_TOKEN',
        error: 'Debe proporcionar el campo qr_token en el cuerpo de la solicitud.'
      });
    }

    // Validar autenticación externa por API Key si no viene un req.user autenticado por JWT
    let scopedCountryId = req.user?.countryId || bodyCountryId || null;

    if (!req.user) {
      if (!configuredApiKey) {
        return res.status(503).json({
          authorized: false,
          code: 'EXTERNAL_API_NOT_CONFIGURED',
          error: 'La integración externa no tiene configurada EXTERNAL_GATE_API_KEY en el servidor.'
        });
      }

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

    const result = await db.query(query, [qr_token.trim()]);

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
  verifyExternalPassByQR
};