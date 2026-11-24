/**
 * @file migrate.js
 * @description Runner idempotente y ordenado de migraciones evolutivas para PostgreSQL de TrustLink.
 * Consolida en un único script ejecutable (`npm run migrate`) todas las tablas y columnas
 * evolutivas introducidas tras el esquema base (database/script-schema.sql.txt).
 * @location /trustlink-backend/src/db/migrate.js
 */

require('dotenv').config();
const db = require('../config/db');
const { ensureEvolutionSchema } = require('../config/ensureEvolutionSchema');

const MIGRATIONS = [
  {
    id: '001_countries_address_columns',
    run: async () => {
      await db.query(`
        ALTER TABLE countries
          ADD COLUMN IF NOT EXISTS address VARCHAR(255) NULL,
          ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30) NULL,
          ADD COLUMN IF NOT EXISTS city VARCHAR(120) NULL,
          ADD COLUMN IF NOT EXISTS province VARCHAR(120) NULL;
      `);
    },
  },
  {
    id: '002_providers_expiry_and_document_versions',
    run: async () => {
      await db.query(`
        ALTER TABLE public.providers
          ADD COLUMN IF NOT EXISTS criminal_record_expiry DATE,
          ADD COLUMN IF NOT EXISTS insurance_expiry DATE;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.provider_document_versions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          provider_id INTEGER NULL REFERENCES public.providers(id) ON DELETE SET NULL,
          doc_type VARCHAR(40) NOT NULL CHECK (doc_type IN ('criminal', 'insurance')),
          document_url TEXT NOT NULL,
          valid_from DATE NULL,
          valid_to DATE NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
    },
  },
  {
    id: '003_provider_vehicles_type_and_insurance',
    run: async () => {
      await db.query(`
        ALTER TABLE public.provider_vehicles
          ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(50) DEFAULT 'Automóvil',
          ADD COLUMN IF NOT EXISTS vehicle_insurance_url TEXT NULL,
          ADD COLUMN IF NOT EXISTS vehicle_insurance_from DATE NULL,
          ADD COLUMN IF NOT EXISTS vehicle_insurance_expiry DATE NULL;
      `);
    },
  },
  {
    id: '004_access_passes_vehicle_plate',
    run: async () => {
      await db.query(`
        ALTER TABLE public.access_passes
          ADD COLUMN IF NOT EXISTS vehicle_plate VARCHAR(20) NULL;
      `);
    },
  },
  {
    id: '005_dual_identity_location_and_owner_reviews',
    run: async () => {
      await ensureEvolutionSchema();
    },
  },
  {
    id: '006_visit_requests_and_schedule_blocks',
    run: async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS visit_requests (
          id SERIAL PRIMARY KEY,
          country_id INTEGER NULL,
          owner_id INTEGER NOT NULL,
          provider_id INTEGER NOT NULL,
          fraction_number VARCHAR(100) NULL,
          lot_number VARCHAR(100) NULL,
          preferred_date VARCHAR(50) NULL,
          notes TEXT NULL,
          messages JSONB NOT NULL DEFAULT '[]'::jsonb,
          status VARCHAR(30) NOT NULL DEFAULT 'pending_provider',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS provider_schedule_blocks (
          id SERIAL PRIMARY KEY,
          provider_id INTEGER NOT NULL,
          block_type VARCHAR(30) NOT NULL DEFAULT 'unavailable',
          title VARCHAR(160) NOT NULL,
          start_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
          end_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
          source_ref VARCHAR(80) NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
    },
  },
  {
    id: '007_local_suspensions_integrations_audit_and_branding',
    run: async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.provider_local_suspensions (
          id SERIAL PRIMARY KEY,
          country_id INTEGER NOT NULL REFERENCES public.countries(id) ON DELETE CASCADE,
          provider_id INTEGER NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
          created_by_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          reason TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          lifted_at TIMESTAMP WITHOUT TIME ZONE NULL
        );
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS country_integrations (
          id SERIAL PRIMARY KEY,
          country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
          label VARCHAR(120) NOT NULL,
          api_key_hash VARCHAR(128) NOT NULL,
          api_key_prefix VARCHAR(24) NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          last_used_at TIMESTAMP WITHOUT TIME ZONE NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS gate_access_logs (
          id SERIAL PRIMARY KEY,
          qr_token VARCHAR(255) NULL,
          pass_id INTEGER NULL,
          country_id INTEGER NULL,
          integration_label VARCHAR(120) NULL,
          auth_mode VARCHAR(40) NOT NULL DEFAULT 'unknown',
          authorized BOOLEAN NOT NULL DEFAULT FALSE,
          reason_code VARCHAR(80) NOT NULL,
          message TEXT NOT NULL,
          http_status INTEGER NOT NULL DEFAULT 200,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS platform_branding (
          id SERIAL PRIMARY KEY,
          brand_name VARCHAR(60) NOT NULL DEFAULT 'TrustLink',
          brand_badge VARCHAR(40) NOT NULL DEFAULT 'Community',
          brand_subtitle VARCHAR(100) NOT NULL DEFAULT 'Red de Confianza Residencial',
          menu_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
          menu_text_color VARCHAR(7) NOT NULL DEFAULT '#E2E8F0',
          submenu_bg_color VARCHAR(7) NOT NULL DEFAULT '#090D16',
          submenu_text_color VARCHAR(7) NOT NULL DEFAULT '#CBD5E1',
          platform_bg_color VARCHAR(7) NOT NULL DEFAULT '#0F172A',
          platform_text_color VARCHAR(7) NOT NULL DEFAULT '#F1F5F9',
          card_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
          card_text_color VARCHAR(7) NOT NULL DEFAULT '#F1F5F9',
          inner_bg_color VARCHAR(7) NOT NULL DEFAULT '#0F172A',
          inner_text_color VARCHAR(7) NOT NULL DEFAULT '#E2E8F0',
          footer_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
          footer_text_color VARCHAR(7) NOT NULL DEFAULT '#94A3B8',
          logo_url TEXT DEFAULT NULL,
          dark_mode BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
    },
  },
  {
    id: '008_password_reset_tokens',
    run: async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash VARCHAR(128) NOT NULL UNIQUE,
          expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
          used_at TIMESTAMP WITHOUT TIME ZONE NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
    },
  },
  {
    id: '009_provider_employees_crew_columns',
    run: async () => {
      await db.query(`
        ALTER TABLE public.provider_employees
          ALTER COLUMN employee_user_id DROP NOT NULL;
      `).catch(() => {});
      await db.query(`
        ALTER TABLE public.provider_employees
          ADD COLUMN IF NOT EXISTS full_name VARCHAR(160) NULL,
          ADD COLUMN IF NOT EXISTS dni VARCHAR(30) NULL,
          ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL,
          ADD COLUMN IF NOT EXISTS role_label VARCHAR(80) DEFAULT 'Ayudante',
          ADD COLUMN IF NOT EXISTS insurance_policy_url TEXT NULL,
          ADD COLUMN IF NOT EXISTS insurance_expiry DATE NULL,
          ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
      `);
    },
  },
];

async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(120) PRIMARY KEY,
      applied_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  for (const migration of MIGRATIONS) {
    await migration.run();
    await db.query(
      `INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [migration.id]
    );
    console.log(`✅ Migración verificada: ${migration.id}`);
  }
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      console.log('🎉 Todas las migraciones de TrustLink están aplicadas.');
      await db.pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('❌ Error al ejecutar migraciones:', err);
      await db.pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { runMigrations };
