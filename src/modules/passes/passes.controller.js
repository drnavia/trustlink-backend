/**
 * @file passes.controller.js
 * @description Lógica de negocio completa para la gestión, emisión de pases QR por parte de los residentes
 * y validación en tiempo real en los puestos de control perimetral (garitas).
 * @location /trustlink-backend/src/modules/passes/passes.controller.js
 */

const db = require('../../config/db');
const crypto = require('crypto');

/**
 * Genera un nuevo pase de acceso con un token QR único cifrado.
 * Roles permitidos: 'owner', 'family'
 */
const createPass = async (req, res) => {
  try {
    const { provider_id, fraction_number, lot_number, start_time, end_time } = req.body;
    const owner_id = req.user.userId;     // ID del usuario autenticado (extraído del token JWT)
    const country_id = req.user.countryId; // Country del usuario residente

    if (!provider_id || !start_time || !end_time) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (provider_id, start_time, end_time).' });
    }

    // 1. Generar un token criptográfico único para el código QR
    const qr_token = crypto.randomBytes(32).toString('hex');

    // 2. Insertar el pase en la base de datos
    const query = `
      INSERT INTO access_passes (country_id, owner_id, provider_id, fraction_number, lot_number, qr_token, start_time, end_time, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id, qr_token, start_time, end_time, status, created_at;
    `;

    const values = [
      country_id,
      owner_id,
      provider_id,
      fraction_number || null,
      lot_number || null,
      qr_token,
      start_time,
      end_time
    ];

    const newPass = await db.query(query, values);

    return res.status(201).json({
      message: 'Pase de acceso generado exitosamente.',
      pass: newPass.rows[0]
    });

  } catch (error) {
    console.error('Error al generar el pase de acceso:', error);
    return res.status(500).json({ error: 'Error interno del servidor al crear el pase.' });
  }
};

/**
 * Valida un pase de acceso en la garita mediante el token QR.
 * Roles permitidos: 'security', 'admin', 'superadmin'
 */
const verifyPassByQR = async (req, res) => {
  try {
    const { qr_token } = req.body;
    const securityCountryId = req.user.countryId; // Country del guardia que realiza la consulta

    if (!qr_token) {
      return res.status(400).json({ error: 'Debe proporcionar el token QR para la validación.' });
    }

    // 1. Buscar el pase en la base de datos junto con los datos del prestador y del vehículo
    const query = `
      SELECT 
        ap.id AS pass_id,
        ap.status AS pass_status,
        ap.start_time,
        ap.end_time,
        ap.country_id,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        u_prov.dni AS provider_dni,
        p.status AS provider_compliance_status,
        pv.brand, pv.model, pv.color, pv.plate,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        ap.fraction_number,
        ap.lot_number
      FROM access_passes ap
      JOIN providers p ON ap.provider_id = p.id
      JOIN users u_prov ON p.user_id = u_prov.id
      JOIN users u_owner ON ap.owner_id = u_owner.id
      LEFT JOIN provider_vehicles pv ON pv.provider_id = p.id
      WHERE ap.qr_token = $1;
    `;

    const result = await db.query(query, [qr_token]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        authorized: false, 
        error: 'Pase QR inválido o inexistente.' 
      });
    }

    const passInfo = result.rows[0];

    // 2. Validar que el pase pertenezca al mismo country donde opera el guardia
    if (securityCountryId && passInfo.country_id !== securityCountryId) {
      return res.status(403).json({ 
        authorized: false, 
        error: 'Este pase pertenece a otra comunidad / barrio privado.' 
      });
    }

    // 3. Validar estado del prestador (Compliance)
    if (passInfo.provider_compliance_status !== 'approved') {
      return res.status(403).json({ 
        authorized: false, 
        error: 'Acceso denegado: El prestador no tiene su documentación de Compliance aprobada.' 
      });
    }

    // 4. Validar vigencia de las fechas del pase
    const now = new Date();
    const startTime = new Date(passInfo.start_time);
    const endTime = new Date(passInfo.end_time);

    if (now < startTime || now > endTime) {
      return res.status(400).json({ 
        authorized: false, 
        error: 'El pase se encuentra fuera de la franja horaria autorizada.',
        valid_from: passInfo.start_time,
        valid_to: passInfo.end_time
      });
    }

    // 5. Validar estado del pase
    if (passInfo.pass_status === 'cancelled' || passInfo.pass_status === 'expired') {
      return res.status(400).json({ 
        authorized: false, 
        error: `El pase se encuentra ${passInfo.pass_status}.` 
      });
    }

    // Si todo es correcto, autorizamos el ingreso
    return res.status(200).json({
      authorized: true,
      message: 'Acceso autorizado con éxito.',
      details: {
        provider: `${passInfo.provider_first_name} ${passInfo.provider_last_name}`,
        dni: passInfo.provider_dni,
        vehicle: `${passInfo.brand} ${passInfo.model} (${passInfo.color}) - Patente: ${passInfo.plate}`,
        destination: `Fracción: ${passInfo.fraction_number || 'N/A'} - Lote: ${passInfo.lot_number || 'N/A'}`,
        authorized_by: `${passInfo.owner_first_name} ${passInfo.owner_last_name}`
      }
    });

  } catch (error) {
    console.error('Error al validar el pase en garita:', error);
    return res.status(500).json({ error: 'Error interno del servidor al validar el acceso.' });
  }
};

module.exports = {
  createPass,
  verifyPassByQR
};