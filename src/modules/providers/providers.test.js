/**
 * @file providers.test.js
 * @description Script manual de pruebas de integración para el módulo de prestadores y compliance.
 * Requiere el servidor backend activo en `http://localhost:4000` y acceso a PostgreSQL.
 * Valida alta de perfil documental, registro de vehículo, aprobación administrativa de compliance
 * y visibilidad del prestador en el directorio de residentes.
 * @location /trustlink-backend/src/modules/providers/providers.test.js
 */

const db = require('../../config/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE_URL = 'http://localhost:4000/api/v1/providers';

/**
 * Ejecuta el circuito de pruebas de integración del ciclo de vida de un prestador:
 * - Paso 0: siembra country, admin, residente y usuario prestador en DB con sus tokens JWT.
 * - Prueba 1: carga de perfil documental y compliance (`POST /providers/profile`).
 * - Prueba 2: alta de vehículo de trabajo con seguro (`POST /providers/vehicle`).
 * - Prueba 3: aprobación administrativa del compliance (`PATCH /providers/compliance`).
 * - Prueba 4: consulta del directorio verificado como residente (`GET /providers/directory`).
 * - Limpieza: elimina el country temporal en cascada al finalizar.
 *
 * @returns {Promise<void>} Finaliza tras ejecutar todos los casos y limpiar los registros creados.
 */
async function runProvidersTests() {
  console.log('🧪 Iniciando pruebas automatizadas para el Módulo de Prestadores y Compliance...\n');

  let countryId, adminId, ownerId, providerUserId, providerId;

  try {
    // ----------------------------------------------------
    // PASO 0: Configurar entorno de prueba en la Base de Datos
    // Precondiciones: comunidad de prueba con usuarios para los tres roles intervinientes
    // (`admin`, `owner` y `provider`) y sus correspondientes tokens JWT firmados.
    // ----------------------------------------------------
    console.log('0️⃣ Preparando datos de prueba (Country, Admin User, Owner User, Provider User)...');

    // 1. Crear un Country de prueba
    const countryRes = await db.query(
      'INSERT INTO countries (name, location) VALUES ($1, $2) RETURNING id',
      ['Barrio Cerrado Test Los Robles', 'Acceso Oeste Km 40']
    );
    countryId = countryRes.rows[0].id;

    // 2. Crear usuario Admin del Country
    const adminEmail = `admin.${Date.now()}@test.com`;
    const adminRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone)
       VALUES ($1, 'admin', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [countryId, 'Martin', 'Administrador', `55${Math.floor(100000 + Math.random() * 900000)}`, adminEmail, 'hash_dummy', '11445566']
    );
    adminId = adminRes.rows[0].id;

    // 3. Crear usuario Owner (Residente) para poder consultar el directorio
    const ownerEmail = `owner.${Date.now()}@test.com`;
    const ownerRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone, fraction_number, lot_number)
       VALUES ($1, 'owner', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [countryId, 'Esteban', 'Propietario', `66${Math.floor(100000 + Math.random() * 900000)}`, ownerEmail, 'hash_dummy', '11990011', 'Manzana B', 'Lote 10']
    );
    ownerId = ownerRes.rows[0].id;

    // 4. Crear usuario con rol 'provider'
    const providerEmail = `provider.${Date.now()}@test.com`;
    const providerUserRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone)
       VALUES ($1, 'provider', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [countryId, 'Luciano', 'Gasista', `44${Math.floor(100000 + Math.random() * 900000)}`, providerEmail, 'hash_dummy', '11778899']
    );
    providerUserId = providerUserRes.rows[0].id;

    // Generar tokens JWT firmados para simular sesiones
    const providerToken = jwt.sign({ userId: providerUserId, countryId: countryId, role: 'provider' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const adminToken = jwt.sign({ userId: adminId, countryId: countryId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const ownerToken = jwt.sign({ userId: ownerId, countryId: countryId, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    console.log('✅ Entorno de prueba de prestadores configurado.\n');

    // ----------------------------------------------------
    // PRUEBA 1: Actualizar perfil de prestador y compliance
    // Escenario: el prestador sube especialidad y URLs de antecedentes penales y póliza ART.
    // Resultado esperado: perfil creado con su `provider.id` y estado inicial de revisión.
    // ----------------------------------------------------
    console.log('1️⃣ Probando actualización de perfil y compliance (/providers/profile)...');
    const profileRes = await fetch(`${BASE_URL}/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerToken}`
      },
      body: JSON.stringify({
        specialty: 'Gasista Matriculado',
        criminal_record_url: 'https://storage.trustlink.com/antecedentes_luciano.pdf',
        insurance_policy_url: 'https://storage.trustlink.com/art_luciano.pdf'
      })
    });

    const profileData = await profileRes.json();
    if (profileRes.status === 200 && profileData.provider) {
      console.log('✅ ÉXITO: Perfil de compliance registrado (Estado inicial:', profileData.provider.status, ')');
      providerId = profileData.provider.id;
    } else {
      console.error('❌ FALLÓ EL REGISTRO DE PERFIL:', profileData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 2: Registrar vehículo del prestador
    // Precondición: perfil de prestador ya registrado en la Prueba 1.
    // Resultado esperado: HTTP 201 con el vehículo y patente asociados al prestador.
    // ----------------------------------------------------
    console.log('\n2️⃣ Probando asociación de vehículo de trabajo (/providers/vehicle)...');
    const vehicleRes = await fetch(`${BASE_URL}/vehicle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerToken}`
      },
      body: JSON.stringify({
        brand: 'Ford',
        model: 'Fiorino',
        color: 'Gris',
        plate: `XYZ${Math.floor(100 + Math.random() * 900)}`,
        vehicle_insurance_url: 'https://storage.trustlink.com/seguro_vehiculo.pdf'
      })
    });

    const vehicleData = await vehicleRes.json();
    if (vehicleRes.status === 201 && vehicleData.vehicle) {
      console.log('✅ ÉXITO: Vehículo asociado correctamente con patente:', vehicleData.vehicle.plate);
    } else {
      console.error('❌ FALLÓ LA ASOCIACIÓN DE VEHÍCULO:', vehicleData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 3: Aprobación administrativa del Compliance
    // Escenario: un administrador del barrio revisa la documentación y aprueba al prestador.
    // Resultado esperado: HTTP 200 y transición del estado del perfil a `'approved'`.
    // ----------------------------------------------------
    console.log('\n3️⃣ Probando aprobación de compliance por Admin (/providers/compliance)...');
    const complianceRes = await fetch(`${BASE_URL}/compliance`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        provider_id: providerId,
        status: 'approved'
      })
    });

    const complianceData = await complianceRes.json();
    if (complianceRes.status === 200 && complianceData.provider.status === 'approved') {
      console.log('✅ ÉXITO: La administración aprobó el compliance del prestador.');
    } else {
      console.error('❌ FALLÓ LA APROBACIÓN ADMINISTRATIVA:', complianceData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 4: Listar directorio de prestadores verificados (Usando token de Owner)
    // Precondición: prestador aprobado en la Prueba 3.
    // Resultado esperado: HTTP 200 con al menos un prestador verificado visible (`count > 0`).
    // ----------------------------------------------------
    console.log('\n4️⃣ Probando directorio de prestadores verificados (/providers/directory)...');
    const directoryRes = await fetch(`${BASE_URL}/directory`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ownerToken}` // Correcto: Consultando como residente autorizado
      }
    });

    const directoryData = await directoryRes.json();
    if (directoryRes.status === 200 && directoryData.count > 0) {
      console.log('✅ ÉXITO: Directorio obtenido correctamente. Prestadores verificados:', directoryData.count);
    } else {
      console.error('❌ FALLÓ LA OBTENCIÓN DEL DIRECTORIO:', directoryData);
      return;
    }

    console.log('\n🎉 ¡Todas las pruebas del Módulo de Prestadores pasaron exitosamente al 100%!');

  } catch (error) {
    console.error('❌ Error de ejecución en las pruebas de prestadores:', error);
  } finally {
    // Limpieza de datos en cascada
    if (countryId) {
      await db.query('DELETE FROM countries WHERE id = $1', [countryId]);
      console.log('🧹 Limpieza de datos de prueba completada.');
    }
  }
}

// Punto de entrada al ejecutar el script de forma independiente
runProvidersTests();