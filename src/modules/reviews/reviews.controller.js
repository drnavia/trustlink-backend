/**
 * @file reviews.controller.js
 * @description Controlador para calificación cruzada bidireccional (Residente <-> Prestador)
 * sobre contratos de servicio en TrustLink, con recálculo de rating_avg en providers.
 * @location /trustlink-backend/src/modules/reviews/reviews.controller.js
 */

const db = require('../../config/db');
const { ensureEvolutionSchema } = require('../../config/ensureEvolutionSchema');
const {
  REVIEW_MICRO_TAGS,
  normalizeReviewTags,
} = require('../../utils/providerReputation');

/**
 * Asegura la existencia de la tabla `owner_reviews` de forma idempotente para registrar
 * las calificaciones emitidas por prestadores hacia residentes/propietarios.
 * Garantiza una única calificación por contrato (`UNIQUE` en `contract_id`) y puntaje entero entre 1 y 5.
 *
 * @returns {Promise<void>}
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
 * Lista los contratos del usuario autenticado (según vista de portal Residente o Prestador)
 * junto con su última transacción de pago y el estado de ambas reseñas cruzadas
 * (`provider_reviews` y `owner_reviews`).
 * GET /api/v1/reviews/contracts
 *
 * @param {import('express').Request} req - Petición HTTP con sesión JWT y query opcional `?portal=resident|provider`.
 * @param {import('express').Response} res - Respuesta HTTP con `{ portal, role, contracts }`.
 * @returns {Promise<import('express').Response>}
 */
const getContractsForReviews = async (req, res) => {
  try {
    // 1. Asegurar esquema evolutivo (incluye `provider_reviews.tags`) y tabla de reseñas a propietarios
    await ensureEvolutionSchema();
    await ensureOwnerReviewsTable();

    const userId = req.user.userId;
    const role = req.user.role;
    const requestedPortal = String(req.query?.portal || '').trim().toLowerCase();
    const useProviderView =
      requestedPortal === 'provider' || (requestedPortal !== 'resident' && role === 'provider');

    // 2. Rama Portal Prestador: obtiene contratos asignados al perfil `providers.user_id = $1`,
    //    su última transacción mediante `LEFT JOIN LATERAL` y las reseñas en ambos sentidos
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
          COALESCE(pr.tags, '[]'::jsonb) AS provider_review_tags,
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

    // 3. Rama Portal Residente: obtiene contratos contratados por `sc.owner_id = $1`
    //    con última transacción (`LEFT JOIN LATERAL`) y estado de reseña emitida/recibida
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
        COALESCE(pr.tags, '[]'::jsonb) AS provider_review_tags,
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
      available_tags: REVIEW_MICRO_TAGS,
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
 * Permite a un residente/propietario (`owner` o `family`) calificar al prestador
 * de un contrato asociado, marca automáticamente el contrato como `'completed'` si aún
 * estaba abierto y recalcula el promedio histórico `rating_avg` en `providers`.
 * POST /api/v1/reviews/provider
 *
 * @param {import('express').Request} req - Petición HTTP con `{ contract_id, rating, comment? }`.
 * @param {import('express').Response} res - Respuesta HTTP `201` con la reseña y el nuevo promedio.
 * @returns {Promise<import('express').Response>}
 */
const createProviderReview = async (req, res) => {
  try {
    // 1. Asegurar columna `tags` y validar contrato, puntaje entero (1..5), micro-tags y comentario opcional
    await ensureEvolutionSchema();
    const ownerId = req.user.userId;
    const contractId = parseInt(req.body.contract_id, 10);
    const rating = parseInt(req.body.rating, 10);
    const comment = req.body.comment !== undefined && req.body.comment !== null
      ? String(req.body.comment).trim()
      : null;
    const normalizedTags = normalizeReviewTags(req.body.tags);

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un contract_id válido.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'La calificación debe ser un número entero de 1 a 5.' });
    }

    // 2. Verificar existencia del contrato, su prestador (`user_id`) y que el usuario autenticado sea el contratante
    const contractRes = await db.query(
      `SELECT sc.id, sc.owner_id, sc.provider_id, sc.status, p.user_id AS provider_user_id
       FROM service_contracts sc
       JOIN providers p ON p.id = sc.provider_id
       WHERE sc.id = $1`,
      [contractId]
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }

    const contract = contractRes.rows[0];
    if (Number(contract.owner_id) !== Number(ownerId)) {
      return res.status(403).json({ error: 'No tiene permisos para calificar este contrato.' });
    }

    // 3. Persistir la calificación y sus micro-tags en `provider_reviews` (UNIQUE previene duplicados)
    const insertRes = await db.query(
      `INSERT INTO provider_reviews (contract_id, provider_id, owner_id, rating, comment, tags)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, contract_id, provider_id, owner_id, rating, comment, COALESCE(tags, '[]'::jsonb) AS tags, created_at`,
      [contractId, contract.provider_id, ownerId, rating, comment || null, JSON.stringify(normalizedTags)]
    );

    // 4. Transicionar el contrato a estado `'completed'` si aún figuraba pendiente/en curso
    if (contract.status !== 'completed') {
      await db.query(
        `UPDATE service_contracts
         SET status = 'completed'::contract_status
         WHERE id = $1`,
        [contractId]
      );
    }

    // 5. Recalcular el promedio consolidado a nivel persona (`user_id`) y sincronizar `providers.rating_avg` en todos sus rubros
    const avgRes = await db.query(
      `SELECT COALESCE(ROUND(AVG(pr.rating)::numeric, 2), 0)::numeric(3,2) AS new_avg
       FROM provider_reviews pr
       JOIN providers p ON p.id = pr.provider_id
       WHERE p.user_id = $1`,
      [contract.provider_user_id]
    );
    const newAverage = avgRes.rows[0]?.new_avg ?? '0.00';

    await db.query(
      'UPDATE providers SET rating_avg = $1 WHERE user_id = $2',
      [newAverage, contract.provider_user_id]
    );

    return res.status(201).json({
      message: 'Reseña al prestador registrada y reputación actualizada.',
      review: insertRes.rows[0],
      updated_provider_rating: newAverage
    });
  } catch (error) {
    // Código PostgreSQL 23505 = violación de restricción UNIQUE (contrato ya calificado)
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Ya emitiste una reseña para este contrato.' });
    }
    console.error('Error al registrar reseña al prestador:', error);
    return res.status(500).json({ error: 'Error interno al guardar la reseña.' });
  }
};

/**
 * Permite a un prestador (`provider`) calificar la experiencia con el residente/propietario
 * de un contrato asignado a su perfil, registrando la reseña cruzada en `owner_reviews`.
 * POST /api/v1/reviews/owner
 *
 * @param {import('express').Request} req - Petición HTTP con `{ contract_id, rating, comment? }`.
 * @param {import('express').Response} res - Respuesta HTTP `201` con la calificación creada.
 * @returns {Promise<import('express').Response>}
 */
const createOwnerReview = async (req, res) => {
  try {
    // 1. Asegurar tabla `owner_reviews` y validar contrato y puntaje entero (1..5)
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

    // 2. Consultar contrato cruzando con `providers` para verificar propiedad del prestador autenticado
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

    // 3. Persistir la calificación hacia el residente en `owner_reviews`
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
    // Código PostgreSQL 23505 = violación de UNIQUE en `contract_id` (ya fue calificado)
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Ya emitiste una calificación para este contrato.' });
    }
    console.error('Error al registrar reseña al residente:', error);
    return res.status(500).json({ error: 'Error interno al guardar la calificación.' });
  }
};

/**
 * Consulta todas las reseñas públicas consolidadas a nivel persona (`user_id`) de un prestador
 * a partir de cualquiera de sus `providerId`, enriquecidas con el rubro (`specialty`) del trabajo
 * calificado y el nombre del residente emisor, ordenadas de más reciente a más antigua.
 * GET /api/v1/reviews/provider/:providerId
 *
 * @param {import('express').Request} req - Petición HTTP con `:providerId` en params.
 * @param {import('express').Response} res - Respuesta HTTP con `{ provider_id, provider_user_id, specialties, count, reviews }`.
 * @returns {Promise<import('express').Response>}
 */
const getProviderReviewsById = async (req, res) => {
  try {
    // 1. Asegurar columna `tags` y validar que `providerId` sea un entero positivo
    await ensureEvolutionSchema();
    const providerId = parseInt(req.params.providerId, 10);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: 'ID de prestador inválido.' });
    }

    // 2. Resolver la persona (`user_id`) dueña de ese perfil para consolidar reseñas de todos sus rubros
    const ownerLookup = await db.query(
      'SELECT user_id FROM providers WHERE id = $1 LIMIT 1',
      [providerId]
    );
    const providerUserId = ownerLookup.rows[0]?.user_id ? Number(ownerLookup.rows[0].user_id) : null;

    if (!providerUserId) {
      return res.status(200).json({
        provider_id: providerId,
        provider_user_id: null,
        specialties: [],
        count: 0,
        reviews: [],
      });
    }

    // 3. Consultar todas las reseñas de la persona incluyendo el rubro (`specialty`) de cada trabajo
    const reviewsRes = await db.query(
      `SELECT
        pr.id,
        pr.contract_id,
        pr.provider_id,
        p.specialty,
        sc.description AS service_description,
        pr.rating,
        pr.comment,
        COALESCE(pr.tags, '[]'::jsonb) AS tags,
        pr.created_at,
        u.first_name AS owner_first_name,
        u.last_name AS owner_last_name
       FROM provider_reviews pr
       JOIN providers p ON p.id = pr.provider_id
       LEFT JOIN service_contracts sc ON sc.id = pr.contract_id
       LEFT JOIN users u ON u.id = pr.owner_id
       WHERE p.user_id = $1
       ORDER BY pr.id DESC`,
      [providerUserId]
    );

    const specialties = Array.from(
      new Set(
        reviewsRes.rows
          .map((row) => String(row.specialty || '').trim())
          .filter(Boolean)
      )
    );

    return res.status(200).json({
      provider_id: providerId,
      provider_user_id: providerUserId,
      specialties,
      count: reviewsRes.rows.length,
      reviews: reviewsRes.rows,
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