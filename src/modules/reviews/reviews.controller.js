/**
 * @file reviews.controller.js
 * @description Controlador para calificación cruzada bidireccional (Residente <-> Prestador)
 * sobre contratos de servicio en TrustLink, con recálculo de rating_avg en providers.
 * @location /trustlink-backend/src/modules/reviews/reviews.controller.js
 */

const db = require('../../config/db');

/**
 * Asegura la existencia de la tabla owner_reviews de forma idempotente
 * para registrar las calificaciones emitidas por prestadores hacia residentes/propietarios.
 */
const ensureOwnerReviewsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS owner_reviews (
      id SERIAL PRIMARY KEY,
      contract_id INTEGER NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE UNIQUE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Lista contratos del usuario autenticado (residente/propietario o prestador)
 * junto con el estado de reseñas cruzadas (reseña a prestador y reseña a residente).
 */
const getContractsForReviews = async (req, res) => {
  try {
    await ensureOwnerReviewsTable();

    const userId = req.user.userId;
    const role = req.user.role;
    const requestedPortal = String(req.query?.portal || '').trim().toLowerCase();
    const useProviderView =
      requestedPortal === 'provider' || (requestedPortal !== 'resident' && role === 'provider');

    if (useProviderView) {
      const result = await db.query(
        `SELECT
          sc.id AS contract_id,
          sc.country_id,
          sc.owner_id,
          sc.provider_id,
          sc.pass_id,
          sc.description,
          sc.agreed_amount,
          sc.status AS contract_status,
          sc.created_at,
          c.name AS country_name,
          u_owner.first_name AS owner_first_name,
          u_owner.last_name AS owner_last_name,
          u_owner.email AS owner_email,
          p.specialty,
          p.rating_avg AS provider_rating_avg,
          u_prov.first_name AS provider_first_name,
          u_prov.last_name AS provider_last_name,
          t.id AS transaction_id,
          t.status AS payment_status,
          t.provider_payout,
          pr.rating AS provider_review_rating,
          pr.comment AS provider_review_comment,
          pr.created_at AS provider_review_created_at,
          orr.id AS owner_review_id,
          orr.rating AS owner_review_rating,
          orr.comment AS owner_review_comment,
          orr.created_at AS owner_review_created_at
         FROM service_contracts sc
         INNER JOIN providers p ON p.id = sc.provider_id
         LEFT JOIN countries c ON c.id = sc.country_id
         LEFT JOIN users u_owner ON u_owner.id = sc.owner_id
         LEFT JOIN users u_prov ON u_prov.id = p.user_id
         LEFT JOIN LATERAL (
           SELECT id, status, provider_payout
           FROM transactions
           WHERE contract_id = sc.id
           ORDER BY id DESC
           LIMIT 1
         ) t ON TRUE
         LEFT JOIN provider_reviews pr ON pr.contract_id = sc.id
         LEFT JOIN owner_reviews orr ON orr.contract_id = sc.id
         WHERE p.user_id = $1
         ORDER BY sc.id DESC`,
        [userId]
      );

      return res.status(200).json({
        portal: 'provider',
        role: 'provider',
        contracts: result.rows
      });
    }

    const result = await db.query(
      `SELECT
        sc.id AS contract_id,
        sc.country_id,
        sc.owner_id,
        sc.provider_id,
        sc.pass_id,
        sc.description,
        sc.agreed_amount,
        sc.status AS contract_status,
        sc.created_at,
        c.name AS country_name,
        u_owner.first_name AS owner_first_name,
        u_owner.last_name AS owner_last_name,
        p.specialty,
        p.rating_avg AS provider_rating_avg,
        u_prov.first_name AS provider_first_name,
        u_prov.last_name AS provider_last_name,
        t.id AS transaction_id,
        t.status AS payment_status,
        t.provider_payout,
        pr.id AS provider_review_id,
        pr.rating AS provider_review_rating,
        pr.comment AS provider_review_comment,
        pr.created_at AS provider_review_created_at,
        orr.rating AS owner_review_rating,
        orr.comment AS owner_review_comment,
        orr.created_at AS owner_review_created_at
       FROM service_contracts sc
       LEFT JOIN countries c ON c.id = sc.country_id
       LEFT JOIN users u_owner ON u_owner.id = sc.owner_id
       LEFT JOIN providers p ON p.id = sc.provider_id
       LEFT JOIN users u_prov ON u_prov.id = p.user_id
       LEFT JOIN LATERAL (
         SELECT id, status, provider_payout
         FROM transactions
         WHERE contract_id = sc.id
         ORDER BY id DESC
         LIMIT 1
       ) t ON TRUE
       LEFT JOIN provider_reviews pr ON pr.contract_id = sc.id
       LEFT JOIN owner_reviews orr ON orr.contract_id = sc.id
       WHERE sc.owner_id = $1
       ORDER BY sc.id DESC`,
      [userId]
    );

    return res.status(200).json({
      portal: 'resident',
      role: requestedPortal === 'resident' ? 'owner' : role || 'owner',
      contracts: result.rows
    });
  } catch (error) {
    console.error('Error al consultar contratos para reseñas cruzadas:', error);
    return res.status(500).json({
      error: 'Error interno al obtener los contratos y reseñas.'
    });
  }
};

/**
 * Permite a un residente/propietario ('owner' o 'family') calificar al prestador
 * de un contrato asociado, marca el contrato como completado si estaba pendiente
 * y recalcula rating_avg en la tabla providers.
 */
const createProviderReview = async (req, res) => {
  try {
    const ownerId = req.user.userId;
    const contractId = parseInt(req.body.contract_id, 10);
    const rating = parseInt(req.body.rating, 10);
    const comment = req.body.comment !== undefined && req.body.comment !== null
      ? String(req.body.comment).trim()
      : null;

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un contract_id válido.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'La calificación debe ser un número entero de 1 a 5.' });
    }

    const contractRes = await db.query(
      `SELECT id, owner_id, provider_id, status
       FROM service_contracts
       WHERE id = $1`,
      [contractId]
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }

    const contract = contractRes.rows[0];
    if (Number(contract.owner_id) !== Number(ownerId)) {
      return res.status(403).json({ error: 'No tiene permisos para calificar este contrato.' });
    }

    const insertRes = await db.query(
      `INSERT INTO provider_reviews (contract_id, provider_id, owner_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, contract_id, provider_id, owner_id, rating, comment, created_at`,
      [contractId, contract.provider_id, ownerId, rating, comment || null]
    );

    if (contract.status !== 'completed') {
      await db.query(
        `UPDATE service_contracts
         SET status = 'completed'::contract_status
         WHERE id = $1`,
        [contractId]
      );
    }

    const avgRes = await db.query(
      `SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS new_avg
       FROM provider_reviews
       WHERE provider_id = $1`,
      [contract.provider_id]
    );
    const newAverage = avgRes.rows[0]?.new_avg ?? '0.00';

    await db.query(
      'UPDATE providers SET rating_avg = $1 WHERE id = $2',
      [newAverage, contract.provider_id]
    );

    return res.status(201).json({
      message: 'Reseña al prestador registrada y reputación actualizada.',
      review: insertRes.rows[0],
      updated_provider_rating: newAverage
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Ya emitiste una reseña para este contrato.' });
    }
    console.error('Error al registrar reseña al prestador:', error);
    return res.status(500).json({ error: 'Error interno al guardar la reseña.' });
  }
};

/**
 * Permite a un prestador ('provider') calificar la experiencia con el residente/propietario
 * de un contrato asignado a su perfil.
 */
const createOwnerReview = async (req, res) => {
  try {
    await ensureOwnerReviewsTable();

    const userId = req.user.userId;
    const contractId = parseInt(req.body.contract_id, 10);
    const rating = parseInt(req.body.rating, 10);
    const comment = req.body.comment !== undefined && req.body.comment !== null
      ? String(req.body.comment).trim()
      : null;

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un contract_id válido.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'La calificación debe ser un número entero de 1 a 5.' });
    }

    const contractRes = await db.query(
      `SELECT sc.id, sc.owner_id, sc.provider_id, p.user_id AS provider_user_id
       FROM service_contracts sc
       INNER JOIN providers p ON p.id = sc.provider_id
       WHERE sc.id = $1`,
      [contractId]
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }

    const contract = contractRes.rows[0];
    if (Number(contract.provider_user_id) !== Number(userId)) {
      return res.status(403).json({ error: 'No tiene permisos para calificar este contrato.' });
    }

    const insertRes = await db.query(
      `INSERT INTO owner_reviews (contract_id, provider_id, owner_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, contract_id, provider_id, owner_id, rating, comment, created_at`,
      [contractId, contract.provider_id, contract.owner_id, rating, comment || null]
    );

    return res.status(201).json({
      message: 'Calificación cruzada al residente registrada correctamente.',
      review: insertRes.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Ya emitiste una calificación para este contrato.' });
    }
    console.error('Error al registrar reseña al residente:', error);
    return res.status(500).json({ error: 'Error interno al guardar la calificación.' });
  }
};

/**
 * Consulta reseñas recibidas por un prestador específico.
 */
const getProviderReviewsById = async (req, res) => {
  try {
    const providerId = parseInt(req.params.providerId, 10);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: 'ID de prestador inválido.' });
    }

    const reviewsRes = await db.query(
      `SELECT
        pr.id,
        pr.contract_id,
        pr.rating,
        pr.comment,
        pr.created_at,
        u.first_name AS owner_first_name,
        u.last_name AS owner_last_name
       FROM provider_reviews pr
       LEFT JOIN users u ON u.id = pr.owner_id
       WHERE pr.provider_id = $1
       ORDER BY pr.id DESC`,
      [providerId]
    );

    return res.status(200).json({
      provider_id: providerId,
      count: reviewsRes.rows.length,
      reviews: reviewsRes.rows
    });
  } catch (error) {
    console.error('Error al consultar reseñas del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar reseñas.' });
  }
};

module.exports = {
  getContractsForReviews,
  createProviderReview,
  createOwnerReview,
  getProviderReviewsById
};