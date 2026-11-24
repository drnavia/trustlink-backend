/**
 * @file reviews.test.js
 * @description Script manual de pruebas de integración para el módulo de contratos y calificaciones.
 * Requiere el servidor backend activo en `http://localhost:4000` y acceso a PostgreSQL.
 * Verifica alta de contrato, bloqueo de reseñas prematuras sobre contratos pendientes,
 * cierre del contrato y emisión de calificación con recálculo de reputación.
 * @location /trustlink-backend/src/modules/reviews/reviews.test.js
 */

const db = require('../../config/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE_URL = 'http://localhost:4000/api/v1/reviews';

/**
 * Ejecuta el circuito de pruebas de integración de contratos y reputación:
 * - Paso 0: siembra country, residente y prestador aprobado en DB y firma JWT de residente.
 * - Prueba 1: creación de contrato de servicio (`POST /reviews/contract`).
 * - Prueba 2: bloqueo de calificación prematura sobre contrato pendiente (`400`).
 * - Prueba 3: marcado del contrato como completado (`PATCH /reviews/contract/complete`).
 * - Prueba 4: emisión de reseña y recálculo de reputación del prestador (`POST /reviews/review`).
 * - Limpieza: elimina el country temporal en cascada dentro del bloque `finally`.
 *
 * @returns {Promise<void>} Finaliza tras comprobar todos los escenarios y limpiar la DB.
 */
async function runReviewsTests() {
  console.log('🧪 Iniciando pruebas automatizadas para el Módulo de Calificaciones y Reputación...\n');

  let countryId, ownerId, providerUserId, providerId, contractId;

  try {
    // ----------------------------------------------------
    // PASO 0: Configurar entorno de prueba en la Base de Datos
    // Precondiciones: barrio de prueba, residente y prestador aprobado con JWT de residente.
    // ----------------------------------------------------
    console.log('0️⃣ Preparando datos de prueba (Country, Owner, Provider)...');

    // 1. Crear un Country de prueba
    const countryRes = await db.query(
      'INSERT INTO countries (name, location) VALUES ($1, $2) RETURNING id',
      ['Barrio Cerrado Test Las Calandrias', 'Ezeiza Km 35']
    );
    countryId = countryRes.rows[0].id;

    // 2. Crear usuario Owner (Residente)
    const ownerEmail = `owner.review.${Date.now()}@test.com`;
    const ownerRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone, fraction_number, lot_number)
       VALUES ($1, 'owner', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [countryId, 'Valeria', 'Dueña', `33${Math.floor(100000 + Math.random() * 900000)}`, ownerEmail, 'hash_dummy', '11556677', 'Sector B', 'Lote 22']
    );
    ownerId = ownerRes.rows[0].id;

    // 3. Crear usuario Provider (Prestador)
    const providerEmail = `provider.review.${Date.now()}@test.com`;
    const providerUserRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone)
       VALUES ($1, 'provider', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [countryId, 'Marcos', 'Plomero', `22${Math.floor(100000 + Math.random() * 900000)}`, providerEmail, 'hash_dummy', '11889900']
    );
    providerUserId = providerUserRes.rows[0].id;

    // 4. Crear perfil de prestador
    const providerRes = await db.query(
      `INSERT INTO providers (user_id, specialty, criminal_record_url, insurance_policy_url, status)
       VALUES ($1, 'Plomero', 'url_penales', 'url_seguro', 'approved') RETURNING id`,
      [providerUserId]
    );
    providerId = providerRes.rows[0].id;

    // Generar tokens JWT firmados
    const ownerToken = jwt.sign({ userId: ownerId, countryId: countryId, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    console.log('✅ Entorno de prueba de calificaciones configurado.\n');

    // ----------------------------------------------------
    // PRUEBA 1: Crear contrato de servicio
    // Escenario: un residente acuerda un trabajo de plomería con un prestador aprobado.
    // Resultado esperado: HTTP 201 con objeto `contract` persistido y su `id`.
    // ----------------------------------------------------
    console.log('1️⃣ Probando creación de contrato de servicio (/reviews/contract)...');
    const contractRes = await fetch(`${BASE_URL}/contract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        provider_id: providerId,
        description: 'Reparación de válvula principal de agua',
        agreed_amount: 45000.00
      })
    });

    const contractData = await contractRes.json();
    if (contractRes.status === 201 && contractData.contract) {
      console.log('✅ ÉXITO: Contrato registrado con ID:', contractData.contract.id);
      contractId = contractData.contract.id;
    } else {
      console.error('❌ FALLÓ LA CREACIÓN DEL CONTRATO:', contractData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 2: Intentar calificar un contrato pendiente (Debe fallar por regla de negocio)
    // Precondición: contrato recién creado aún no finalizado.
    // Resultado esperado: HTTP 400 impidiendo calificar servicios inconclusos.
    // ----------------------------------------------------
    console.log('\n2️⃣ Probando restricción: Intentar calificar un contrato pendiente...');
    const prematureReviewRes = await fetch(`${BASE_URL}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        contract_id: contractId,
        rating: 5,
        comment: 'Excelente trabajo'
      })
    });

    const prematureData = await prematureReviewRes.json();
    if (prematureReviewRes.status === 400) {
      console.log('✅ ÉXITO: El sistema bloqueó correctamente la calificación prematura:', prematureData.error);
    } else {
      console.error('❌ FALLÓ LA RESTRICCIÓN DE NEGOCIO:', prematureData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 3: Marcar contrato como completado
    // Escenario: el residente confirma la finalización del trabajo para habilitar la reseña.
    // Resultado esperado: HTTP 200 y `contract.status === 'completed'`.
    // ----------------------------------------------------
    console.log('\n3️⃣ Probando marcar contrato como completado (/reviews/contract/complete)...');
    const completeRes = await fetch(`${BASE_URL}/contract/complete`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`
      },
      body: JSON.stringify({ contract_id: contractId })
    });

    const completeData = await completeRes.json();
    if (completeRes.status === 200 && completeData.contract.status === 'completed') {
      console.log('✅ ÉXITO: Contrato marcado como completado.');
    } else {
      console.error('❌ FALLÓ AL COMPLETAR EL CONTRATO:', completeData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 4: Emitir calificación y reseña (Ahora sí permitido)
    // Precondición: contrato en estado `completed` tras la Prueba 3.
    // Resultado esperado: HTTP 201 con la reseña guardada y el promedio actualizado del prestador.
    // ----------------------------------------------------
    console.log('\n4️⃣ Probando emisión de reseña y actualización de reputación (/reviews/review)...');
    const reviewRes = await fetch(`${BASE_URL}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        contract_id: contractId,
        rating: 5,
        comment: '¡Impecable, llegó a horario y solucionó todo perfecto!'
      })
    });

    const reviewData = await reviewRes.json();
    if (reviewRes.status === 201 && reviewData.review) {
      console.log('✅ ÉXITO: Reseña registrada correctamente.');
      console.log('   Nuevo promedio de estrellas del prestador:', reviewData.updated_provider_rating);
    } else {
      console.error('❌ FALLÓ LA EMISIÓN DE RESEÑA:', reviewData);
      return;
    }

    console.log('\n🎉 ¡Todas las pruebas del Módulo de Calificaciones pasaron exitosamente al 100%!');

  } catch (error) {
    console.error('❌ Error de ejecución en las pruebas de calificaciones:', error);
  } finally {
    // Limpieza de datos en cascada
    if (countryId) {
      await db.query('DELETE FROM countries WHERE id = $1', [countryId]);
      console.log('🧹 Limpieza de datos de prueba completada.');
    }
  }
}

// Punto de entrada al invocar el script directamente
runReviewsTests();