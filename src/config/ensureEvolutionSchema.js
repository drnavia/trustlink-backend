/**
 * @file evolutionSchema.js
 * @description Helper idempotente para asegurar las columnas y tablas evolutivas de TrustLink:
 * - Ubicación residencial normalizada en `users` (location_area_type, fraction_number, lot_number).
 * - Capacidades duales y portal principal configurable (resident_enabled, provider_enabled, primary_portal).
 * - Tabla `owner_reviews` para reseñas de prestadores hacia residentes/propietarios.
 * @location /trustlink-backend/src/config/evolutionSchema.js
 */

const db = require('./db');

let schemaInitialized = false;

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
 * Limpia un valor para que conserve únicamente dígitos (o cadena limpia si aplica).
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
 * - Si el rol es 'provider' => 'provider'
 * - En caso contrario (owner, family, resident, admin, superadmin, security) => 'resident'
 * @param {string} role
 * @returns {'resident'|'provider'}
 */
function getDefaultPrimaryPortal(role) {
  return String(role || '').toLowerCase() === 'provider' ? 'provider' : 'resident';
}

/**
 * Ejecuta de forma idempotente las migraciones evolutivas de Fase 1.
 */
async function ensureEvolutionSchema() {
  if (schemaInitialized) return;

  try {
    // 1. Columnas de ubicación estructurada y portal principal en `users`
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS location_area_type VARCHAR(20) DEFAULT 'na',
      ADD COLUMN IF NOT EXISTS resident_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS provider_enabled BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS primary_portal VARCHAR(20) DEFAULT 'resident'
    `);

    // 2. Sincronizar valores iniciales coherentes según role existente
    await db.query(`
      UPDATE users
      SET
        provider_enabled = CASE
          WHEN LOWER(COALESCE(role::text, '')) IN ('provider', 'superadmin') THEN TRUE
          ELSE COALESCE(provider_enabled, FALSE)
        END,
        resident_enabled = CASE
          WHEN LOWER(COALESCE(role::text, '')) IN ('owner', 'family', 'resident', 'superadmin') THEN TRUE
          ELSE COALESCE(resident_enabled, TRUE)
        END,
        primary_portal = CASE
          WHEN primary_portal IS NOT NULL AND primary_portal IN ('resident', 'provider') THEN primary_portal
          WHEN LOWER(COALESCE(role::text, '')) = 'provider' THEN 'provider'
          ELSE 'resident'
        END,
        location_area_type = CASE
          WHEN location_area_type IN ('manzana', 'fraccion', 'na') THEN location_area_type
          WHEN fraction_number IS NOT NULL AND BTRIM(fraction_number::text) <> ''
               AND UPPER(BTRIM(fraction_number::text)) NOT IN ('N/A', 'NA', 'NO APLICA', '-') THEN 'fraccion'
          ELSE 'na'
        END
    `);

    // 3. Asegurar tabla owner_reviews para calificación cruzada Prestador -> Residente
    await db.query(`
      CREATE TABLE IF NOT EXISTS owner_reviews (
        id SERIAL PRIMARY KEY,
        contract_id INTEGER,
        provider_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    schemaInitialized = true;
  } catch (err) {
    console.error('Error asegurando esquema evolutivo de Fase 1:', err.message);
    throw err;
  }
}

module.exports = {
  ensureEvolutionSchema,
  normalizeAreaType,
  cleanNumberOnly,
  getDefaultPrimaryPortal,
};