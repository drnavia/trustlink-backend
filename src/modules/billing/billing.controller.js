/**
 * @file billing.controller.js
 * @description Gestión de la membresía "Socio Verificado" (suscripción B2C para prestadores).
 * Permite consultar el estado y catálogo de planes, activar/renovar suscripción desde Portal Prestador
 * y administrar altas, extensiones o bajas desde Operaciones / Superadmin.
 * @location /trustlink-backend/src/modules/billing/billing.controller.js
 */

const db = require('../../config/db');
const { ensureEvolutionSchema } = require('../../config/ensureEvolutionSchema');

// Catálogo oficial de planes B2C "Socio Verificado" disponibles para prestadores (duración, precio en ARS y beneficios)
const MEMBERSHIP_PLANS = [
  {
    code: 'verified_monthly',
    name: 'Socio Verificado Mensual',
    duration_days: 30,
    price_ars: 14900,
    badge_label: 'Socio Verificado',
    features: [
      'Insignia distintiva "Socio Verificado" en el directorio',
      'Posicionamiento prioritario sobre perfiles estándar',
      'Pases QR ilimitados y reputación acumulable en toda la red',
    ],
  },
  {
    code: 'verified_quarterly',
    name: 'Socio Verificado Trimestral',
    duration_days: 90,
    price_ars: 39900,
    badge_label: 'Socio Verificado',
    features: [
      '90 días continuos de visibilidad prioritaria (ahorro 11%)',
      'Insignia distintiva "Socio Verificado" en el directorio',
      'Soporte prioritario en validación documental Ops',
    ],
  },
  {
    code: 'verified_pro',
    name: 'Socio Verificado Pro (Cuadrillas)',
    duration_days: 30,
    price_ars: 24900,
    badge_label: 'Socio Verificado Pro',
    features: [
      'Prioridad destacada superior en búsquedas del directorio',
      'Gestión ampliada de cuadrillas/ayudantes y flota vehicular',
      'Alertas proactivas de vencimiento documental',
    ],
  },
];

// Índice en memoria para búsqueda O(1) de metadatos de plan por `code`
const PLANS_BY_CODE = Object.fromEntries(MEMBERSHIP_PLANS.map((p) => [p.code, p]));

/**
 * Asegura de forma idempotente el esquema evolutivo base y la tabla `public.provider_subscriptions`.
 * Registra cada período de suscripción (plan, vigencia `starts_at`/`ends_at`, estado,
 * identificador externo para futura integración con pasarela de pagos y notas operativas).
 *
 * @returns {Promise<void>}
 */
const ensureProviderSubscriptionsTable = async () => {
  await ensureEvolutionSchema();
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.provider_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      plan_code VARCHAR(40) NOT NULL DEFAULT 'verified_monthly',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      starts_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      external_subscription_id VARCHAR(160) NULL,
      auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT NULL,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Formatea una fila de `provider_subscriptions` en un snapshot de membresía consistente.
 * Evalúa si la suscripción está realmente vigente comparando `ends_at > Date.now()`,
 * degrada el estado efectivo a `'expired'` cuando una suscripción `active`/`trialing` ya venció
 * y calcula los días restantes y la insignia correspondiente al plan.
 *
 * @param {Record<string, any>|null} row - Fila proveniente de `provider_subscriptions` o `null`.
 * @returns {Record<string, any>} Snapshot normalizado de la membresía.
 */
function formatMembershipSnapshot(row) {
  // Si el prestador nunca tuvo suscripciones, devolver snapshot vacío consistente
  if (!row) {
    return {
      is_verified_member: false,
      plan_code: null,
      plan_name: null,
      badge_label: null,
      status: 'none',
      starts_at: null,
      ends_at: null,
      days_remaining: 0,
      auto_renew: false,
      notes: null,
    };
  }

  // Calcular vigencia real contra reloj actual y determinar días restantes redondeados hacia arriba
  const nowMs = Date.now();
  const endsAtMs = row.ends_at ? new Date(row.ends_at).getTime() : 0;
  const rawStatus = String(row.status || '').toLowerCase();
  const isCurrentlyActive =
    (rawStatus === 'active' || rawStatus === 'trialing') && endsAtMs > nowMs;
  const effectiveStatus =
    (rawStatus === 'active' || rawStatus === 'trialing') && endsAtMs <= nowMs
      ? 'expired'
      : rawStatus || 'none';
  const daysRemaining = isCurrentlyActive
    ? Math.max(0, Math.ceil((endsAtMs - nowMs) / (1000 * 60 * 60 * 24)))
    : 0;
  const planMeta = PLANS_BY_CODE[row.plan_code] || null;

  return {
    id: row.id,
    is_verified_member: isCurrentlyActive,
    plan_code: row.plan_code || null,
    plan_name: planMeta?.name || row.plan_code || 'Socio Verificado',
    badge_label: isCurrentlyActive
      ? planMeta?.badge_label || 'Socio Verificado'
      : null,
    status: effectiveStatus,
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    days_remaining: daysRemaining,
    auto_renew: Boolean(row.auto_renew),
    notes: row.notes || null,
  };
}

/**
 * Devuelve la membresía vigente (o, en su defecto, la más reciente del historial)
 * de un usuario prestador, ya formateada con `formatMembershipSnapshot`.
 *
 * @param {number|string} userId - Identificador del usuario prestador en `users`.
 * @returns {Promise<Record<string, any>>} Snapshot de membresía del prestador.
 */
const getActiveMembershipForUser = async (userId) => {
  await ensureProviderSubscriptionsTable();
  // Prioriza registros activos/en prueba cuya fecha `ends_at` sea futura; si no hay, toma el último histórico
  const res = await db.query(
    `SELECT
       id, user_id, plan_code, status, starts_at, ends_at,
       external_subscription_id, auto_renew, notes, created_at, updated_at
     FROM public.provider_subscriptions
     WHERE user_id = $1
     ORDER BY
       CASE WHEN status IN ('active', 'trialing') AND ends_at > NOW() THEN 0 ELSE 1 END ASC,
       ends_at DESC,
       id DESC
     LIMIT 1`,
    [Number(userId)]
  );
  return formatMembershipSnapshot(res.rows[0] || null);
};

/**
 * GET /api/v1/billing/provider/me
 * Consulta el estado actual de la membresía "Socio Verificado", el catálogo completo de planes
 * disponibles y el historial de las últimas 10 suscripciones del prestador autenticado.
 *
 * @param {import('express').Request} req - Petición HTTP autenticada del prestador.
 * @param {import('express').Response} res - Respuesta HTTP con `{ membership, plans, history }`.
 * @returns {Promise<import('express').Response>}
 */
const getMyProviderMembership = async (req, res) => {
  try {
    await ensureProviderSubscriptionsTable();
    const userId = Number(req.user.userId);

    // Ejecutar en paralelo el snapshot vigente y el historial reciente (máx. 10 registros)
    const [membership, historyRes] = await Promise.all([
      getActiveMembershipForUser(userId),
      db.query(
        `SELECT id, plan_code, status, starts_at, ends_at, auto_renew, notes, created_at
         FROM public.provider_subscriptions
         WHERE user_id = $1
         ORDER BY id DESC
         LIMIT 10`,
        [userId]
      ),
    ]);

    return res.status(200).json({
      membership,
      plans: MEMBERSHIP_PLANS,
      history: historyRes.rows,
    });
  } catch (error) {
    console.error('Error al consultar membresía del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar la membresía.' });
  }
};

/**
 * POST /api/v1/billing/provider/subscribe
 * Activa o renueva una membresía "Socio Verificado" para el prestador autenticado.
 * Si el prestador ya posee días vigentes, el nuevo período se acumula a partir de `ends_at`
 * para no perder tiempo previamente acreditado.
 * (En piloto/MVP acredita el período inmediatamente y queda listo para conectar Mercado Pago Suscripciones).
 *
 * @param {import('express').Request} req - Petición HTTP con `{ plan_code?, auto_renew? }`.
 * @param {import('express').Response} res - Respuesta HTTP `201` con la membresía activada.
 * @returns {Promise<import('express').Response>}
 */
const subscribeProviderMembership = async (req, res) => {
  try {
    // 1. Asegurar tabla y validar que el `plan_code` solicitado exista en el catálogo
    await ensureProviderSubscriptionsTable();
    const userId = Number(req.user.userId);
    const planCode = String(req.body?.plan_code || 'verified_monthly').trim();
    const autoRenew = req.body?.auto_renew !== undefined ? Boolean(req.body.auto_renew) : true;

    const plan = PLANS_BY_CODE[planCode];
    if (!plan) {
      return res.status(400).json({
        error: `Plan de membresía inválido. Planes válidos: ${Object.keys(PLANS_BY_CODE).join(', ')}.`,
      });
    }

    // 1.5. Regla Eje Comercial v2: Destacado / Membresía exige tener Nivel 3+ (compliance aprobado y documentación vigente)
    const verifiedCheck = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'approved'::provider_status)::int AS approved_count,
         BOOL_OR(criminal_record_expiry IS NOT NULL AND criminal_record_expiry < CURRENT_DATE) AS crim_expired,
         BOOL_OR(insurance_expiry IS NOT NULL AND insurance_expiry < CURRENT_DATE) AS art_expired
       FROM public.providers
       WHERE user_id = $1`,
      [userId]
    );
    const vRow = verifiedCheck.rows[0] || {};
    const hasExpiredPersonalDocs = Boolean(vRow.crim_expired) || Boolean(vRow.art_expired);
    if (Number(vRow.approved_count || 0) === 0 || hasExpiredPersonalDocs) {
      return res.status(403).json({
        error: hasExpiredPersonalDocs
          ? 'Para activar el plan Destacado primero debés renovar tu documentación vencida.'
          : 'Para activar el plan Destacado primero necesitás alcanzar Nivel 3 (Pase QR habilitado: identidad, Seguro AP/ART y Antecedentes aprobados).',
      });
    }

    // 2. Consultar suscripción vigente actual para acumular días desde su fecha de fin (`ends_at`)
    const currentRes = await db.query(
      `SELECT id, ends_at
       FROM public.provider_subscriptions
       WHERE user_id = $1
         AND status IN ('active', 'trialing')
         AND ends_at > NOW()
       ORDER BY ends_at DESC
       LIMIT 1`,
      [userId]
    );

    const now = new Date();
    const baseStart =
      currentRes.rows.length > 0 && new Date(currentRes.rows[0].ends_at) > now
        ? new Date(currentRes.rows[0].ends_at)
        : now;
    const nextEndsAt = new Date(baseStart.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

    // 3. Marcar suscripciones activas previas como reemplazadas (`superseded`) para conservar historial limpio
    await db.query(
      `UPDATE public.provider_subscriptions
       SET status = 'superseded', updated_at = NOW()
       WHERE user_id = $1 AND status IN ('active', 'trialing')`,
      [userId]
    );

    // 4. Insertar nuevo período activo con referencia externa interna y devolver snapshot formateado
    const externalSubId = `TLK-SUB-${userId}-${Date.now()}`;
    const insertRes = await db.query(
      `INSERT INTO public.provider_subscriptions (
         user_id, plan_code, status, starts_at, ends_at,
         external_subscription_id, auto_renew, notes
       )
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        plan.code,
        now.toISOString(),
        nextEndsAt.toISOString(),
        externalSubId,
        autoRenew,
        'Activación autogestionada desde Portal Prestador',
      ]
    );

    const membership = formatMembershipSnapshot(insertRes.rows[0]);

    return res.status(201).json({
      message: `Membresía "${plan.name}" activada correctamente hasta el ${nextEndsAt.toISOString().slice(0, 10)}.`,
      membership,
      subscription: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al suscribir membresía de prestador:', error);
    return res.status(500).json({ error: 'Error interno al activar la membresía.' });
  }
};

/**
 * PATCH /api/v1/billing/provider/:userId
 * Administración centralizada por Superadmin: permite activar, extender o cancelar/revocar
 * la membresía "Socio Verificado" de un prestador específico con duración personalizada (1 a 730 días)
 * y registro de notas de auditoría operativa.
 *
 * @param {import('express').Request} req - Petición HTTP con `:userId` y `{ action?, plan_code?, status?, days?, notes? }`.
 * @param {import('express').Response} res - Respuesta HTTP con el estado actualizado de la membresía.
 * @returns {Promise<import('express').Response>}
 */
const adminManageProviderMembership = async (req, res) => {
  try {
    // 1. Asegurar tabla, validar `userId` numérico positivo y comprobar existencia del usuario
    await ensureProviderSubscriptionsTable();
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'ID de usuario prestador inválido.' });
    }

    const userCheck = await db.query('SELECT id, first_name, last_name FROM users WHERE id = $1 LIMIT 1', [
      targetUserId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario prestador no encontrado.' });
    }

    const action = String(req.body?.action || 'activate').trim().toLowerCase();
    const planCode = String(req.body?.plan_code || 'verified_monthly').trim();
    const requestedStatus = String(req.body?.status || 'active').trim().toLowerCase();
    const rawDays = Number(req.body?.days);
    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    // 2. Rama de cancelación/revocación: desactiva renovación y recorta `ends_at` al instante actual
    if (action === 'cancel' || action === 'revoke') {
      await db.query(
        `UPDATE public.provider_subscriptions
         SET status = 'cancelled',
             auto_renew = FALSE,
             ends_at = LEAST(ends_at, NOW()),
             notes = COALESCE($2, notes),
             updated_at = NOW()
         WHERE user_id = $1 AND status IN ('active', 'trialing')`,
        [targetUserId, notes || 'Membresía revocada por Superadmin']
      );

      const membership = await getActiveMembershipForUser(targetUserId);
      return res.status(200).json({
        message: 'Membresía Socio Verificado cancelada correctamente.',
        membership,
      });
    }

    // 3. Rama de activación/extensión: resolver plan, duración acotada (1..730 días) y estado válido
    const plan = PLANS_BY_CODE[planCode] || PLANS_BY_CODE.verified_monthly;
    const durationDays =
      Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 730
        ? rawDays
        : plan.duration_days;
    const validStatus = ['active', 'trialing'].includes(requestedStatus)
      ? requestedStatus
      : 'active';

    // Consultar suscripción vigente para decidir si se acumula tiempo (`extend`) o se reinicia desde hoy
    const currentRes = await db.query(
      `SELECT id, ends_at
       FROM public.provider_subscriptions
       WHERE user_id = $1
         AND status IN ('active', 'trialing')
         AND ends_at > NOW()
       ORDER BY ends_at DESC
       LIMIT 1`,
      [targetUserId]
    );

    const now = new Date();
    const baseDate =
      action === 'extend' && currentRes.rows.length > 0 && new Date(currentRes.rows[0].ends_at) > now
        ? new Date(currentRes.rows[0].ends_at)
        : now;
    const endsAt = new Date(baseDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // 4. Reemplazar registros activos previos e insertar la nueva suscripción gestionada por Ops
    await db.query(
      `UPDATE public.provider_subscriptions
       SET status = 'superseded', updated_at = NOW()
       WHERE user_id = $1 AND status IN ('active', 'trialing')`,
      [targetUserId]
    );

    const insertRes = await db.query(
      `INSERT INTO public.provider_subscriptions (
         user_id, plan_code, status, starts_at, ends_at,
         external_subscription_id, auto_renew, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
       RETURNING *`,
      [
        targetUserId,
        plan.code,
        validStatus,
        now.toISOString(),
        endsAt.toISOString(),
        `TLK-OPS-${targetUserId}-${Date.now()}`,
        notes || `Gestión Ops Superadmin (${durationDays} días)`,
      ]
    );

    const membership = formatMembershipSnapshot(insertRes.rows[0]);
    return res.status(200).json({
      message: `Membresía Socio Verificado (${plan.name}) actualizada hasta el ${endsAt.toISOString().slice(0, 10)}.`,
      membership,
      subscription: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al administrar membresía desde Superadmin:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la membresía del prestador.' });
  }
};

/**
 * GET /api/v1/billing/providers
 * Devuelve el resumen global de suscripciones "Socio Verificado" (hasta 200 registros)
 * para el panel de Superadmin, ordenando primero los miembros actualmente vigentes.
 *
 * @param {import('express').Request} req - Petición HTTP autenticada de Superadmin.
 * @param {import('express').Response} res - Respuesta HTTP con `{ summary, plans, subscriptions }`.
 * @returns {Promise<import('express').Response>}
 */
const listProviderMembershipsForOps = async (req, res) => {
  try {
    await ensureProviderSubscriptionsTable();
    // Cruza suscripciones con datos de usuario y calcula en SQL si la membresía está vigente hoy
    const result = await db.query(`
      SELECT
        ps.id,
        ps.user_id,
        u.first_name,
        u.last_name,
        u.email,
        ps.plan_code,
        ps.status,
        ps.starts_at,
        ps.ends_at,
        ps.auto_renew,
        ps.notes,
        (ps.status IN ('active', 'trialing') AND ps.ends_at > NOW()) AS is_verified_member
      FROM public.provider_subscriptions ps
      JOIN public.users u ON u.id = ps.user_id
      ORDER BY is_verified_member DESC, ps.ends_at DESC, ps.id DESC
      LIMIT 200
    `);

    // Calcular total de miembros activos sobre el conjunto consultado para KPIs del panel Ops
    const activeCount = result.rows.filter((r) => r.is_verified_member).length;
    return res.status(200).json({
      summary: {
        total_records: result.rows.length,
        active_members: activeCount,
      },
      plans: MEMBERSHIP_PLANS,
      subscriptions: result.rows,
    });
  } catch (error) {
    console.error('Error al listar membresías de prestadores:', error);
    return res.status(500).json({ error: 'Error interno al consultar membresías.' });
  }
};

module.exports = {
  MEMBERSHIP_PLANS,
  ensureProviderSubscriptionsTable,
  formatMembershipSnapshot,
  getActiveMembershipForUser,
  getMyProviderMembership,
  subscribeProviderMembership,
  adminManageProviderMembership,
  listProviderMembershipsForOps,
};
