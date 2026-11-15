/**
 * @file reviews.controller.js
 * @description Lógica de negocio para la gestión de contratos de servicios y calificaciones
 * cruzadas (reputación basada en transacciones reales).
 * @location /trustlink-backend/src/modules/reviews/reviews.controller.js
 */

const db = require('../../config/db');

/**
 * Crea un contrato de servicio entre un residente y un prestador verificado.
 * Roles permitidos: 'owner', 'family'
 */
const createContract = async (req, res) => {
  try {
    const owner_id = req.user.userId;
    const country_id = req.user.countryId;
    const { provider_id, pass_id, description, agreed_amount } = req.body;

    if (!provider_id || !description || !agreed_amount) {
      return res.status(400).json({ error: 'Faltan datos obligatorios para registrar el contrato.' });
    }

    const query = `
      INSERT INTO service_contracts (country_id, owner_id, provider_id, pass_id, description, agreed_amount, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING id, description, agreed_amount, status, created_at;
    `;

    const values = [country_id, owner_id, provider_id, pass_id || null, description, agreed_amount];
    const newContract = await db.query(query, values);

    return res.status(201).json({
      message: 'Contrato de servicio registrado con éxito.',
      contract: newContract.rows[0]
    });

  } catch (error) {
    console.error('Error al crear contrato:', error);
    return res.status(500).json({ error: 'Error interno del servidor al registrar el contrato.' });
  }
};

/**
 * Actualiza el estado de un contrato a 'completed' para habilitar la calificación.
 * Roles permitidos: 'owner', 'admin', 'superadmin'
 */
const completeContract = async (req, res) => {
  try {
    const { contract_id } = req.body;

    const query = `
      UPDATE service_contracts 
      SET status = 'completed' 
      WHERE id = $1 
      RETURNING id, provider_id, owner_id, status;
    `;

    const result = await db.query(query, [contract_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }

    return res.status(200).json({
      message: 'El servicio ha sido marcado como completado.',
      contract: result.rows[0]
    });

  } catch (error) {
    console.error('Error al completar contrato:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

/**
 * Emite una calificación y reseña para un prestador basándose en un contrato completado.
 * Roles permitidos: 'owner', 'family'
 */
const createReview = async (req, res) => {
  try {
    const owner_id = req.user.userId;
    const { contract_id, rating, comment } = req.body;

    if (!contract_id || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Datos inválidos. El rating debe ser un valor entero entre 1 y 5.' });
    }

    // 1. Verificar que el contrato exista, pertenezca al usuario y esté en estado 'completed'
    const contractCheck = await db.query(
      'SELECT * FROM service_contracts WHERE id = $1 AND owner_id = $2',
      [contract_id, owner_id]
    );

    if (contractCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado o no autorizado para calificar.' });
    }

    const contract = contractCheck.rows[0];

    if (contract.status !== 'completed') {
      return res.status(400).json({ error: 'No se puede calificar un servicio que aún no ha sido marcado como completado.' });
    }

    // 2. Insertar la reseña
    const insertReviewQuery = `
      INSERT INTO provider_reviews (contract_id, provider_id, owner_id, rating, comment)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, rating, comment, created_at;
    `;

    const reviewRes = await db.query(insertReviewQuery, [
      contract_id, 
      contract.provider_id, 
      owner_id, 
      rating, 
      comment || null
    ]);

    // 3. Recalcular y actualizar el rating promedio (rating_avg) del prestador
    const avgQuery = `
      SELECT AVG(rating)::numeric(3,2) AS new_avg 
      FROM provider_reviews 
      WHERE provider_id = $1;
    `;
    const avgResult = await db.query(avgQuery, [contract.provider_id]);
    const newAverage = avgResult.rows[0].new_avg;

    await db.query(
      'UPDATE providers SET rating_avg = $1 WHERE id = $2',
      [newAverage, contract.provider_id]
    );

    return res.status(201).json({
      message: 'Calificación registrada exitosamente. Reputación del prestador actualizada.',
      review: reviewRes.rows[0],
      updated_provider_rating: newAverage
    });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una reseña emitida para este contrato.' });
    }
    console.error('Error al registrar reseña:', error);
    return res.status(500).json({ error: 'Error interno del servidor al guardar la calificación.' });
  }
};

module.exports = {
  createContract,
  completeContract,
  createReview
};