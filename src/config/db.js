/**
 * @file db.js
 * @description Configuración del pool de conexiones para PostgreSQL utilizando variables de entorno.
 * @location /trustlink-backend/src/config/db.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
  console.log('📦 Conectado exitosamente a la base de datos PostgreSQL.');
});

pool.on('error', (err) => {
  console.error('❌ Error crítico en el pool de PostgreSQL:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};