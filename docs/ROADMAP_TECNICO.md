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
- **Cambios en Frontend (`ContractPaymentView.jsx`):**
  - Redirigir a `init_point` / `sandbox_init_point` cuando el backend devuelva `checkout_url` real, y mostrar estado de retorno (`approved` / `pending` / `rejected`) al volver desde Mercado Pago.

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

## Criterio de Ejecución Recomendado

1. **Sprint 1:** Fase 1.1 (bloqueo por vencimiento en QR) + Fase 1.2 (base de datos y ranking de *Socio Verificado* con alta desde Superadmin).
2. **Sprint 2:** Fase 2 (campos B2B en comunidades y métricas de uso por barrio) + Fase 3 en Sandbox de Mercado Pago.
3. **Sprint 3:** Salida a producción de Mercado Pago + Fase 4 (conformidad formal y gestión de reclamos).
