/**
 * @file migrate.js
 * @description Runner idempotente y ordenado de migraciones evolutivas para PostgreSQL de TrustLink.
 * Consolida en un único script ejecutable (`npm run migrate`) todas las tablas, columnas e índices
 * evolutivos introducidos tras el esquema base (`database/script-schema.sql.txt`).
 * Cada migración está diseñada para ejecutarse de forma segura múltiples veces sin destruir datos.
 * @location /trustlink-backend/src/db/migrate.js
 */

require('dotenv').config();
const db = require('../config/db');
const { ensureEvolutionSchema } = require('../config/ensureEvolutionSchema');

/**
 * Catálogo ordenado de migraciones evolutivas de TrustLink (001 a 016).
 * Cada entrada posee un identificador único (`id`) registrado en `schema_migrations`
 * y una función asíncrona (`run`) con sentencias DDL/DML idempotentes.
 */
const MIGRATIONS = [
  // ---------------------------------------------------------------------------
  // 001: Dirección postal estructurada de comunidades (`countries`)
  // Agrega `address`, `postal_code`, `city` y `province` a `countries`.
  // Habilita la ficha geográfica completa de cada barrio/country para el alta,
  // la administración centralizada y el contexto de ubicación en el directorio.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 002: Vencimientos documentales e historial de versiones (`providers`, `provider_document_versions`)
  // Agrega `criminal_record_expiry` e `insurance_expiry` a `providers` y crea la tabla
  // `provider_document_versions` para conservar trazabilidad de certificados (antecedentes y ART).
  // Habilita alertas de vencimiento, auditoría de renovaciones y bloqueo automático en garita.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 003: Tipología y seguro obligatorio de la flota vehicular (`provider_vehicles`)
  // Agrega `vehicle_type`, `vehicle_insurance_url`, `vehicle_insurance_from` y
  // `vehicle_insurance_expiry` a `provider_vehicles`.
  // Habilita el control de póliza vehicular por patente y alertas de vencimiento de flota.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 004: Patente vehicular vinculada al pase de acceso (`access_passes`)
  // Agrega `vehicle_plate` a `access_passes`.
  // Habilita asociar un vehículo específico del prestador a cada pase QR para verificación en garita.
  // ---------------------------------------------------------------------------
  {
    id: '004_access_passes_vehicle_plate',
    run: async () => {
      await db.query(`
        ALTER TABLE public.access_passes
          ADD COLUMN IF NOT EXISTS vehicle_plate VARCHAR(20) NULL;
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 005: Identidad dual, ubicación normalizada y reseñas cruzadas
  // Delega en `ensureEvolutionSchema()` para asegurar en `users` las columnas de
  // ubicación (`fraction_type`) y portales duales (`can_use_resident`, `can_use_provider`,
  // `primary_portal`, `portals_configured`), además de la tabla `owner_reviews`.
  // Habilita que un mismo usuario opere como residente y prestador, y la reputación bidireccional.
  // ---------------------------------------------------------------------------
  {
    id: '005_dual_identity_location_and_owner_reviews',
    run: async () => {
      await ensureEvolutionSchema();
    },
  },

  // ---------------------------------------------------------------------------
  // 006: Coordinación de visitas y agenda del prestador (`visit_requests`, `provider_schedule_blocks`)
  // Crea `visit_requests` (solicitudes de visita con hilo JSONB de mensajes y estado) y
  // `provider_schedule_blocks` (bloqueos manuales o reservados en la agenda del prestador).
  // Habilita la coordinación previa Residente <-> Prestador y la disponibilidad online antes del QR.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 007: Suspensiones locales, integraciones API, auditoría de garita y branding
  // Crea 4 tablas clave de operación y gobierno:
  // - `provider_local_suspensions`: bloqueos operativos de un prestador dentro de un barrio específico.
  // - `country_integrations`: credenciales API (hash + prefijo) por comunidad para garitas externas.
  // - `gate_access_logs`: bitácora inmutable de cada intento de validación QR en garita/API externa.
  // - `platform_branding`: personalización visual white-label (colores, textos, logo, modo oscuro).
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 008: Tokens seguros para recuperación de contraseña (`password_reset_tokens`)
  // Crea `password_reset_tokens` almacenando únicamente el hash del token, su expiración
  // y marca de uso (`used_at`).
  // Habilita el flujo de "Olvidé mi contraseña" de un solo uso sin exponer secretos en DB.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 009: Cuadrilla y ayudantes del prestador sin cuenta propia (`provider_employees`)
  // Permite `employee_user_id` nulo (catch silencioso si ya es nullable) y agrega
  // `full_name`, `dni`, `phone`, `role_label`, `insurance_policy_url`, `insurance_expiry`
  // e `is_active` a `provider_employees`.
  // Habilita registrar ayudantes de obra/mantenimiento con su póliza ART individual.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 010: Nómina de ayudantes autorizados dentro del pase QR (`access_passes`)
  // Agrega la columna JSONB `authorized_employees` a `access_passes`.
  // Habilita incluir un snapshot de los ayudantes autorizados en el ingreso y validar
  // en tiempo real la vigencia de sus seguros ART al escanear en garita.
  // ---------------------------------------------------------------------------
  {
    id: '010_access_passes_authorized_employees',
    run: async () => {
      await db.query(`
        ALTER TABLE public.access_passes
          ADD COLUMN IF NOT EXISTS authorized_employees JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 011: Bandera de configuración de portales y backfill legacy (`users`)
  // Agrega `portals_configured` a `users` y ejecuta una normalización única para cuentas
  // existentes con `portals_configured = FALSE`, derivando `can_use_provider`,
  // `can_use_resident` y `primary_portal` a partir del rol y lote registrados.
  // Evita sobrescribir cambios posteriores realizados manualmente desde "Mi Cuenta".
  // ---------------------------------------------------------------------------
  {
    id: '011_users_portals_configured_and_cleanup',
    run: async () => {
      await db.query(`
        ALTER TABLE public.users
          ADD COLUMN IF NOT EXISTS portals_configured BOOLEAN NOT NULL DEFAULT FALSE;
      `);
      await db.query(`
        UPDATE public.users u
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
          portals_configured = TRUE
        WHERE COALESCE(u.portals_configured, FALSE) = FALSE;
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 012: Membresía "Socio Verificado" para prestadores (`provider_subscriptions`)
  // Crea la tabla `provider_subscriptions` y su índice compuesto por `(user_id, status, ends_at DESC)`.
  // Habilita suscripciones recurrentes, renovaciones, vencimientos y gestión manual desde Ops.
  // ---------------------------------------------------------------------------
  {
    id: '012_provider_subscriptions',
    run: async () => {
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
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_provider_subscriptions_user_status
        ON public.provider_subscriptions (user_id, status, ends_at DESC);
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 013: Licenciamiento B2B de comunidades y migración de API Keys hasheadas
  // Agrega `plan_code`, `billing_status`, `subscription_ends_at` y `monthly_pass_quota` a `countries`.
  // Además compatibiliza instalaciones legacy de `country_integrations` asegurando `api_key_hash`
  // y `api_key_prefix`, y relajando la restricción `NOT NULL` en la columna histórica `api_key`.
  // Habilita planes comerciales por barrio, cuotas mensuales de QR y claves API seguras.
  // ---------------------------------------------------------------------------
  {
    id: '013_countries_b2b_licensing',
    run: async () => {
      await db.query(`
        ALTER TABLE public.countries
          ADD COLUMN IF NOT EXISTS plan_code VARCHAR(40) NOT NULL DEFAULT 'pilot',
          ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'active',
          ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMP WITHOUT TIME ZONE NULL,
          ADD COLUMN IF NOT EXISTS monthly_pass_quota INTEGER NULL;
      `);
      await db.query(`
        ALTER TABLE public.country_integrations
          ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(128) NULL,
          ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(24) NULL;
      `).catch(() => {});
      await db.query(`
        ALTER TABLE public.country_integrations
          ALTER COLUMN api_key DROP NOT NULL;
      `).catch(() => {});
    },
  },

  // ---------------------------------------------------------------------------
  // 014: Integración de pasarela Mercado Pago Checkout Pro (`transactions`)
  // Agrega `preference_id`, `checkout_url`, `gateway_mode`, `gateway_raw_status` y `updated_at`
  // a `transactions`.
  // Habilita operar pagos tanto en modo simulado (`mock`) como real (`mercadopago`) con
  // trazabilidad completa de preferencias de pago y respuestas de webhooks.
  // ---------------------------------------------------------------------------
  {
    id: '014_transactions_mercadopago_columns',
    run: async () => {
      await db.query(`
        ALTER TABLE public.transactions
          ADD COLUMN IF NOT EXISTS preference_id VARCHAR(255) NULL,
          ADD COLUMN IF NOT EXISTS checkout_url TEXT NULL,
          ADD COLUMN IF NOT EXISTS gateway_mode VARCHAR(30) NOT NULL DEFAULT 'mock',
          ADD COLUMN IF NOT EXISTS gateway_raw_status VARCHAR(60) NULL,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW();
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 015: Conformidad final de trabajos y sistema de reclamos/disputas (`service_contracts`, `service_disputes`)
  // Agrega `completed_at` y `completion_notes` a `service_contracts`, y crea la tabla
  // `service_disputes` (con evidencias JSONB, estado y resolución administrativa) junto con su índice.
  // Habilita el cierre formal del servicio por el residente y la mediación de reclamos por garantía.
  // ---------------------------------------------------------------------------
  {
    id: '015_contract_completion_and_disputes',
    run: async () => {
      await db.query(`
        ALTER TABLE public.service_contracts
          ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITHOUT TIME ZONE NULL,
          ADD COLUMN IF NOT EXISTS completion_notes TEXT NULL;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.service_disputes (
          id SERIAL PRIMARY KEY,
          contract_id INTEGER NOT NULL REFERENCES public.service_contracts(id) ON DELETE CASCADE,
          opened_by_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          reason VARCHAR(120) NOT NULL,
          details TEXT NOT NULL,
          evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
          status VARCHAR(30) NOT NULL DEFAULT 'open',
          resolution_notes TEXT NULL,
          resolved_by INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMP WITHOUT TIME ZONE NULL
        );
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_service_disputes_contract
        ON public.service_disputes (contract_id, status);
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 016: Control granular de visibilidad en el directorio por especialidad (`providers`)
  // Agrega `is_visible_in_directory` (TRUE por defecto) a `providers`.
  // Habilita que un prestador oculte o reactive una especialidad puntual en el directorio
  // público sin perder su estado de compliance aprobado ni sus documentos vigentes.
  // ---------------------------------------------------------------------------
  {
    id: '016_provider_specialty_visibility',
    run: async () => {
      await db.query(`
        ALTER TABLE public.providers
          ADD COLUMN IF NOT EXISTS is_visible_in_directory BOOLEAN NOT NULL DEFAULT TRUE;
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 017: Marketplace Fase 5 — Favoritos del residente y micro-tags en reseñas
  // Crea `resident_favorite_providers` (relación única residente -> prestador) con su índice
  // y agrega la columna JSONB `tags` a `provider_reviews` para atributos tocables (`Puntual`,
  // `Prolijo`, `Precio justo`, etc.).
  // Habilita "Mis prestadores de confianza", recontratación rápida y reputación enriquecida.
  // ---------------------------------------------------------------------------
  {
    id: '017_marketplace_favorites_and_review_tags',
    run: async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.resident_favorite_providers (
          id SERIAL PRIMARY KEY,
          resident_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          provider_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (resident_user_id, provider_user_id)
        );
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_resident_favorite_providers_resident
        ON public.resident_favorite_providers (resident_user_id);
      `);
      await db.query(`
        ALTER TABLE public.provider_reviews
          ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 018: Marketplace Fase 5.2 — Ficha comercial rápida, Urgencias 24h y Q&A público
  // Agrega columnas comerciales a `providers` (`accepts_emergencies`, `quote_visit_policy`,
  // `invoice_type`, `accepted_payment_methods`, `service_bio`) y crea la tabla
  // `provider_public_questions` con su índice para preguntas y respuestas comunitarias.
  // ---------------------------------------------------------------------------
  {
    id: '018_provider_commercial_profile_and_qa',
    run: async () => {
      await db.query(`
        ALTER TABLE public.providers
          ADD COLUMN IF NOT EXISTS accepts_emergencies BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS quote_visit_policy VARCHAR(40) NOT NULL DEFAULT 'consultar',
          ADD COLUMN IF NOT EXISTS invoice_type VARCHAR(30) NOT NULL DEFAULT 'consultar',
          ADD COLUMN IF NOT EXISTS accepted_payment_methods JSONB NOT NULL DEFAULT '["efectivo","transferencia","mercadopago"]'::jsonb,
          ADD COLUMN IF NOT EXISTS service_bio TEXT NULL;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.provider_public_questions (
          id SERIAL PRIMARY KEY,
          provider_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          asked_by_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          answer TEXT NULL,
          answered_by_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          answered_at TIMESTAMP WITHOUT TIME ZONE NULL
        );
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_provider_public_questions_provider
        ON public.provider_public_questions (provider_user_id, created_at DESC);
      `);
    },
  },

  // ---------------------------------------------------------------------------
  // 019: Catálogo estándar auto-aprobado vs. especialidades personalizadas moderadas (`providers`)
  // Agrega `is_custom_specialty`, `custom_specialty_description` y `specialty_approval_status`
  // a `providers` para diferenciar rubros oficiales del catálogo (auto-aprobados si la persona
  // ya pasó compliance documental) de rubros personalizados que requieren revisión puntual de Ops.
  // ---------------------------------------------------------------------------
  {
    id: '019_provider_specialty_catalog_and_custom_review',
    run: async () => {
      await db.query(`
        ALTER TABLE public.providers
          ADD COLUMN IF NOT EXISTS is_custom_specialty BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS custom_specialty_description TEXT NULL,
          ADD COLUMN IF NOT EXISTS specialty_approval_status VARCHAR(20) NOT NULL DEFAULT 'approved';
      `);
    },
  },
];

/**
 * Ejecuta secuencialmente todas las migraciones evolutivas declaradas en `MIGRATIONS`.
 *
 * Estrategia de idempotencia:
 * 1. Crea la tabla de control `schema_migrations` si aún no existe.
 * 2. Re-verifica cada migración en orden estricto (todas sus sentencias usan `IF NOT EXISTS`
 *    o actualizaciones condicionadas), garantizando reparación automática ante despliegues parciales.
 * 3. Registra cada `id` en `schema_migrations` con `ON CONFLICT (id) DO NOTHING`, permitiendo
 *    invocar el script repetidas veces (CI/CD, arranque o mantenimiento manual) sin fallos ni duplicados.
 *
 * @returns {Promise<void>}
 */
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

// Ejecución directa por CLI (`node src/db/migrate.js` o `npm run migrate`)
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
