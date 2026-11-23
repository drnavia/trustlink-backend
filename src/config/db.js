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
 * Construye la cadena de conexión a partir de DATABASE_URL o variables DB_* individuales.
 * @returns {string}
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
 * Determina si el destino de PostgreSQL es local o externo/en la nube.
 * @param {string} connStr
 * @returns {boolean}
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

const useSsl = isExternalDatabase(connectionString);

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const environmentLabel = useSsl ? 'EXTERNO / CLOUD (SSL)' : 'LOCAL';

pool.on('connect', () => {
  console.log(`📦 Conectado a PostgreSQL de TrustLink [Entorno: ${environmentLabel}].`);
});

pool.on('error', (err) => {
  console.error(`❌ Error inesperado en el pool de PostgreSQL [${environmentLabel}]:`, err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  isExternalDatabase: useSsl,
};