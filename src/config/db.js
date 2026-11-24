/**
 * @file db.js
 * @description Configuración del pool de conexiones PostgreSQL para TrustLink.
 * Soporta ejecución transparente en entorno LOCAL (PostgreSQL en localhost) y en
 * entorno EXTERNO / NUBE (Supabase, Neon, Render, etc.) con manejo automático de SSL.
 * @location /trustlink-backend/src/config/db.js
 */

const { Pool } = require('pg');
require('dotenv').config();

/**
 * Construye la cadena de conexión PostgreSQL.
 * Prioriza `DATABASE_URL` si está definida; en caso contrario compone la URI
 * a partir de las variables individuales (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
 * @returns {string} URI de conexión PostgreSQL lista para `pg.Pool`.
 */
const resolveConnectionString = () => {
  if (process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim() !== '') {
    return String(process.env.DATABASE_URL).trim();
  }

  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const database = process.env.DB_NAME || 'trustlink_db';
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';

  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};

const connectionString = resolveConnectionString();

/**
 * Determina si el destino de PostgreSQL corresponde a un entorno externo/cloud que requiere SSL.
 * Respeta overrides explícitos (`DB_SSL=true|false` o `sslmode=require` en la URI) y aplica
 * detección automática para proveedores gestionados (Supabase, Neon, Render) o producción.
 * @param {string} connStr - Cadena de conexión resuelta.
 * @returns {boolean} `true` si debe habilitarse SSL en el pool.
 */
const isExternalDatabase = (connStr) => {
  const lower = String(connStr).toLowerCase();
  const isLocalHost =
    lower.includes('@localhost') ||
    lower.includes('@127.0.0.1') ||
    lower.includes('@[::1]');

  if (process.env.DB_SSL === 'true' || lower.includes('sslmode=require')) {
    return true;
  }

  if (process.env.DB_SSL === 'false') {
    return false;
  }

  // En entornos cloud (Render / producción) o hosts remotos como Supabase/Neon, activar SSL
  return (
    !isLocalHost &&
    (lower.includes('supabase.co') ||
      lower.includes('neon.tech') ||
      lower.includes('render.com') ||
      process.env.NODE_ENV === 'production')
  );
};

// Instanciación del pool compartido; en cloud se acepta certificado gestionado sin CA local
const useSsl = isExternalDatabase(connectionString);

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const environmentLabel = useSsl ? 'EXTERNO / CLOUD (SSL)' : 'LOCAL';

// Eventos de ciclo de vida del pool: trazabilidad de conexión y corte seguro ante error fatal
pool.on('connect', () => {
  console.log(`📦 Conectado a PostgreSQL de TrustLink [Entorno: ${environmentLabel}].`);
});

pool.on('error', (err) => {
  console.error(`❌ Error inesperado en el pool de PostgreSQL [${environmentLabel}]:`, err);
  process.exit(-1);
});

// Interfaz exportada: wrapper `query` para consultas parametrizadas, instancia `pool` y bandera SSL
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  isExternalDatabase: useSsl,
};