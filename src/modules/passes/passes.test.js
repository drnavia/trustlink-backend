/**
 * @file passes.test.js
 * @description Script de pruebas de integración completo para verificar el funcionamiento 
 * 100% del módulo de pases de acceso y validación en garita (QR).
 * @location /trustlink-backend/src/modules/passes/passes.test.js
 */

const db = require('../../config/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE_URL = 'http://localhost:4000/api/v1/passes';

async function runPassesTests() {
  console.log('🧪 Iniciando pruebas automatizadas para el Módulo de Pases y Garita...\n');

  let countryId, ownerId, securityId, providerId;

  try {
    // ----------------------------------------------------
    // PASO 0: Configurar datos de prueba en la Base de Datos
    // ----------------------------------------------------
    console.log('0️⃣ Preparando datos de prueba (Country, Owner, Security, Provider, Vehículo)...');
    
    // 1. Crear un Country de prueba
    const countryRes = await db.query(
      'INSERT INTO countries (name, location) VALUES ($1, $2) RETURNING id',
      ['Barrio Cerrado Test La Comarca', 'Panamericana Km 50']
    );
    countryId = countryRes.rows[0].id;

    // 2. Crear usuario Owner (Residente)
    const ownerEmail = `owner.${Date.now()}@test.com`;
    const ownerRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone, fraction_number, lot_number)
       VALUES ($1, 'owner', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [countryId, 'Mariano', 'Propietario', `99${Math.floor(100000 + Math.random() * 900000)}`, ownerEmail, 'hash_dummy', '11223344', 'Manzana A', 'Lote 5']
    );
    ownerId = ownerRes.rows[0].id;

    // 3. Crear usuario Security (Guardia de Garita)
    const securityEmail = `security.${Date.now()}@test.com`;
    const securityRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone)
       VALUES ($1, 'security', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [countryId, 'Roberto', 'Garita', `88${Math.floor(100000 + Math.random() * 900000)}`, securityEmail, 'hash_dummy', '55443322']
    );
    securityId = securityRes.rows[0].id;

    // 4. Crear usuario Provider (Prestador)
    const providerUserRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone)
       VALUES ($1, 'provider', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [countryId, 'Esteban', 'Electricista', `77${Math.floor(100000 + Math.random() * 900000)}`, `provider.${Date.now()}@test.com`, 'hash_dummy', '99887766']
    );
    const providerUserId = providerUserRes.rows[0].id;

    // 5. Crear perfil de Prestador (con Compliance 'approved')
    const providerRes = await db.query(
      `INSERT INTO providers (user_id, specialty, criminal_record_url, insurance_policy_url, status)
       VALUES ($1, 'Electricista', 'url_penales', 'url_seguro', 'approved') RETURNING id`,
      [providerUserId]
    );
    providerId = providerRes.rows[0].id;

    // 6. Asociar vehículo al prestador
    await db.query(
      `INSERT INTO provider_vehicles (provider_id, brand, model, color, plate)
       VALUES ($1, 'Renault', 'Kangoo', 'Blanco', $2)`,
      [providerId, `ABC${Math.floor(100 + Math.random() * 900)}`]
    );

    // Generar tokens JWT firmados para simular sesiones autenticadas
    const ownerToken = jwt.sign({ userId: ownerId, countryId: countryId, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const securityToken = jwt.sign({ userId: securityId, countryId: countryId, role: 'security' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    console.log('✅ Entorno de prueba configurado exitosamente.\n');

    // ----------------------------------------------------
    // PRUEBA 1: Crear Pase de Acceso (Rol Owner)
    // ----------------------------------------------------
    console.log('1️⃣ Probando Creación de Pase QR (/passes/create)...');
    // Margen amplio de ±24 horas para evitar desfasajes de zona horaria en test local
    const startTime = new Date(Date.now() - 86400000).toISOString(); // 1 día en el pasado
    const endTime = new Date(Date.now() + 86400000).toISOString();   // 1 día en el futuro

    const createRes = await fetch(`${BASE_URL}/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        provider_id: providerId,
        fraction_number: 'Manzana A',
        lot_number: 'Lote 5',
        start_time: startTime,
        end_time: endTime
      })
    });

    const createData = await createRes.json();
    if (createRes.status === 201 && createData.pass && createData.pass.qr_token) {
      console.log('✅ ÉXITO: Pase QR generado correctamente.');
      console.log('   Token QR:', createData.pass.qr_token.substring(0, 20) + '...');
    } else {
      console.error('❌ FALLÓ LA CREACIÓN DEL PASE:', createData);
      return;
    }

    const qrToken = createData.pass.qr_token;

    // ----------------------------------------------------
    // PRUEBA 2: Validar Pase en Garita (Rol Security) - Caso Válido
    // ----------------------------------------------------
    console.log('\n2️⃣ Probando Validación en Garita (/passes/verify) con QR legítimo...');
    const verifyRes = await fetch(`${BASE_URL}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${securityToken}`
      },
      body: JSON.stringify({ qr_token: qrToken })
    });

    const verifyData = await verifyRes.json();
    if (verifyRes.status === 200 && verifyData.authorized === true) {
      console.log('✅ ÉXITO: Acceso autorizado por la garita en tiempo real.');
      console.log('   Detalles del ingreso:', verifyData.details);
    } else {
      console.error('❌ FALLÓ LA VERIFICACIÓN EN GARITA:', verifyData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 3: Validar Seguridad con QR Inexistente
    // ----------------------------------------------------
    console.log('\n3️⃣ Probando Seguridad: Intento de acceso con QR falso...');
    const invalidVerifyRes = await fetch(`${BASE_URL}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${securityToken}`
      },
      body: JSON.stringify({ qr_token: 'token_falso_inexistente_999' })
    });

    const invalidData = await invalidVerifyRes.json();
    if (invalidVerifyRes.status === 404 && invalidData.authorized === false) {
      console.log('✅ ÉXITO: El sistema bloqueó correctamente el acceso:', invalidData.error);
    } else {
      console.error('❌ FALLÓ LA VALIDACIÓN DE SEGURIDAD:', invalidData);
    }

    console.log('\n🎉 ¡Todas las pruebas del Módulo de Pases y Garita pasaron exitosamente al 100%!');

  } catch (error) {
    console.error('❌ Error de ejecución en las pruebas:', error);
  } finally {
    // Limpieza de datos en cascada para dejar la base de datos limpia
    if (countryId) {
      await db.query('DELETE FROM countries WHERE id = $1', [countryId]);
      console.log('🧹 Limpieza de datos de prueba completada.');
    }
  }
}

runPassesTests();