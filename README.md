# TrustLink Backend API

API REST modular de **TrustLink** — plataforma inteligente de servicios verificados, coordinación de visitas, pagos con *take rate* y control de accesos QR para comunidades privadas (countries y barrios cerrados).

> Para visión de negocio, propuesta de valor y arquitectura funcional completa, ver [docs/TRUSTLINK_MASTER_BRIEF.md](./docs/TRUSTLINK_MASTER_BRIEF.md) y [docs/ROADMAP_TECNICO.md](./docs/ROADMAP_TECNICO.md).

---

## Stack Tecnológico

- **Runtime:** Node.js + Express (`src/server.js`)
- **Base de datos:** PostgreSQL (`pg`) con soporte dual local (`DB_*`) y nube (`DATABASE_URL` + SSL dinámico)
- **Autenticación y Seguridad:** JWT (`jsonwebtoken`), `bcryptjs`, cabeceras HTTP de hardening y rate limiting (`src/middlewares/security.middleware.js`)
- **Tests:** Runner nativo de Node (`node --test`)

---

## Módulos de la API (`/api/v1`)

| Ruta base | Responsabilidad |
| :--- | :--- |
| `/health` | Estado del servicio y modo de ejecución (`local` / `external`). |
| `/api/v1/auth` | Registro, login, recuperación de contraseña y validación de sesión. |
| `/api/v1/account` | Perfil de usuario, identidad dual (`can_use_resident` / `can_use_provider`), portal principal y cambio de contraseña. |
| `/api/v1/providers` | Compliance documental versionado, flota vehicular, CRUD de cuadrilla/ayudantes, directorio verificado, auditoría Ops, suspensiones locales y alertas de vencimiento. |
| `/api/v1/passes` | Agenda del prestador, coordinación de visitas con mensajería, emisión/edición/cancelación y validación de pases QR (con cuadrilla adjunta). |
| `/api/v1/contracts` y `/api/v1/payments` | Órdenes de contratación, cotización *in situ*, checkout con Take Rate 7% / 93% y webhook validado por HMAC-SHA256 / secreto compartido. |
| `/api/v1/reviews` | Reputación cruzada bidireccional (Residente ↔ Prestador). |
| `/api/v1/external` | API Universal para garitas (`/passes/verify` vía `x-api-key` por comunidad o JWT), gestión de comunidades (`countries`), rotación de API Keys y auditoría (`gate_access_logs`). |
| `/api/v1/branding` | Configuración de marca blanca por zonas visuales. |

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
