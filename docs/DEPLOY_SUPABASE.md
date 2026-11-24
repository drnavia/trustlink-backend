# TrustLink — Guía de Puesta en Producción de Base de Datos en Supabase

> Procedimiento de respaldo para levantar la base de datos de **TrustLink** desde cero en **Supabase (PostgreSQL)** y conectarla con el backend (**Railway**) y frontend (**Vercel**).

---

## Resumen de Archivos Clave

- **Script SQL único consolidado (recomendado para arrancar desde cero):** [trustlink-production-init.sql](../database/trustlink-production-init.sql)  
  Incluye las **23 tablas**, **5 tipos ENUM**, **índices**, **restricciones**, semillas mínimas (`platform_branding` y comunidad inicial), registro de las **18 migraciones (`001`–`018`)** en `schema_migrations`, sincronización de secuencias, plantilla de Superadmin y bloque opcional de blindaje RLS.
- **Migrador incremental CLI (para evoluciones futuras):** [migrate.js](../src/db/migrate.js) (`npm run migrate`).
- **Configuración de conexión y SSL:** [db.js](../src/config/db.js).

---

## Paso 1 — Crear el proyecto en Supabase y copiar la URI de conexión

1. Creá un proyecto nuevo en [Supabase](https://supabase.com/) y guardá la contraseña de PostgreSQL.
2. En el panel del proyecto, abrí **Connect → Connection String**.
3. Elegí **Session Pooler** (puerto `5432`, host `...pooler.supabase.com`) en lugar de *Direct Connection* (la conexión directa suele operar solo sobre IPv6 y puede fallar desde Railway o redes IPv4).
4. Agregá `?sslmode=require` al final de la URI:
   ```text
   postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   > **Nota técnica ([db.js](../src/config/db.js)):** al ejecutar scripts desde tu PC local contra el pooler (`pooler.supabase.com`), pasá siempre `?sslmode=require` en la URI (o `DB_SSL=true`) para forzar SSL aunque `NODE_ENV` no sea `production`.

---

## Paso 2 — Inicializar toda la base de datos en una sola ejecución

### Opción A — Script único consolidado *(Recomendada)*
1. Abrí el **SQL Editor** en Supabase.
2. Copiá y ejecutá completo [trustlink-production-init.sql](../database/trustlink-production-init.sql).
3. Verificá en **Table Editor** que existan las **23 tablas** (incluyendo `countries`, `users`, `providers`, `access_passes`, `service_contracts`, `transactions`, `service_disputes`, `provider_subscriptions`, `resident_favorite_providers`, `provider_public_questions`, `country_integrations`, `gate_access_logs`, `platform_branding` y `schema_migrations`).

### Opción B — Vía tradicional en 2 pasos (esquema base + `npm run migrate`)
Solo si preferís aplicar el histórico por separado:
1. Ejecutá [script-schema.sql.txt](../database/script-schema.sql.txt) en el SQL Editor (reemplazando el placeholder de `password_hash` y corriendo `SELECT setval(pg_get_serial_sequence('countries', 'id'), COALESCE((SELECT MAX(id) FROM countries), 1));`).
2. Desde `c:\development\trustlink-backend` en PowerShell, corré las **18 migraciones**:
   ```powershell
   cd c:\development\trustlink-backend
   $env:DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
   $env:DB_SSL="true"
   npm run migrate
   ```

---

## Paso 3 — Crear el primer usuario Superadmin Global

Nunca uses un hash de ejemplo en producción. Generá el hash real con `bcryptjs` desde tu terminal local:

```powershell
cd c:\development\trustlink-backend
node -e "console.log(require('bcryptjs').hashSync('TU_CLAVE_SEGURA_2026!', 10))"
```

Luego ejecutá en el **SQL Editor** de Supabase el bloque de la **Sección 11** de [trustlink-production-init.sql](../database/trustlink-production-init.sql) con tu nombre, DNI, correo y el hash generado:

```sql
INSERT INTO public.users (
  country_id, role, first_name, last_name, dni, email, password_hash, phone,
  primary_portal, can_use_resident, can_use_provider, portals_configured, is_active
)
VALUES (
  NULL, 'superadmin', 'Damián', 'Navia', '30123456', 'tu-email@trustlink.com',
  '$2a$10$PEGAR_AQUI_EL_HASH_GENERADO', '+5491112345678',
  'resident', TRUE, TRUE, TRUE, TRUE
)
ON CONFLICT (email) DO NOTHING;
```

---

## Paso 4 — Blindar el acceso público de Supabase (Data API / RLS)

El backend Express se conecta directamente a PostgreSQL mediante `pg.Pool` con el rol `postgres`; **no** utiliza la API REST pública (`PostgREST`) ni la `anon key` desde el frontend.

Para evitar cualquier exposición accidental de tablas a través de PostgREST:
1. En Supabase: **Project Settings → Data API**, deshabilitá el esquema `public` (o restringí el acceso REST).
2. *(Defensa en profundidad)* Ejecutá la **Sección 12** de [trustlink-production-init.sql](../database/trustlink-production-init.sql) para habilitar **Row Level Security (RLS)** en todas las tablas de `public` sin políticas abiertas al rol `anon`.

---

## Paso 5 — Configurar variables de entorno en Railway y Vercel

### Backend en Railway (`trustlink-backend`)
Cargar según [.env.example](../.env.example):
- `NODE_ENV=production`
- `DATABASE_URL=<URI del Session Pooler con ?sslmode=require>`
- `DB_SSL=true`
- `JWT_SECRET=<cadena aleatoria de al menos 32 caracteres>`
- `CORS_ORIGINS=https://<tu-dominio>.vercel.app`
- `PAYMENT_WEBHOOK_SECRET=<secreto HMAC largo>`
- `PAYMENT_GATEWAY_MODE=mock` *(cambiar a `mercadopago` al activar `MP_ACCESS_TOKEN`, `MP_SANDBOX`, `MP_PUBLIC_APP_URL` y `MP_WEBHOOK_URL`)*

### Frontend en Vercel (`trustlink-web`)
- `VITE_API_BASE_URL=https://<tu-backend>.up.railway.app`

---

## Paso 6 — Verificación post-despliegue (Smoke Test)

1. `GET https://<tu-backend>.up.railway.app/health` → debe responder `200 OK`.
2. Revisar logs de Railway: debe aparecer `📦 Conectado a PostgreSQL de TrustLink [Entorno: EXTERNO / CLOUD (SSL)].`
3. Iniciar sesión en el frontend con el **Superadmin** creado en el Paso 3.
4. En **Salud & APIs** (`SystemHealthDashboard`), confirmar:
   - PostgreSQL conectado con latencia saludable.
   - Comunidad inicial visible y posibilidad de dar de alta un nuevo barrio (valida que la secuencia `countries_id_seq` esté sincronizada).
5. En **Branding**, confirmar que carga la identidad inicial (`TrustLink`) y permite guardar cambios.

---

## Alternativa: Migrar tu base local con datos existentes

Si en lugar de empezar vacía querés subir tu base local `trustlink_db` con sus datos actuales:

```powershell
# 1. Exportar dump limpio (sin owners ni privilegios locales)
pg_dump --no-owner --no-privileges -h localhost -U postgres -d trustlink_db -f trustlink_dump.sql

# 2. Importar en Supabase (Session Pooler)
psql "postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require" -f trustlink_dump.sql

# 3. Asegurar que las 18 migraciones evolutivas estén aplicadas
$env:DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
$env:DB_SSL="true"
npm run migrate
```
