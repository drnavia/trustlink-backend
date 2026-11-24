/**
 * @file ensureEvolutionSchema.js
 * @description Helper idempotente para asegurar las columnas y tablas evolutivas de TrustLink:
 * - Ubicación residencial normalizada en `users` (fraction_type, fraction_number, lot_number).
 * - Capacidades duales y portal principal configurable (can_use_resident, can_use_provider, primary_portal).
 * - Tabla `owner_reviews` para reseñas de prestadores hacia residentes/propietarios.
 * @location /trustlink-backend/src/config/ensureEvolutionSchema.js
 */

const db = require('./db');

let schemaInitialized = false;
let schemaPromise = null;

/**
 * Normaliza el tipo de área de manzana/fracción ('manzana' | 'fraccion' | 'na').
 * @param {string|null|undefined} rawType
 * @returns {'manzana'|'fraccion'|'na'}
 */
function normalizeAreaType(rawType) {
  if (!rawType) return 'na';
  const normalized = String(rawType).trim().toLowerCase();
  if (normalized === 'manzana' || normalized === 'mz') return 'manzana';
  if (normalized === 'fraccion' || normalized === 'fracción' || normalized === 'fr') {
    return 'fraccion';
  }
  return 'na';
}

/**
 * Limpia un valor para que conserve únicamente dígitos (o null si no hay dígitos).
 * @param {string|number|null|undefined} rawValue
 * @returns {string|null}
 */
function cleanNumberOnly(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const digits = String(rawValue).replace(/\D+/g, '').trim();
  return digits.length > 0 ? digits : null;
}

/**
 * Determina el portal principal por defecto según el rol del usuario.
 * @param {string} role
 * @returns {'resident'|'provider'}
 */
function getDefaultPrimaryPortal(role) {
  return String(role || '').toLowerCase() === 'provider' ? 'provider' : 'resident';
}

/**
 * Ejecuta de forma idempotente las migraciones evolutivas de Fase 1
 * alineadas con account.controller.js, passes.controller.js y script-schema.sql.txt.
 */
async function ensureEvolutionSchema() {
  if (schemaInitialized) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      // 1. Columnas de ubicación estructurada, capacidades duales y portal principal en `users`
      await db.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS fraction_type VARCHAR(20) NOT NULL DEFAULT 'na',
        ADD COLUMN IF NOT EXISTS can_use_resident BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS can_use_provider BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS primary_portal VARCHAR(20) NOT NULL DEFAULT 'resident',
        ADD COLUMN IF NOT EXISTS portals_configured BOOLEAN NOT NULL DEFAULT FALSE
      `);

      // 2. Backfill único solo para cuentas legacy que aún no tienen portals_configured = TRUE.
      // Respeta futuras ediciones manuales desde Mi Cuenta (ej. ex-prestador que pasa a ser solo residente).
      await db.query(`
        UPDATE users u
        SET
          can_use_provider = CASE
            WHEN LOWER(COALESCE(u.role::text, '')) IN ('provider', 'superadmin') THEN TRUE
            ELSE COALESCE(u.can_use_provider, FALSE)
          END,
          can_use_resident = CASE
            WHEN LOWER(COALESCE(u.role::text, '')) IN ('owner', 'family', 'resident', 'superadmin') THEN TRUE
            WHEN LOWER(COALESCE(u.role::text, '')) = 'provider' THEN (
              u.lot_number IS NOT NULL AND BTRIM(u.lot_number::text) <> ''
            )
            ELSE FALSE
          END,
          primary_portal = CASE
            WHEN LOWER(COALESCE(u.role::text, '')) = 'provider' THEN 'provider'
            WHEN u.primary_portal IN ('resident', 'provider') THEN u.primary_portal
            ELSE 'resident'
          END,
          fraction_type = CASE
            WHEN u.fraction_type IN ('manzana', 'fraccion') THEN u.fraction_type
            WHEN u.fraction_number IS NOT NULL AND BTRIM(u.fraction_number::text) <> ''
                 AND UPPER(BTRIM(u.fraction_number::text)) NOT IN ('N/A', 'NA', 'NO APLICA', '-') THEN
              CASE
                WHEN LOWER(BTRIM(u.fraction_number::text)) LIKE 'manzana%' OR LOWER(BTRIM(u.fraction_number::text)) LIKE 'mz%' THEN 'manzana'
                ELSE 'fraccion'
              END
            ELSE 'na'
          END,
          portals_configured = TRUE
        WHERE COALESCE(u.portals_configured, FALSE) = FALSE
      `);

      // 3. Asegurar tabla owner_reviews para calificación cruzada Prestador -> Residente
      await db.query(`
        CREATE TABLE IF NOT EXISTS owner_reviews (
          id SERIAL PRIMARY KEY,
          contract_id INTEGER NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE UNIQUE,
          provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment TEXT NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);

      // 4. Asegurar tabla provider_subscriptions para membresía "Socio Verificado"
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
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_provider_subscriptions_user_status
        ON public.provider_subscriptions (user_id, status, ends_at DESC)
      `);

      // 5. Asegurar columnas de licenciamiento B2B en `countries`
      await db.query(`
        ALTER TABLE public.countries
        ADD COLUMN IF NOT EXISTS plan_code VARCHAR(40) NOT NULL DEFAULT 'pilot',
        ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMP WITHOUT TIME ZONE NULL,
        ADD COLUMN IF NOT EXISTS monthly_pass_quota INTEGER NULL
      `);

      // 6. Asegurar columnas de Mercado Pago Checkout Pro en `transactions`
      await db.query(`
        ALTER TABLE public.transactions
        ADD COLUMN IF NOT EXISTS preference_id VARCHAR(255) NULL,
        ADD COLUMN IF NOT EXISTS checkout_url TEXT NULL,
        ADD COLUMN IF NOT EXISTS gateway_mode VARCHAR(30) NOT NULL DEFAULT 'mock',
        ADD COLUMN IF NOT EXISTS gateway_raw_status VARCHAR(60) NULL,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      `);

      schemaInitialized = true;
    } catch (err) {
      schemaPromise = null;
      console.error('Error asegurando esquema evolutivo de Fase 1:', err.message);
      throw err;
    }
  })();

  return schemaPromise;
}

module.exports = {
  ensureEvolutionSchema,
  normalizeAreaType,
  cleanNumberOnly,
  getDefaultPrimaryPortal,
};