# TrustLink Backend API

API REST modular de **TrustLink** — plataforma inteligente de servicios verificados, coordinación de visitas, pagos con *take rate* y control de accesos QR para comunidades privadas (countries y barrios cerrados).

> Documentación viva del proyecto:
> - Negocio y producto: [docs/TRUSTLINK_MASTER_BRIEF.md](./docs/TRUSTLINK_MASTER_BRIEF.md)
> - Roadmap técnico (Fases 1–5.4): [docs/ROADMAP_TECNICO.md](./docs/ROADMAP_TECNICO.md)
> - Puesta en producción en Supabase desde cero: [docs/DEPLOY_SUPABASE.md](./docs/DEPLOY_SUPABASE.md) + script SQL único [database/trustlink-production-init.sql](./database/trustlink-production-init.sql)
> - Backlog diferido (externos y smoke test): [docs/PENDIENTES.md](./docs/PENDIENTES.md)

---

## Stack Tecnológico

- **Runtime:** Node.js + Express (`src/server.js`)
- **Base de datos:** PostgreSQL (`pg`) con soporte dual local (`DB_*`) y nube (`DATABASE_URL` + SSL dinámico) y 22 migraciones idempotentes (`src/db/migrate.js`)
- **Autenticación y Seguridad:** JWT (`jsonwebtoken`), `bcryptjs`, cabeceras HTTP de hardening y rate limiting (`src/middlewares/security.middleware.js`)
- **Tests:** Runner nativo de Node (`node --test`) — 21 tests E2E + 21 tests unitarios (`complianceExpiry`, `mercadopagoService`, `providerReputation`, `scheduleAvailability`)

---

## Módulos de la API (`/api/v1`)

| Ruta base | Responsabilidad |
| :--- | :--- |
| `/health` | Estado del servicio y modo de ejecución (`local` / `external`). |
| `/api/v1/auth` | Registro, login, catálogo público de comunidades, recuperación de contraseña y cuentas privilegiadas. |
| `/api/v1/account` | Perfil de usuario, identidad dual (`can_use_resident` / `can_use_provider`), portal principal y cambio de contraseña autenticado. |
| `/api/v1/providers` | Compliance documental versionado, visibilidad por especialidad, flota vehicular, CRUD de cuadrilla/ayudantes, **ficha comercial + Urgencias 24h**, **Q&A público comunitario**, **favoritos**, directorio enriquecido con **termómetro de reputación / tiempo de respuesta / actividad en tu barrio / disponible hoy**, auditoría Ops, suspensiones locales y alertas de vencimiento. |
| `/api/v1/billing` | Membresía **Socio Verificado** (`verified_monthly`, `verified_quarterly`, `verified_pro`), autogestión de prestadores y gestión Superadmin. |
| `/api/v1/passes` | Agenda del prestador (`provider_schedule_blocks`), coordinación de visitas con mensajería, emisión/edición/cancelación y validación de pases QR con bloqueo automático por documentación vencida (titular y cuadrilla). |
| `/api/v1/contracts` y `/api/v1/payments` | Órdenes de contratación, cotización *in situ*, pasarela dual `mock \| mercadopago` (Checkout Pro + webhook firmado `x-signature`), Take Rate 7% / 93%, **conformidad final con liberación escrow**, **Comprobante del Hogar**, **resumen de ingresos del prestador** y **reclamos/garantía**. |
| `/api/v1/reviews` | Reputación cruzada bidireccional (Residente ↔ Prestador) con **micro-tags tocables** persistidos en JSONB. |
| `/api/v1/external` | API Universal para garitas (`/passes/verify` vía `x-api-key` por comunidad o JWT), **licenciamiento B2B y cuotas mensuales QR** por comunidad (`countries`), rotación de API Keys y auditoría (`gate_access_logs`). |
| `/api/v1/branding` | Configuración de marca blanca por zonas visuales (Zonas 1 a 6, logo y modo oscuro). |

---

## Configuración Local

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Copiar variables de entorno y completar valores locales:
   ```bash
   cp .env.example .env
   ```
   Variables principales:
   - `PORT` (default `4000`)
   - `DATABASE_URL` o `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`
   - `JWT_SECRET` (secreto robusto de al menos 32 caracteres)
   - `CORS_ORIGINS` (lista separada por comas de orígenes permitidos en producción)
   - `PAYMENT_WEBHOOK_SECRET` (secreto HMAC para `/api/v1/payments/webhook`)
   - `EXTERNAL_GATE_API_KEY` *(opcional, clave global de respaldo para garitas)*
3. Aplicar esquema/migraciones:
   ```bash
   npm run migrate
   ```
4. Iniciar servidor:
   ```bash
   npm run dev
   ```

---

## Scripts Disponibles

- `npm start` — Inicia el servidor en producción.
- `npm run dev` — Inicia con recarga automática (`node --watch`).
- `npm run migrate` — Ejecuta las migraciones SQL.
- `npm test` — Corre la suite E2E (`test/e2e.test.js`).
