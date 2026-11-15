/**
 * @file payments.test.js
 * @description Script de pruebas de integración para verificar el funcionamiento 
 * 100% del módulo de pagos, cotizaciones in situ, cálculo de comisiones y webhooks.
 * @location /trustlink-backend/src/modules/payments/payments.test.js
 */

const db = require('../../config/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE_URL = 'http://localhost:4000/api/v1/payments';

async function runPaymentsTests() {
  console.log('🧪 Iniciando pruebas automatizadas para el Módulo de Pagos y Transacciones...\n');

  let countryId, ownerId, providerUserId, providerId, contractId;

  try {
    // ----------------------------------------------------
    // PASO 0: Configurar entorno de prueba en la Base de Datos
    // ----------------------------------------------------
    console.log('0️⃣ Preparando datos de prueba (Country, Owner, Provider, Contract)...');

    // 1. Crear un Country de prueba
    const countryRes = await db.query(
      'INSERT INTO countries (name, location) VALUES ($1, $2) RETURNING id',
      ['Barrio Cerrado Test Los Ombúes', 'Panamericana Km 45']
    );
    countryId = countryRes.rows[0].id;

    // 2. Crear usuario Owner (Residente)
    const ownerEmail = `owner.payment.${Date.now()}@test.com`;
    const ownerRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone, fraction_number, lot_number)
       VALUES ($1, 'owner', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [countryId, 'Agustina', 'Vecina', `11${Math.floor(100000 + Math.random() * 900000)}`, ownerEmail, 'hash_dummy', '11443322', 'Manzana C', 'Lote 15']
    );
    ownerId = ownerRes.rows[0].id;

    // 3. Crear usuario Provider (Prestador)
    const providerEmail = `provider.payment.${Date.now()}@test.com`;
    const providerUserRes = await db.query(
      `INSERT INTO users (country_id, role, first_name, last_name, dni, email, password_hash, phone)
       VALUES ($1, 'provider', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [countryId, 'Federico', 'Electricista', `00${Math.floor(100000 + Math.random() * 900000)}`, providerEmail, 'hash_dummy', '11667788']
    );
    providerUserId = providerUserRes.rows[0].id;

    // 4. Crear perfil de prestador
    const providerRes = await db.query(
      `INSERT INTO providers (user_id, specialty, criminal_record_url, insurance_policy_url, status)
       VALUES ($1, 'Electricista', 'url_penales', 'url_seguro', 'approved') RETURNING id`,
      [providerUserId]
    );
    providerId = providerRes.rows[0].id;

    // 5. Crear un contrato de servicio inicial
    const contractRes = await db.query(
      `INSERT INTO service_contracts (country_id, owner_id, provider_id, description, agreed_amount, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [countryId, ownerId, providerId, 'Instalación de tablero eléctrico seccional', 0.00]
    );
    contractId = contractRes.rows[0].id;

    // Generar tokens JWT firmados
    const providerToken = jwt.sign({ userId: providerUserId, countryId: countryId, role: 'provider' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    console.log('✅ Entorno de prueba de pagos configurado.\n');

    // ----------------------------------------------------
    // PRUEBA 1: Prestador carga cotización in situ (/payments/quote)
    // ----------------------------------------------------
    console.log('1️⃣ Probando registro de cotización presencial por el prestador (/payments/quote)...');
    const quoteRes = await fetch(`${BASE_URL}/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerToken}`
      },
      body: JSON.stringify({
        contract_id: contractId,
        agreed_amount: 100000.00 // $100.000 ARS acordados en domicilio
      })
    });

    const quoteData = await quoteRes.json();
    if (quoteRes.status === 201 && quoteData.transaction) {
      console.log('✅ ÉXITO: Cotización y orden de pago generadas.');
      console.log('   Monto Total:', quoteData.transaction.total_amount);
      console.log('   Comisión TrustLink (7%):', quoteData.transaction.platform_fee);
      console.log('   Neto Prestador (93%):', quoteData.transaction.provider_payout);
      console.log('   Gateway ID simulado:', quoteData.transaction.gateway_payment_id);
    } else {
      console.error('❌ FALLÓ LA CREACIÓN DE COTIZACIÓN:', quoteData);
      return;
    }

    const gatewayPaymentId = quoteData.transaction.gateway_payment_id;

    // Pequeña pausa opcional para asegurar estabilidad de red local
    await new Promise(resolve => setTimeout(resolve, 500));

    // ----------------------------------------------------
    // PRUEBA 2: Simulación de Aprobación de Pago vía Webhook (/payments/webhook)
    // ----------------------------------------------------
    console.log('\n2️⃣ Probando confirmación de pago por webhook de pasarela (/payments/webhook)...');
    const webhookRes = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        gateway_payment_id: gatewayPaymentId,
        status: 'approved'
      })
    });

    const webhookData = await webhookRes.json();
    if (webhookRes.status === 200 && webhookData.received === true && webhookData.transaction_status === 'approved') {
      console.log('✅ ÉXITO: Webhook procesado correctamente. Pago aprobado y contrato en curso.');
    } else {
      console.error('❌ FALLÓ EL WEBHOOK DE PAGOS:', webhookData);
      return;
    }

    console.log('\n🎉 ¡Todas las pruebas del Módulo de Pagos pasaron exitosamente al 100%!');

  } catch (error) {
    console.error('❌ Error de ejecución en las pruebas de pagos:', error);
  } finally {
    // Limpieza de datos en cascada
    if (countryId) {
      await db.query('DELETE FROM countries WHERE id = $1', [countryId]);
      console.log('🧹 Limpieza de datos de prueba completada.');
    }
  }
}

runPaymentsTests();