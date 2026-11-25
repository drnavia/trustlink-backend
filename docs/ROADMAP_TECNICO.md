# TrustLink — Roadmap Técnico Priorizado (Gaps de Negocio → Código)

Este documento traduce las brechas identificadas entre la tesis comercial ([TRUSTLINK_MASTER_BRIEF.md](./TRUSTLINK_MASTER_BRIEF.md)) y el estado actual de `trustlink-backend` / `trustlink-web` en un plan ejecutable por fases.

---

## Resumen de Prioridades y Estado

| Fase | Prioridad | Iniciativa | Estado |
| :--- | :--- | :--- | :--- |
| **Fase 1** | **P0** | Bloqueo por vencimiento documental + Membresía **"Socio Verificado"** | **✅ Completada** (Migración `012`, `/api/v1/billing`, `complianceExpiry.js`, UI y E2E) |
| **Fase 2** | **P1** | **Licenciamiento B2B** a comunidades (`countries` SaaS) | **✅ Completada** (Migración `013`, enforcement API externa, `SystemHealthDashboard` y `LocalAdminView`) |
| **Fase 3** | **P1** | Integración real de **Mercado Pago** (Checkout Pro + firma `x-signature`, modo dual) | **✅ Completada** (Migración `014`, `mercadopago.service.js`, `/payments/config`, retorno UI) |
| **Fase 4** | **P2** | **Conformidad final, garantía/reclamos y Comprobante del Hogar** | **✅ Completada** (Migración `015`, `/contracts/:id/complete`, `/receipt`, `/dispute`, panel Ops) |
| **Evolutivas** | **P2** | Visibilidad por especialidad DB, ingresos prestador, filtros directorio, CSV y PWA | **✅ Completadas** (Migración `016`, `/contracts/provider`, `csvExport.js`, `manifest.webmanifest`) |
| **Fase 5** | **P2** | **Marketplace & Conversión:** Termómetro/Scoring, "En tu barrio", Favoritos, Recontratar, Micro-tags, Disponible Hoy y Hogar Protegido | **✅ Completada** (Migración `017`, `providerReputation.js`, `/providers/favorites`, `HomeProtectedBadge.jsx`, E2E) |
| **Fase 5.2** | **P2** | **Ficha Comercial & Búsqueda Inteligente:** Urgencias 24h, tiempo de respuesta, Q&A público, buscador por síntomas y filtros de reseñas | **✅ Completada** (Migración `018`, `/commercial-profile`, `/:id/questions`, `serviceSearchMatcher.js`, E2E) |
| **Fase 5.3** | **P2** | **Compliance por Persona & Catálogo Oficial:** Catálogo estándar auto-aprobado vs. especialidad personalizada con descripción moderada por Ops | **✅ Completada** (Migración `019`, `PATCH /compliance/user`, combo oficial en `ProviderDashboard`, `AdminComplianceView` agrupado, E2E) |
| **Externos** | **Diferido** | Credenciales MP Live/Suscripciones, Supabase Storage (PDFs) y Email transaccional (Resend/SMTP) | *Pendiente (habilitadores para primer piloto comercial con servicios externos)* |

---

## Fase 1 (P0): Enforcement de Compliance y Membresía "Socio Verificado"

### 1.1 Bloqueo automático por documentación vencida en garita
Hoy existen alertas proactivas en `GET /api/v1/providers/expiry-alerts`, pero `verifyExternalPassByQR` (`src/modules/external/external.controller.js`) y `verifyPassByQR` (`src/modules/passes/passes.controller.js`) validan `compliance_status = 'approved'` sin bloquear automáticamente cuando `criminal_record_expiry` o `insurance_expiry` están vencidos.

- **Cambios en Backend:**
  - En `verifyExternalPassByQR` y `verifyPassByQR`: incluir `p.criminal_record_expiry` y `p.insurance_expiry` en el `SELECT` del pase; si alguno tiene fecha `< CURRENT_DATE`, rechazar con `403` y códigos explícitos (`CRIMINAL_RECORD_EXPIRED` / `INSURANCE_EXPIRED`), registrando el motivo en `gate_access_logs`.
  - En `createPass` (`src/modules/passes/passes.controller.js`): advertir o impedir emitir pases nuevos si el prestador tiene póliza/antecedentes vencidos (configurable por política de gracia si se desea).
  - Si el pase incluye `authorized_employees`, validar también `insurance_expiry` de cada ayudante adjunto.
- **Cambios en Frontend:**
  - En `SecurityScanner.jsx`: mostrar alerta roja diferenciada indicando qué documento venció.
  - En `ProviderDashboard.jsx`: banner de acción urgente para subir nueva versión en `provider_document_versions`.

### 1.2 Membresía "Socio Verificado" (Suscripción B2C para Prestadores)
Es el pilar de monetización prioritario para el mercado argentino porque genera ingresos recurrentes aunque el prestador cobre en efectivo.

- **Modelo de Datos (nueva migración idempotente):**
  ```sql
  CREATE TABLE IF NOT EXISTS provider_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code VARCHAR(40) NOT NULL DEFAULT 'verified_monthly', -- 'free' | 'verified_monthly' | 'verified_pro'
    status VARCHAR(20) NOT NULL DEFAULT 'active',            -- 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired'
    starts_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMP NOT NULL,
    external_subscription_id VARCHAR(160) NULL,              -- ID suscripción Mercado Pago / billing
    auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
  ```
- **Cambios en Backend:**
  - Nuevo módulo `src/modules/billing/` (o extensión en `providers`):
    - `GET /api/v1/billing/provider/me` — Estado actual de membresía, vencimiento y beneficios.
    - `POST /api/v1/billing/provider/subscribe` — Crea suscripción / checkout de membresía.
    - `PATCH /api/v1/billing/provider/:userId` — Gestión manual por `superadmin` (alta promocional, cortesía, extensión o baja).
  - En `listVerifiedProviders` (`src/modules/providers/providers.controller.js`): hacer `LEFT JOIN` a la suscripción vigente, devolver `is_verified_member` y `membership_tier`, y **ordenar prioritariamente** a socios verificados activos (`is_verified_member DESC, rating_avg DESC`).
- **Cambios en Frontend:**
  - `ResidentDashboard.jsx`: insignia visual **"Socio Verificado"** y orden destacado en el directorio.
  - `ProviderDashboard.jsx`: tarjeta de estado de membresía con fecha de renovación y botón de activación.
  - `UserManagementView.jsx` / `AdminComplianceView.jsx`: filtro y asignación de plan para pilotos comerciales.

---

## Fase 2 (P1): Licenciamiento B2B para Comunidades (`countries`)

Hoy `countries` y `country_integrations` gestionan el estado `is_active` y las API Keys de garita, pero no modelan planes comerciales ni límites.

- **Modelo de Datos:**
  ```sql
  ALTER TABLE countries
    ADD COLUMN IF NOT EXISTS plan_code VARCHAR(40) NOT NULL DEFAULT 'pilot',
    ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'trial' | 'active' | 'grace' | 'suspended'
    ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMP NULL,
    ADD COLUMN IF NOT EXISTS monthly_pass_quota INTEGER NULL;
  ```
- **Cambios en Backend (`src/modules/external/external.controller.js`):**
  - En `resolveExternalAuth`: validar `billing_status` de la comunidad; si está `'suspended'` (vencida fuera de período de gracia), devolver `403` con código `COUNTRY_SUBSCRIPTION_SUSPENDED` y registrar en `gate_access_logs`.
  - Extender `createCountry` / `updateCountry` y agregar `PATCH /api/v1/external/countries/:id/billing` (`superadmin`) para definir plan, vigencia y cuota mensual.
  - Exponer consumo mensual de validaciones en `getExternalDiagnostics` / `getAuditOverview` para reportería comercial B2B.
- **Cambios en Frontend:**
  - `SystemHealthDashboard.jsx`: columnas/badges de plan B2B, vencimiento y consumo mensual de QR por comunidad.
  - `LocalAdminView.jsx`: tarjeta de estado del abono de la comunidad (solo lectura para `admin` local).

---

## Fase 3 (P1): Pasarela Real de Mercado Pago (Take Rate 7% / 93%)

Hoy `payments.controller.js` ya calcula `platform_fee` (7%) y `provider_payout` (93%), persiste `transactions`, y protege `/api/v1/payments/webhook` con `verifyWebhookAuth` (HMAC-SHA256 / secreto compartido), pero el checkout es simulado (`MP-PAY-...`).

- **Variables de Entorno Nuevas (`.env.example`):**
  - `MP_ACCESS_TOKEN` (credencial productiva/sandbox de TrustLink)
  - `MP_PLATFORM_FEE_PERCENT=7` (parametrizable entre 6% y 8%)
  - `MP_PUBLIC_APP_URL` y `MP_WEBHOOK_URL`
- **Cambios en Backend (`src/modules/payments/`):**
  - Reemplazar la generación mock en `createOrUpdateQuote` y `checkoutContractPayment` por una llamada real a `POST https://api.mercadopago.com/checkout/preferences` con `external_reference = contract_id`, `notification_url` y (cuando el prestador conecte su cuenta vía OAuth) `marketplace_fee = platformFee`.
  - Guardar en `transactions` el `preference_id` inicial y actualizar con el `payment_id` definitivo en el webhook.
  - Adaptar `confirmPayment` para consultar `GET https://api.mercadopago.com/v1/payments/:id` ante notificación real de MP, verificar monto/moneda y garantizar idempotencia estricta (evitar doble acreditación).
  - Mantener un modo `PAYMENT_GATEWAY_MODE=mock|mercadopago` para que los tests E2E locales sigan corriendo sin red.
- **Cambios en Frontend (`ResidentDashboard.jsx` — Paso 4 unificado):**
  - Redirigir a `init_point` / `sandbox_init_point` cuando el backend devuelva `checkout_url` real, mostrar estado de retorno (`approved` / `pending` / `rejected`) al volver desde Mercado Pago (incluso redirigiendo `/#payments` al Paso 4 del Portal Residente), y gestionar la creación de órdenes desde Pases QR dentro del mismo flujo de 5 pasos sin vistas duplicadas en la barra superior.

---

## Fase 4 (P2): Conformidad Final, Garantía Post-Servicio y Reclamos

Para respaldar la promesa de "garantía post-servicio y trazabilidad" frente a la informalidad del mercado:

- **Cierre explícito de contrato:**
  - Agregar `PATCH /api/v1/contracts/:id/complete` (Residente o Superadmin) que pase `service_contracts.status` de `in_progress` → `completed`, registre `completed_at` y dispare la liberación (`released`) de la transacción asociada.
  - Habilitar las reseñas cruzadas (`provider_reviews` / `owner_reviews`) idealmente a partir de contratos conformados o completados.
- **Módulo de Reclamos / Disputas:**
  - Tabla `service_disputes (id, contract_id, opened_by_user_id, reason, details, evidence_urls JSONB, status, resolution_notes, resolved_by, created_at, resolved_at)`.
  - Endpoints: `POST /api/v1/contracts/:id/dispute`, `GET /api/v1/contracts/:id/disputes`, `PATCH /api/v1/contracts/disputes/:id/resolve` (`superadmin`).
- **Comprobante del Hogar:**
  - Vista imprimible/exportable de resumen del servicio (prestador, DNI, póliza ART vigente al día del ingreso, pase QR usado, monto acordado y conformidad).

---

## Fase 5 (P2): Marketplace, Scoring y Conversión (Completada)

- **Migración `017_marketplace_favorites_and_review_tags`:** crea `resident_favorite_providers` (relación única residente → prestador) y agrega `tags JSONB` en `provider_reviews`.
- **Motor de reputación (`src/utils/providerReputation.js`):** calcula puntaje `/100`, termómetro visual de 5 niveles (`1..5`), medallas por mérito (*Nuevo Verificado*, *Confiable*, *Destacado Oro*, *TrustLink Platino*), degradación por vencimiento/suspensión local y `next_milestone` anti-leakage.
- **Directorio y Portal Prestador:** prueba social hiper-local (*"X servicios/ingresos verificados en tu barrio"*), filtro *Disponible hoy* conectado a `provider_schedule_blocks`, endpoints de Favoritos (`/api/v1/providers/favorites`), botón *Volver a contratar* en 1 clic, micro-tags tocables en reseñas, sello UX **Hogar Protegido** (`HomeProtectedBadge.jsx`) y tablero *Mi Reputación*.

---

## Fase 5.2 (P2): Ficha Comercial Rápida, Q&A y Buscador Inteligente (Completada)

- **Migración `018_provider_commercial_profile_and_qa`:** agrega `accepts_emergencies`, `quote_visit_policy`, `invoice_type`, `accepted_payment_methods` y `service_bio` a `providers`, y crea `provider_public_questions`.
- **Backend:** endpoint `PATCH /api/v1/providers/commercial-profile`, cálculo automático de tiempo promedio de respuesta (`computeResponseTimeStats` sobre `visit_requests`) y endpoints de Q&A comunitario (`GET/POST /api/v1/providers/:providerUserId/questions` y `PATCH /api/v1/providers/questions/:questionId/answer`).
- **Frontend:** buscador inteligente por síntomas y sinónimos (`src/utils/serviceSearchMatcher.js`) en Landing y Directorio, filtro *Urgencias 24h*, ficha comercial rápida en tarjetas, modal Q&A público, panel Q&A/Ficha Comercial en `ProviderDashboard.jsx` y filtros por estrellas y micro-tag en el modal de reseñas.

---

## Fase 5.3 (P2): Compliance por Persona y Catálogo Oficial de Especialidades (Completada)

- **Migración `019_provider_specialty_catalog_and_custom_review`:** agrega `is_custom_specialty`, `custom_specialty_description` y `specialty_approval_status` a `providers`.
- **Backend:** catálogo normalizado `STANDARD_SPECIALTIES_CATALOG` (`providerReputation.js`), auto-aprobación instantánea de rubros estándar para prestadores con compliance personal vigente (tanto en alta `POST /profile` como en edición `PATCH /profile/:id` sin cambio documental), sincronización transversal de renovaciones documentales personales (`Antecedentes` / `ART`) entre todas las especialidades del usuario sin duplicar historial, moderación obligatoria con descripción para especialidades personalizadas y nuevo endpoint `PATCH /api/v1/providers/compliance/user` para aprobar/rechazar a la persona de una sola vez.
- **Frontend:** selector de catálogo oficial + opción *"Otra especialidad (con descripción)"* tanto en alta como en edición inline de especialidades en `ProviderDashboard.jsx`, sección **Documentación Personal** refactorizada en **2 tarjetas vigentes** (*Antecedentes Penales* y *Póliza ART / Seguro*) más **acordeón colapsable de historial de versiones anteriores** (solo lectura para auditoría legal), scoring unificado en cabecera, y consola `AdminComplianceView.jsx` agrupada por persona (tarjetas o tabla compacta, semáforo de vigencia documental, acción única de compliance personal y bloque dedicado para moderar rubros personalizados).

---

## Fase 5.4 (P2): Calendario Vivo de Disponibilidad cada 30 min (Completada)

- **Migración `020_provider_weekly_availability`:** crea `provider_availability_rules` (por `user_id` y `day_of_week 0..6`, con `is_working`, `start_time`, `end_time` y `slot_minutes` en `30` o `60` min) sincronizada también en `database/trustlink-production-init.sql`.
- **Backend:** motor puro `src/utils/scheduleAvailability.js` (+ suite unitaria `test/scheduleAvailability.test.js`), nuevo endpoint `PUT /api/v1/passes/schedule/rules` para guardar la jornada semanal, `GET /api/v1/passes/schedule/provider` enriquecido con proyección de 7 días cada 30/60 min y timestamps UTC explícitos, `GET /api/v1/passes/schedule/availability/:providerUserId` para que el residente consulte franjas libres/ocupadas **sin exponer títulos privados de trabajos externos ni lotes de otros vecinos**, y máquina bilateral de negociación de visitas (`pending_provider` ↔ `pending_resident` → `confirmed`) con `PATCH /api/v1/passes/visit-requests/:id/resident-respond`.
- **Frontend:** nuevo componente `src/components/ProviderCalendarManager.jsx` en el Paso 3 (`Agenda`) del Portal Prestador (configurador semanal Lun–Dom, tira semanal navegable, grilla interactiva cada 30 min para bloquear en 1 clic trabajos externos o franjas no laborables y visualizar visitas/pases TrustLink en vivo), **Paso 4 (`Visitas`) del Prestador** con confirmación y repactación inline de fecha/hora, y **Portal Residente** (`ResidentDashboard.jsx`) con selector de disponibilidad real al solicitar o contraproponer visita, confirmación de contrapropuestas en Paso 2 y habilitación de **`Emitir Pase QR`** condicionada al acuerdo mutuo (con domicilio automático y ventana `Desde/Hasta` precargada).

---

## Estado de Ejecución y Siguiente Etapa

1. **Sprints 1–5 (Completados):** Fases 1, 2, 3 (modo dual), 4, 5 mejoras evolutivas, Fase 5, Fase 5.2, Fase 5.3 y Fase 5.4, con **20/20 tests E2E**, **20/20 unitarios backend** y **6/6 unitarios frontend**.
2. **Siguiente Etapa (Salida Comercial — Externos):** ver checklist vivo en [PENDIENTES.md](./PENDIENTES.md) (Smoke Test en nube, credenciales reales Mercado Pago, Supabase Storage para documentos + galería *Antes y después*, y Resend/SMTP para emails transaccionales).
