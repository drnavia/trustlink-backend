/**
 * @file e2e.test.js
 * @description Suite automatizada de pruebas de integración end-to-end para TrustLink Backend
 * usando el runner nativo `node:test`. Levanta una instancia aislada del servidor en un puerto
 * temporal, recorre de forma secuencial todos los flujos críticos del negocio (auth, compliance,
 * flota, visitas, pases QR y garita interna/externa, contratos, pagos 7%/93%, webhooks HMAC y MP,
 * identidad dual, cuadrillas, vencimientos documentales, membresías, licenciamiento B2B, escrow,
 * reclamos/garantía y visibilidad por especialidad) y limpia los registros temporales al finalizar.
 * @location /trustlink-backend/test/e2e.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });

const jwt = require('jsonwebtoken');
const db = require('../src/config/db');

// Configuración aislada para el servidor temporal y el secreto de firma de webhooks en pruebas
const PORT = Number(process.env.TEST_PORT || 4197);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = 'tlk_e2e_webhook_secret';

/**
 * Pausa la ejecución asíncrona durante un intervalo en milisegundos.
 * Se utiliza para espaciar los reintentos de polling contra `/health` durante el arranque del servidor.
 *
 * @param {number} ms - Duración de la espera en milisegundos.
 * @returns {Promise<void>} Promesa que resuelve al cumplirse el tiempo indicado.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cliente HTTP liviano para invocar endpoints de la instancia E2E del backend.
 * Serializa automáticamente cuerpos objeto a JSON (respetando cadenas crudas cuando se firma HMAC),
 * adjunta autenticación Bearer opcional y parsea la respuesta JSON tolerando cuerpos vacíos.
 *
 * @param {string} method - Verbo HTTP (`GET`, `POST`, `PATCH`, `DELETE`, etc.).
 * @param {string} urlPath - Ruta relativa al servidor base (por ejemplo `/api/v1/auth/login`).
 * @param {object|string|undefined} [body] - Payload a enviar; si es string se transmite sin re-serializar.
 * @param {string|null} [token] - Token JWT para cabecera `Authorization: Bearer <token>`.
 * @param {Record<string, string>} [extraHeaders={}] - Cabeceras adicionales (firmas webhook, API keys, etc.).
 * @returns {Promise<{status: number, ok: boolean, data: any}>} Estado HTTP, bandera `ok` y JSON parseado.
 */
async function req(method, urlPath, body, token, extraHeaders = {}) {
  const rawBody =
    body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// Suite secuencial de extremo a extremo: cada caso reutiliza tokens, usuarios y entidades
// construidas en fases previas para validar el ciclo de vida completo de la plataforma.
describe('TrustLink Backend — E2E Core Suite', () => {
  // Estado compartido a lo largo de la corrida E2E y lista de IDs a depurar en `after`
  let serverProc;
  let countryId;
  let createdCountryId = null;
  const createdUserIds = [];

  let superToken;
  let superRealToken;
  let ownerToken;
  let ownerUserId;
  let provToken;
  let secToken;
  let providerId;
  let vehicleId;
  let pass1Id;
  let pass1Qr;
  let pass2Qr;
  let contractId;

  // Marca de tiempo única por corrida para generar emails, DNIs y patentes sin colisiones
  const ts = Date.now();

  // Hook de inicialización: levanta `src/server.js` en un puerto aislado con secreto de webhook propio,
  // espera a que `/health` responda ONLINE, obtiene/crea una comunidad base y firma un JWT superadmin.
  before(async () => {
    serverProc = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: String(PORT), PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET },
      stdio: 'ignore',
    });

    // Polling de disponibilidad del servidor hasta 30 intentos (máximo ~7.5s)
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await req('GET', '/health');
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await sleep(250);
    }
    assert.equal(healthy, true, 'El servidor backend no respondió en /health');

    // Reutiliza una comunidad existente para no alterar datos reales o siembra una temporal si la DB está vacía
    const existingCountry = await db.query('SELECT id FROM countries ORDER BY id ASC LIMIT 1');
    if (existingCountry.rows.length > 0) {
      countryId = existingCountry.rows[0].id;
    } else {
      const c = await db.query(
        "INSERT INTO countries (name, location) VALUES ('E2E Community', 'Test') RETURNING id"
      );
      countryId = c.rows[0].id;
      createdCountryId = countryId;
    }

    // Token administrativo sintético utilizado para operaciones de backoffice/superadmin en los tests
    superToken = jwt.sign(
      { userId: 1, countryId, role: 'superadmin', email: 'e2e-super@trustlink.local' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  // Hook de cierre: elimina todos los registros temporales creados durante la suite (logs de garita,
  // solicitudes de visita, bloqueos de agenda, usuarios y comunidad temporal si correspondió),
  // detiene el proceso hijo del servidor y cierra el pool de conexiones PostgreSQL.
  after(async () => {
    try {
      if (createdUserIds.length > 0) {
        await db
          .query(
            'DELETE FROM gate_access_logs WHERE pass_id IN (SELECT id FROM access_passes WHERE owner_id = ANY($1::int[]))',
            [createdUserIds]
          )
          .catch(() => {});
        await db
          .query('DELETE FROM visit_requests WHERE owner_id = ANY($1::int[])', [createdUserIds])
          .catch(() => {});
        await db
          .query(
            'DELETE FROM provider_schedule_blocks WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ANY($1::int[]))',
            [createdUserIds]
          )
          .catch(() => {});
        await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]).catch(() => {});
      }
      if (createdCountryId) {
        await db.query('DELETE FROM countries WHERE id = $1', [createdCountryId]).catch(() => {});
      }
    } finally {
      if (serverProc) serverProc.kill();
      await db.pool.end().catch(() => {});
    }
  });

  // =========================================================================
  // FASE 1: Endpoints públicos, control de roles y registro de actores base
  // =========================================================================

  // Escenario: disponibilidad del servicio y consulta pública del catálogo de barrios para onboarding.
  // Precondiciones: servidor levantado con al menos una comunidad registrada en DB.
  // Resultado esperado: `/health` responde 200 `ONLINE` y `/auth/countries` devuelve lista no vacía.
  it('expone /health y catálogo público de comunidades en GET /api/v1/auth/countries', async () => {
    const h = await req('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.data.status, 'ONLINE');

    const c = await req('GET', '/api/v1/auth/countries');
    assert.equal(c.status, 200);
    assert.equal(Array.isArray(c.data.countries), true);
    assert.ok(c.data.countries.length >= 1);
  });

  // Escenario: prevención de escalación de privilegios en registro abierto y alta controlada de guardia.
  // Precondiciones: token `superToken` vigente para invocar el endpoint protegido `/auth/users/privileged`.
  // Resultado esperado: rechaza con 403 el registro público de `superadmin`, `admin` y `security`;
  // permite crear el usuario `security` autenticado como superadmin y obtener su `secToken` por login.
  it('bloquea registro público de roles privilegiados y permite alta protegida de security', async () => {
    // 1. Verificar que ningún rol privilegiado puede auto-registrarse en /register
    for (const forbiddenRole of ['superadmin', 'admin', 'security']) {
      const r = await req('POST', '/api/v1/auth/register', {
        role: forbiddenRole,
        first_name: 'Test',
        last_name: 'Blocked',
        dni: `8${forbiddenRole.length}${String(ts).slice(-6)}`,
        email: `blocked.${forbiddenRole}.${ts}@test.local`,
        password: 'Password123!',
      });
      assert.equal(r.status, 403, `Rol ${forbiddenRole} debería devolver 403 en /register`);
    }

    // 2. Dar de alta usuario de garita (security) mediante endpoint privilegiado y autenticarlo
    const secEmail = `e2e.sec.${ts}@test.local`;
    const createdSec = await req(
      'POST',
      '/api/v1/auth/users/privileged',
      {
        country_id: countryId,
        role: 'security',
        first_name: 'Luis',
        last_name: 'Garita',
        dni: `83${String(ts).slice(-6)}`,
        email: secEmail,
        password: 'Password123!',
      },
      superToken
    );
    assert.equal(createdSec.status, 201);
    assert.equal(createdSec.data.user.role, 'security');
    createdUserIds.push(createdSec.data.user.id);

    const loginSec = await req('POST', '/api/v1/auth/login', {
      email: secEmail,
      password: 'Password123!',
    });
    assert.equal(loginSec.status, 200);
    secToken = loginSec.data.token;
  });

  // Escenario: alta pública de residente (`owner`) y prestador (`provider`) e inicio de sesión.
  // Precondiciones: `countryId` existente y credenciales únicas basadas en `ts`.
  // Resultado esperado: crea ambos usuarios, devuelve ubicación normalizada (`fraction_type`,
  // `fraction_number`, `lot_number`) en el login del residente y guarda `ownerToken`, `provToken`
  // y `superRealToken` (respaldado por un `userId` real en DB para claves foráneas de auditoría).
  it('registra owner y provider con ubicación normalizada y devuelve perfil enriquecido en login', async () => {
    // 1. Registro y login del residente con fracción/manzana y lote normalizados
    const ownerEmail = `e2e.owner.${ts}@test.local`;
    const regOwner = await req('POST', '/api/v1/auth/register', {
      country_id: countryId,
      role: 'owner',
      first_name: 'Ana',
      last_name: 'Residente',
      dni: `81${String(ts).slice(-6)}`,
      email: ownerEmail,
      password: 'Password123!',
      fraction_type: 'manzana',
      fraction_number: '4',
      lot_number: '18',
    });
    assert.equal(regOwner.status, 201);
    ownerUserId = regOwner.data.user.id;
    createdUserIds.push(ownerUserId);

    const loginOwner = await req('POST', '/api/v1/auth/login', {
      email: ownerEmail,
      password: 'Password123!',
    });
    assert.equal(loginOwner.status, 200);
    assert.equal(loginOwner.data.user.fraction_type, 'manzana');
    assert.equal(loginOwner.data.user.fraction_number, '4');
    assert.equal(loginOwner.data.user.lot_number, '18');
    ownerToken = loginOwner.data.token;

    // Token superadmin vinculado a un userId existente en DB (requerido por FKs como created_by en suspensiones)
    superRealToken = jwt.sign(
      { userId: ownerUserId, countryId, role: 'superadmin', email: ownerEmail },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // 2. Registro y login del prestador de servicios
    const provEmail = `e2e.prov.${ts}@test.local`;
    const regProv = await req('POST', '/api/v1/auth/register', {
      country_id: countryId,
      role: 'provider',
      first_name: 'Juan',
      last_name: 'Prestador',
      dni: `82${String(ts).slice(-6)}`,
      email: provEmail,
      password: 'Password123!',
    });
    assert.equal(regProv.status, 201);
    createdUserIds.push(regProv.data.user.id);

    const loginProv = await req('POST', '/api/v1/auth/login', {
      email: provEmail,
      password: 'Password123!',
    });
    assert.equal(loginProv.status, 200);
    provToken = loginProv.data.token;
  });

  // =========================================================================
  // FASE 2: Onboarding documental del prestador, flota vehicular y compliance
  // =========================================================================

  // Escenario: carga y edición de legajo profesional/flota del prestador y aprobación administrativa.
  // Precondiciones: prestador autenticado (`provToken`) y superadmin (`superToken`).
  // Resultado esperado: crea y actualiza perfil documental y vehículo con póliza vigente, y transiciona
  // el compliance del prestador a `'approved'` habilitándolo para recibir visitas y pases QR.
  it('gestiona perfil documental (POST/PATCH), flota con seguro (POST/PATCH) y aprobación compliance', async () => {
    // 1. Alta y actualización de perfil de especialidad y documentos (antecedentes + ART)
    const prof = await req(
      'POST',
      '/api/v1/providers/profile',
      {
        specialty: 'Electricista',
        criminal_record_url: 'https://example.com/penales.pdf',
        insurance_policy_url: 'https://example.com/art.pdf',
      },
      provToken
    );
    assert.equal(prof.status, 201);
    providerId = prof.data.provider.id;

    const patchProf = await req(
      'PATCH',
      `/api/v1/providers/profile/${providerId}`,
      { specialty: 'Electricista Matriculado' },
      provToken
    );
    assert.equal(patchProf.status, 200);

    // 2. Alta y edición de vehículo de flota con póliza de seguro y vigencia
    const plate = `E2${String(ts).slice(-5)}`;
    const veh = await req(
      'POST',
      '/api/v1/providers/vehicle',
      {
        vehicle_type: 'utilitario',
        brand: 'Renault',
        model: 'Kangoo',
        color: 'Blanco',
        plate,
        vehicle_insurance_url: 'https://example.com/seguro-auto.pdf',
        vehicle_insurance_from: '2026-01-01',
        vehicle_insurance_expiry: '2027-01-01',
      },
      provToken
    );
    assert.equal(veh.status, 201);
    vehicleId = veh.data.vehicle.id;

    const editVeh = await req(
      'PATCH',
      `/api/v1/providers/vehicle/${vehicleId}`,
      { color: 'Gris', vehicle_insurance_url: 'https://example.com/seguro-auto-v2.pdf' },
      provToken
    );
    assert.equal(editVeh.status, 200);
    assert.equal(editVeh.data.vehicle.color, 'Gris');

    // 3. Aprobación de compliance por backoffice para habilitar operación en comunidad
    const approve = await req(
      'PATCH',
      '/api/v1/providers/compliance',
      { provider_id: providerId, status: 'approved' },
      superToken
    );
    assert.equal(approve.status, 200);
  });

  // =========================================================================
  // FASE 3: Coordinación de visitas, Pases QR y seguridad en garita interna/externa
  // =========================================================================

  // Escenario: flujo completo de visita -> pase QR editable -> validación de un solo uso en garita
  // interna y bloqueo/levantamiento por suspensión local de comunidad en garita externa.
  // Precondiciones: prestador aprobado (`providerId`), residente (`ownerToken`), guardia (`secToken`)
  // y administrador (`superRealToken`).
  // Resultado esperado: confirma visita, emite y edita pase 1, lo consume en garita interna rechazando
  // reescaneo (`PASS_ALREADY_USED`), bloquea pase 2 ante suspensión local (`LOCAL_SUSPENSION_ACTIVE`)
  // y tras levantar la suspensión autoriza una única vez en `/external/passes/verify`.
  it('coordina visitas, emite/edita pases QR y aplica ingreso único + suspensión local en ambas garitas', async () => {
    // 1. Solicitud de visita del residente y confirmación por parte del prestador
    const visit = await req(
      'POST',
      '/api/v1/passes/visit-requests',
      {
        provider_id: providerId,
        fraction_number: '4',
        lot_number: '18',
        preferred_date: new Date(Date.now() + 3600000).toISOString(),
        notes: 'Revisión eléctrica',
      },
      ownerToken
    );
    assert.equal(visit.status, 201);

    const respond = await req(
      'PATCH',
      `/api/v1/passes/visit-requests/${visit.data.visit.id}/respond`,
      { action: 'confirm', reply_text: 'Confirmo horario' },
      provToken
    );
    assert.equal(respond.status, 200);

    // 2. Emisión de Pase QR #1 y actualización de patente previa al ingreso
    const p1 = await req(
      'POST',
      '/api/v1/passes/create',
      {
        provider_id: providerId,
        fraction_number: '4',
        lot_number: '18',
        vehicle_plate: 'AB123CD',
        start_time: new Date(Date.now() - 10 * 60000).toISOString(),
        end_time: new Date(Date.now() + 4 * 3600000).toISOString(),
      },
      ownerToken
    );
    assert.equal(p1.status, 201);
    pass1Id = p1.data.pass.id;
    pass1Qr = p1.data.pass.qr_token;

    const editPass = await req(
      'PATCH',
      `/api/v1/passes/${pass1Id}`,
      { fraction_number: '4', lot_number: '18', vehicle_plate: 'ZZ999ZZ' },
      ownerToken
    );
    assert.equal(editPass.status, 200);
    assert.equal(editPass.data.pass.vehicle_plate, 'ZZ999ZZ');

    // 3. Regla de ingreso único en Garita Interna: primer escaneo marca 'used', segundo bloquea (403)
    const scan1 = await req('POST', '/api/v1/passes/verify', { qr_token: pass1Qr }, secToken);
    assert.equal(scan1.status, 200);
    assert.equal(scan1.data.details.status, 'used');

    const rescan1 = await req('POST', '/api/v1/passes/verify', { qr_token: pass1Qr }, secToken);
    assert.equal(rescan1.status, 403);
    assert.equal(rescan1.data.code, 'PASS_ALREADY_USED');

    // 4. Emisión de Pase QR #2 y prueba de suspensión local en el barrio + levantamiento en API Externa
    const p2 = await req(
      'POST',
      '/api/v1/passes/create',
      {
        provider_id: providerId,
        fraction_number: '4',
        lot_number: '18',
        start_time: new Date(Date.now() - 10 * 60000).toISOString(),
        end_time: new Date(Date.now() + 4 * 3600000).toISOString(),
      },
      ownerToken
    );
    pass2Qr = p2.data.pass.qr_token;

    const susp = await req(
      'POST',
      '/api/v1/providers/local-suspensions',
      { country_id: countryId, provider_id: providerId, reason: 'Incumplimiento temporal' },
      superRealToken
    );
    assert.equal(susp.status, 201);

    // Con suspensión local activa, la garita externa debe denegar con LOCAL_SUSPENSION_ACTIVE
    const extBlocked = await req(
      'POST',
      '/api/v1/external/passes/verify',
      { qr_token: pass2Qr, country_id: countryId },
      secToken
    );
    assert.equal(extBlocked.status, 403);
    assert.equal(extBlocked.data.code, 'LOCAL_SUSPENSION_ACTIVE');

    // Al levantar la suspensión, el pase se autoriza una sola vez y un reintento devuelve PASS_ALREADY_USED
    const lift = await req(
      'PATCH',
      `/api/v1/providers/local-suspensions/${susp.data.suspension.id}/lift`,
      {},
      superRealToken
    );
    assert.equal(lift.status, 200);

    const extOk = await req(
      'POST',
      '/api/v1/external/passes/verify',
      { qr_token: pass2Qr, country_id: countryId },
      secToken
    );
    assert.equal(extOk.status, 200);
    assert.equal(extOk.data.pass.status, 'used');

    const extReplay = await req(
      'POST',
      '/api/v1/external/passes/verify',
      { qr_token: pass2Qr, country_id: countryId },
      secToken
    );
    assert.equal(extReplay.status, 403);
    assert.equal(extReplay.data.code, 'PASS_ALREADY_USED');
  });

  // =========================================================================
  // FASE 4: Contratos, pagos 7%/93%, seguridad de webhook HMAC y reseñas cruzadas
  // =========================================================================

  // Escenario: creación de contrato vinculado a pase, cotización con split 7%/93%, verificación
  // de firma HMAC-SHA256 en webhook de pagos y calificaciones cruzadas (residente <-> prestador).
  // Precondiciones: `providerId`, `pass1Id` y secreto `WEBHOOK_SECRET` configurado en el servidor E2E.
  // Resultado esperado: rechaza webhook sin firma (401), aprueba pago con firma válida (`hmac_sha256`)
  // y permite registrar ambas reseñas cruzadas (201).
  it('procesa contratos, checkout 7%/93%, webhook HMAC y reseñas cruzadas bidireccionales', async () => {
    // 1. Alta de contrato de servicio y generación de cotización/transacción pendiente
    const c = await req(
      'POST',
      '/api/v1/contracts',
      { provider_id: providerId, pass_id: pass1Id, description: 'Tablero general', agreed_amount: 10000 },
      ownerToken
    );
    assert.equal(c.status, 201);
    contractId = c.data.contract.id;

    const q = await req(
      'POST',
      '/api/v1/payments/quote',
      { contract_id: contractId, agreed_amount: 10000 },
      ownerToken
    );
    assert.equal(q.status, 201);
    const gwId = q.data.transaction.gateway_payment_id;

    // 2. Seguridad del webhook: rechazo 401 sin firma y aprobación 200 con firma HMAC-SHA256 válida
    const whNoSig = await req('POST', '/api/v1/payments/webhook', {
      gateway_payment_id: gwId,
      status: 'approved',
    });
    assert.equal(whNoSig.status, 401);

    const payload = JSON.stringify({ gateway_payment_id: gwId, status: 'approved' });
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    const whOk = await req('POST', '/api/v1/payments/webhook', payload, null, {
      'x-webhook-signature': `sha256=${sig}`,
    });
    assert.equal(whOk.status, 200);
    assert.equal(whOk.data.verification_mode, 'hmac_sha256');

    // 3. Reputación bidireccional: residente califica al prestador y prestador califica al residente
    const revProv = await req(
      'POST',
      '/api/v1/reviews/provider',
      { contract_id: contractId, rating: 5, comment: 'Excelente' },
      ownerToken
    );
    assert.equal(revProv.status, 201);

    const revOwner = await req(
      'POST',
      '/api/v1/reviews/owner',
      { contract_id: contractId, rating: 5, comment: 'Muy atento' },
      provToken
    );
    assert.equal(revOwner.status, 201);
  });

  // =========================================================================
  // FASE 5: Identidad dual bidireccional (Residente + Prestador) y Mi Cuenta
  // =========================================================================

  // Escenario: un residente habilita también el portal prestador (y viceversa), configurando
  // portal principal y accediendo a los endpoints protegidos del segundo rol sin duplicar cuenta.
  // Precondiciones: cuentas `ownerToken` y `provToken` ya creadas.
  // Resultado esperado: ambos usuarios activan identidad dual, `owner` accede a `/providers/me`
  // y `provider` accede al directorio de residentes y a `/reviews/contracts?portal=resident`.
  it('habilita identidad dual bidireccional y portal principal desde /api/v1/account', async () => {
    // 1. Consulta del perfil unificado de cuenta del residente
    const me = await req('GET', '/api/v1/account/me', undefined, ownerToken);
    assert.equal(me.status, 200);
    assert.equal(Array.isArray(me.data.countries), true);

    // 2. Residente activa portal prestador, lo define como principal y consulta /providers/me
    const enableProv = await req(
      'PATCH',
      '/api/v1/account/profile',
      {
        fraction_type: 'manzana',
        fraction_number: '7',
        lot_number: '22',
        activate_resident_portal: true,
        activate_provider_portal: true,
      },
      ownerToken
    );
    assert.equal(enableProv.status, 200);
    assert.equal(enableProv.data.account.can_use_provider, true);

    const primary = await req(
      'PATCH',
      '/api/v1/account/primary-portal',
      { primary_portal: 'provider' },
      ownerToken
    );
    assert.equal(primary.status, 200);
    assert.equal(primary.data.account.primary_portal, 'provider');

    const dualProv = await req('GET', '/api/v1/providers/me', undefined, ownerToken);
    assert.equal(dualProv.status, 200);

    // 3. Prestador activa portal residente y consume directorio y contratos en vista residente
    const enableRes = await req(
      'PATCH',
      '/api/v1/account/profile',
      {
        fraction_type: 'fraccion',
        fraction_number: '2',
        lot_number: '9',
        activate_resident_portal: true,
        activate_provider_portal: true,
      },
      provToken
    );
    assert.equal(enableRes.status, 200);

    const dualDir = await req('GET', '/api/v1/providers/directory', undefined, provToken);
    assert.equal(dualDir.status, 200);

    const dualRev = await req('GET', '/api/v1/reviews/contracts?portal=resident', undefined, provToken);
    assert.equal(dualRev.status, 200);
    assert.equal(dualRev.data.portal, 'resident');
  });

  // =========================================================================
  // FASE 6: Hardening HTTP, recuperación de contraseña y gestión de cuadrilla
  // =========================================================================

  // Escenario: validación de cabeceras de seguridad HTTP, flujo completo de reseteo de clave
  // con token de un solo uso y ciclo CRUD de empleados/ayudantes del prestador.
  // Precondiciones: cuenta residente (`ownerEmail`) y prestador (`provToken`) registrados.
  // Resultado esperado: cabeceras `nosniff`, `DENY` y sin `x-powered-by`; reseteo exitoso de contraseña
  // rechazando reutilización del token (400); alta, listado, edición y baja de ayudante.
  it('envía cabeceras defensivas, permite recuperación de contraseña y CRUD de ayudantes/cuadrilla', async () => {
    // 1. Verificar cabeceras defensivas y ocultamiento de firma del servidor Express
    const healthRes = await fetch(`${BASE}/health`);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(healthRes.headers.get('x-powered-by'), null);

    // 2. Flujo forgot-password -> reset-password -> login con nueva contraseña
    const ownerEmail = `e2e.owner.${ts}@test.local`;
    const forgot = await req('POST', '/api/v1/auth/forgot-password', { email: ownerEmail });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.data.dev_reset_token, 'Debe devolver dev_reset_token en entorno no productivo');

    const reset = await req('POST', '/api/v1/auth/reset-password', {
      token: forgot.data.dev_reset_token,
      new_password: 'NewPassword456!',
    });
    assert.equal(reset.status, 200);

    const loginNew = await req('POST', '/api/v1/auth/login', {
      email: ownerEmail,
      password: 'NewPassword456!',
    });
    assert.equal(loginNew.status, 200);

    // Reutilizar el token de reset debe fallar
    const reuseReset = await req('POST', '/api/v1/auth/reset-password', {
      token: forgot.data.dev_reset_token,
      new_password: 'AnotherPassword789!',
    });
    assert.equal(reuseReset.status, 400);

    // 3. CRUD de ayudantes / cuadrilla del prestador
    const addEmp = await req(
      'POST',
      '/api/v1/providers/employees',
      {
        full_name: 'Pedro Ayudante',
        dni: `77${String(ts).slice(-6)}`,
        phone: '+5491155551234',
        role_label: 'Oficial Eléctrico',
        insurance_policy_url: 'https://example.com/art-pedro.pdf',
        insurance_expiry: '2027-06-01',
      },
      provToken
    );
    assert.equal(addEmp.status, 201);
    const empId = addEmp.data.employee.id;

    const listEmp = await req('GET', '/api/v1/providers/employees', undefined, provToken);
    assert.equal(listEmp.status, 200);
    assert.equal(listEmp.data.employees.some((e) => e.id === empId), true);

    const editEmp = await req(
      'PATCH',
      `/api/v1/providers/employees/${empId}`,
      { role_label: 'Oficial Senior' },
      provToken
    );
    assert.equal(editEmp.status, 200);
    assert.equal(editEmp.data.employee.role_label, 'Oficial Senior');

    const delEmp = await req('DELETE', `/api/v1/providers/employees/${empId}`, undefined, provToken);
    assert.equal(delEmp.status, 200);
  });

  // Escenario: integración de ayudantes de cuadrilla con alertas de vencimiento próximo, directorio
  // de residentes, emisión de Pase QR con `employee_ids` y lectura en Consola Garita.
  // Precondiciones: ayudante con ART por vencer en 10 días creado bajo el prestador aprobado.
  // Resultado esperado: alerta `expiring_soon` visible para prestador y admin, cuadrilla expuesta
  // en directorio y propagada hasta la respuesta de autorización en `/passes/verify`.
  it('adjunta ayudantes de cuadrilla al Pase QR, los expone en garita y calcula alertas de vencimiento', async () => {
    const soonDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const addEmp = await req(
      'POST',
      '/api/v1/providers/employees',
      {
        full_name: 'Lucas Cuadrilla',
        dni: `88${String(ts).slice(-6)}`,
        role_label: 'Ayudante de Obra',
        insurance_expiry: soonDate,
      },
      provToken
    );
    assert.equal(addEmp.status, 201);
    const crewEmpId = addEmp.data.employee.id;

    // 1. El prestador recibe la alerta de vencimiento próximo en /providers/me
    const myProf = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(myProf.status, 200);
    assert.ok(
      Array.isArray(myProf.data.expiry_alerts) &&
        myProf.data.expiry_alerts.some(
          (a) => a.category === 'employee_art' && a.severity === 'expiring_soon'
        ),
      'Debe incluir alerta expiring_soon de ART del ayudante'
    );

    // 2. Admin / Superadmin recibe alertas globales en /providers/expiry-alerts
    const adminAlerts = await req(
      'GET',
      '/api/v1/providers/expiry-alerts?days=30',
      undefined,
      superToken
    );
    assert.equal(adminAlerts.status, 200);
    assert.ok(adminAlerts.data.summary.expiring_soon >= 1);
    assert.ok(
      adminAlerts.data.alerts.some((a) => a.id === `employee-${crewEmpId}`),
      'La alerta del ayudante debe figurar en el panel administrativo'
    );

    // 3. El directorio del residente expone los ayudantes activos del prestador
    const dir = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dir.status, 200);
    const dirProv = dir.data.providers.find((p) => Number(p.provider_id) === Number(providerId));
    assert.ok(dirProv, 'El prestador aprobado debe figurar en el directorio');
    assert.ok(
      Array.isArray(dirProv.employees) && dirProv.employees.some((e) => e.id === crewEmpId),
      'El directorio debe listar la cuadrilla activa del prestador'
    );

    // 4. Emitir Pase QR adjuntando employee_ids y editarlo manteniendo la cuadrilla
    const now = Date.now();
    const crewPass = await req(
      'POST',
      '/api/v1/passes/create',
      {
        provider_id: providerId,
        employee_ids: [crewEmpId],
        start_time: new Date(now - 5 * 60 * 1000).toISOString(),
        end_time: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      },
      ownerToken
    );
    assert.equal(crewPass.status, 201);
    assert.equal(crewPass.data.pass.authorized_employees.length, 1);
    assert.equal(crewPass.data.pass.authorized_employees[0].full_name, 'Lucas Cuadrilla');
    const crewPassId = crewPass.data.pass.id;
    const crewQrToken = crewPass.data.pass.qr_token;

    // 5. Validar en Consola Garita y verificar que devuelve la cuadrilla autorizada
    const gateCheck = await req(
      'POST',
      '/api/v1/passes/verify',
      { qr_token: crewQrToken },
      secToken
    );
    assert.equal(gateCheck.status, 200);
    assert.equal(gateCheck.data.authorized, true);
    assert.equal(gateCheck.data.details.authorized_employees.length, 1);
    assert.equal(gateCheck.data.details.authorized_employees[0].full_name, 'Lucas Cuadrilla');

    // Limpieza del pase y ayudante
    await db.query('DELETE FROM access_passes WHERE id = $1', [crewPassId]);
    await req('DELETE', `/api/v1/providers/employees/${crewEmpId}`, undefined, provToken);
  });

  // Escenario: desactivación reversible del portal prestador para operar como "Solo Residente"
  // y cambio autenticado de contraseña desde Mi Cuenta.
  // Precondiciones: prestador con portal residente ya habilitado en la fase de identidad dual.
  // Resultado esperado: bloquea dejar ambos portales desactivados (400), revoca acceso inmediato
  // a `/providers/me` (403) y oculta al prestador del directorio; al reactivar recupera su estado
  // y valida el cambio de contraseña con verificación de clave actual.
  it('permite a un prestador pasar a Solo Residente (ocultándose del directorio y bloqueando API prestador) y volver a activarse', async () => {
    // 1. El prestador (que ya activó Residente en test anterior con Lote 45) desactiva Portal Prestador
    const toOnlyResident = await req(
      'PATCH',
      '/api/v1/account/profile',
      {
        activate_resident_portal: true,
        activate_provider_portal: false,
        fraction_type: 'manzana',
        fraction_number: '2',
        lot_number: '45',
      },
      provToken
    );
    assert.equal(toOnlyResident.status, 200);
    assert.equal(toOnlyResident.data.account.can_use_resident, true);
    assert.equal(toOnlyResident.data.account.can_use_provider, false);
    assert.equal(toOnlyResident.data.account.primary_portal, 'resident');
    assert.equal(toOnlyResident.data.account.role, 'owner');
    assert.ok(toOnlyResident.data.token, 'Debe devolver token JWT actualizado con el nuevo rol por defecto');

    // 2. No permite desactivar ambos portales a la vez
    const noneActive = await req(
      'PATCH',
      '/api/v1/account/profile',
      {
        activate_resident_portal: false,
        activate_provider_portal: false,
      },
      toOnlyResident.data.token
    );
    assert.equal(noneActive.status, 400);

    // 3. Con Portal Prestador desactivado, pierde acceso inmediato a /api/v1/providers/me (incluso con el token viejo)
    const blockedProvOldToken = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(blockedProvOldToken.status, 403);

    // 4. Desaparece del directorio de prestadores verificados para los residentes
    const dirHidden = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirHidden.status, 200);
    assert.equal(
      dirHidden.data.providers.some((p) => Number(p.provider_id) === Number(providerId)),
      false,
      'Un ex-prestador con Portal Prestador desactivado no debe figurar en el directorio'
    );

    // 5. Reactiva Portal Prestador y lo vuelve a definir como principal -> reaparece con su historial intacto
    const reactivated = await req(
      'PATCH',
      '/api/v1/account/profile',
      {
        activate_resident_portal: true,
        activate_provider_portal: true,
        fraction_type: 'manzana',
        fraction_number: '2',
        lot_number: '45',
      },
      toOnlyResident.data.token
    );
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.data.account.can_use_provider, true);

    const setProvPrimary = await req(
      'PATCH',
      '/api/v1/account/primary-portal',
      { primary_portal: 'provider' },
      reactivated.data.token
    );
    assert.equal(setProvPrimary.status, 200);
    assert.equal(setProvPrimary.data.account.primary_portal, 'provider');
    assert.equal(setProvPrimary.data.account.role, 'provider');

    const dirVisibleAgain = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirVisibleAgain.status, 200);
    assert.equal(
      dirVisibleAgain.data.providers.some((p) => Number(p.provider_id) === Number(providerId)),
      true,
      'Al reactivar Portal Prestador debe reaparecer en el directorio con su compliance intacto'
    );

    // 6. Cambio autenticado de contraseña desde Mi Cuenta (PATCH /api/v1/account/password)
    const badPwd = await req(
      'PATCH',
      '/api/v1/account/password',
      { current_password: 'WrongPassword!', new_password: 'UpdatedPassword999!' },
      setProvPrimary.data.token
    );
    assert.equal(badPwd.status, 401);

    const okPwd = await req(
      'PATCH',
      '/api/v1/account/password',
      { current_password: 'Password123!', new_password: 'UpdatedPassword999!' },
      setProvPrimary.data.token
    );
    assert.equal(okPwd.status, 200);
  });

  // =========================================================================
  // FASE 7 (Roadmap 1.1 - 4 y Evolutivas): Vencimientos, Monetización, B2B, MP y Post-Servicio
  // =========================================================================

  // Escenario: bloqueo automático por documentación vencida tanto al emitir pases QR como al escanear
  // en garita interna y API externa (ART del prestador, antecedentes penales y ART de cuadrilla).
  // Precondiciones: manipulación controlada de fechas de vencimiento en DB para simular expiración.
  // Resultado esperado: códigos 403 `INSURANCE_EXPIRED`, `CRIMINAL_RECORD_EXPIRED` (en ambas garitas)
  // y `CREW_INSURANCE_EXPIRED` al adjuntar un ayudante vencido, restaurando el estado al finalizar.
  it('bloquea emisión y validación QR ante ART/antecedentes/cuadrilla vencidos (Fase 1.1)', async () => {
    const pastDate = '2020-01-15';
    const futureDate = '2028-06-01';
    const now = Date.now();

    // 1. Vencer ART del prestador directamente en DB y verificar que createPass bloquea con INSURANCE_EXPIRED
    await db.query(
      'UPDATE providers SET criminal_record_expiry = $1, insurance_expiry = $2 WHERE id = $3',
      [futureDate, pastDate, providerId]
    );

    const blockedCreate = await req(
      'POST',
      '/api/v1/passes/create',
      {
        provider_id: providerId,
        start_time: new Date(now - 5 * 60 * 1000).toISOString(),
        end_time: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      },
      ownerToken
    );
    assert.equal(blockedCreate.status, 403);
    assert.equal(blockedCreate.data.code, 'INSURANCE_EXPIRED');

    // 2. Restaurar fechas vigentes, emitir un pase QR y luego vencer antecedentes para probar bloqueo en Consola Garita y API Externa
    await db.query(
      'UPDATE providers SET criminal_record_expiry = $1, insurance_expiry = $2 WHERE id = $3',
      [futureDate, futureDate, providerId]
    );

    const validPass = await req(
      'POST',
      '/api/v1/passes/create',
      {
        provider_id: providerId,
        start_time: new Date(now - 5 * 60 * 1000).toISOString(),
        end_time: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      },
      ownerToken
    );
    assert.equal(validPass.status, 201);
    const expiryTestPassId = validPass.data.pass.id;
    const expiryTestQr = validPass.data.pass.qr_token;

    await db.query(
      'UPDATE providers SET criminal_record_expiry = $1 WHERE id = $2',
      [pastDate, providerId]
    );

    const gateBlocked = await req(
      'POST',
      '/api/v1/passes/verify',
      { qr_token: expiryTestQr },
      secToken
    );
    assert.equal(gateBlocked.status, 403);
    assert.equal(gateBlocked.data.authorized, false);
    assert.equal(gateBlocked.data.code, 'CRIMINAL_RECORD_EXPIRED');

    const extBlocked = await req(
      'POST',
      '/api/v1/external/passes/verify',
      { qr_token: expiryTestQr },
      superToken
    );
    assert.equal(extBlocked.status, 403);
    assert.equal(extBlocked.data.authorized, false);
    assert.equal(extBlocked.data.code, 'CRIMINAL_RECORD_EXPIRED');

    // 3. Restaurar compliance vigente del prestador y probar bloqueo por ayudante con ART vencida
    await db.query(
      'UPDATE providers SET criminal_record_expiry = $1, insurance_expiry = $2 WHERE id = $3',
      [futureDate, futureDate, providerId]
    );
    const expEmpRes = await req(
      'POST',
      '/api/v1/providers/employees',
      {
        full_name: 'Ramiro Vencido',
        dni: `79${String(ts).slice(-6)}`,
        role_label: 'Ayudante',
        insurance_expiry: pastDate,
      },
      provToken
    );
    assert.equal(expEmpRes.status, 201);
    const expEmpId = expEmpRes.data.employee.id;

    const crewBlockedCreate = await req(
      'POST',
      '/api/v1/passes/create',
      {
        provider_id: providerId,
        employee_ids: [expEmpId],
        start_time: new Date(now - 5 * 60 * 1000).toISOString(),
        end_time: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      },
      ownerToken
    );
    assert.equal(crewBlockedCreate.status, 403);
    assert.equal(crewBlockedCreate.data.code, 'CREW_INSURANCE_EXPIRED');

    // Limpieza
    await db.query('DELETE FROM access_passes WHERE id = $1', [expiryTestPassId]);
    await req('DELETE', `/api/v1/providers/employees/${expEmpId}`, undefined, provToken);
  });

  // Escenario: ciclo de vida completo de la membresía "Socio Verificado" del prestador.
  // Precondiciones: prestador aprobado sin membresía activa inicialmente.
  // Resultado esperado: auto-suscripción a `verified_monthly`, visibilidad prioritaria en directorio
  // y `/providers/me`, revocación manual y reactivación por 60 días (`verified_pro`) desde Superadmin.
  it('gestiona membresía Socio Verificado (alta, directorio prioritario y control Superadmin) (Fase 1.2)', async () => {
    // 1. Consulta inicial de membresía propia
    const initialBilling = await req('GET', '/api/v1/billing/provider/me', undefined, provToken);
    assert.equal(initialBilling.status, 200);
    assert.equal(initialBilling.data.membership.is_verified_member, false);
    assert.ok(Array.isArray(initialBilling.data.plans) && initialBilling.data.plans.length >= 2);

    // 2. El prestador activa membresía Socio Verificado Mensual
    const subRes = await req(
      'POST',
      '/api/v1/billing/provider/subscribe',
      { plan_code: 'verified_monthly', auto_renew: true },
      provToken
    );
    assert.equal(subRes.status, 201);
    assert.equal(subRes.data.membership.is_verified_member, true);
    assert.equal(subRes.data.membership.plan_code, 'verified_monthly');
    assert.ok(subRes.data.membership.days_remaining >= 29);

    // 3. Aparece como Socio Verificado en /providers/me y en el directorio del residente (con prioridad)
    const meWithMember = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(meWithMember.status, 200);
    assert.equal(meWithMember.data.membership.is_verified_member, true);

    const dirRes = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirRes.status, 200);
    const dirProv = dirRes.data.providers.find((p) => Number(p.provider_id) === Number(providerId));
    assert.ok(dirProv);
    assert.equal(dirProv.is_verified_member, true);
    assert.equal(dirProv.membership_tier, 'verified_monthly');

    // 4. Superadmin consulta y revoca la membresía del prestador
    const provUserId = dirProv.user_id;
    const opsList = await req('GET', '/api/v1/billing/providers', undefined, superToken);
    assert.equal(opsList.status, 200);
    assert.ok(opsList.data.summary.active_members >= 1);

    const revokeRes = await req(
      'PATCH',
      `/api/v1/billing/provider/${provUserId}`,
      { action: 'cancel', notes: 'Fin de prueba E2E' },
      superToken
    );
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.data.membership.is_verified_member, false);

    // 5. Superadmin reactiva por 60 días y verifica reflejo en Ops Compliance (/providers/all)
    const grantRes = await req(
      'PATCH',
      `/api/v1/billing/provider/${provUserId}`,
      { action: 'activate', plan_code: 'verified_pro', days: 60 },
      superToken
    );
    assert.equal(grantRes.status, 200);
    assert.equal(grantRes.data.membership.is_verified_member, true);
    assert.equal(grantRes.data.membership.plan_code, 'verified_pro');

    const allOps = await req('GET', '/api/v1/providers/all', undefined, superToken);
    assert.equal(allOps.status, 200);
    const opsRow = allOps.data.providers.find((p) => Number(p.user_id) === Number(provUserId));
    assert.ok(opsRow);
    assert.equal(opsRow.is_verified_member, true);
    assert.equal(opsRow.membership_tier, 'verified_pro');
  });

  // Escenario: gobierno del licenciamiento B2B por comunidad y enforcement en la API externa de garita.
  // Precondiciones: respaldo del estado de billing actual del barrio y creación de una API Key temporal.
  // Resultado esperado: configura plan `pro` con cuota, bloquea con 403 `COUNTRY_SUBSCRIPTION_SUSPENDED`
  // y `COUNTRY_SUBSCRIPTION_EXPIRED`, permite continuar en estado `grace` hasta `PASS_NOT_FOUND` (404)
  // y restaura el estado original de la comunidad en el bloque `finally`.
  it('gestiona licenciamiento B2B por comunidad y bloquea API externa si está suspendida o vencida (Fase 2)', async () => {
    const prevBillingRes = await db.query(
      'SELECT plan_code, billing_status, subscription_ends_at, monthly_pass_quota FROM countries WHERE id = $1 LIMIT 1',
      [countryId]
    );
    const prevBilling = prevBillingRes.rows[0] || {
      plan_code: 'pilot',
      billing_status: 'active',
      subscription_ends_at: null,
      monthly_pass_quota: null,
    };

    let tempIntegrationId = null;
    try {
      // 1. Crear una API Key temporal para la comunidad
      const keyRes = await req(
        'POST',
        '/api/v1/external/integrations',
        { country_id: countryId, label: `E2E B2B Gate ${ts}` },
        superToken
      );
      assert.equal(keyRes.status, 201);
      const rawApiKey = keyRes.data.api_key;
      tempIntegrationId = keyRes.data.integration.id;

      // 2. Configurar plan B2B 'pro' activo por 30 días y cuota 5000
      const updRes = await req(
        'PATCH',
        `/api/v1/external/countries/${countryId}/billing`,
        {
          plan_code: 'pro',
          billing_status: 'active',
          extend_days: 30,
          monthly_pass_quota: 5000,
        },
        superToken
      );
      assert.equal(updRes.status, 200);
      assert.equal(updRes.data.country.plan_code, 'pro');
      assert.equal(updRes.data.country.billing_status, 'active');
      assert.equal(updRes.data.country.monthly_pass_quota, 5000);
      assert.ok(updRes.data.country.subscription_ends_at);

      // 3. Consultar resumen B2B desde /my-community/billing y /countries
      const myBill = await req(
        'GET',
        `/api/v1/external/my-community/billing?country_id=${countryId}`,
        undefined,
        superToken
      );
      assert.equal(myBill.status, 200);
      assert.equal(myBill.data.community.plan_code, 'pro');
      assert.equal(typeof myBill.data.community.monthly_qr_used, 'number');

      const countriesList = await req(
        'GET',
        '/api/v1/external/countries?page=1&limit=20',
        undefined,
        superToken
      );
      assert.equal(countriesList.status, 200);
      assert.ok(Array.isArray(countriesList.data.b2b_plans) && countriesList.data.b2b_plans.length >= 3);

      // 4. Suspender licencia B2B y verificar bloqueo COUNTRY_SUBSCRIPTION_SUSPENDED en API externa
      const suspRes = await req(
        'PATCH',
        `/api/v1/external/countries/${countryId}/billing`,
        { billing_status: 'suspended' },
        superToken
      );
      assert.equal(suspRes.status, 200);

      const blockedSusp = await req(
        'POST',
        '/api/v1/external/passes/verify',
        { qr_token: 'dummy-token-for-b2b-check' },
        null,
        { 'x-api-key': rawApiKey }
      );
      assert.equal(blockedSusp.status, 403);
      assert.equal(blockedSusp.data.code, 'COUNTRY_SUBSCRIPTION_SUSPENDED');

      // 5. Vencer fecha de suscripción en estado 'active' -> COUNTRY_SUBSCRIPTION_EXPIRED
      const expRes = await req(
        'PATCH',
        `/api/v1/external/countries/${countryId}/billing`,
        {
          billing_status: 'active',
          subscription_ends_at: '2020-01-01T00:00:00.000Z',
        },
        superToken
      );
      assert.equal(expRes.status, 200);

      const blockedExp = await req(
        'POST',
        '/api/v1/external/passes/verify',
        { qr_token: 'dummy-token-for-b2b-check' },
        null,
        { 'x-api-key': rawApiKey }
      );
      assert.equal(blockedExp.status, 403);
      assert.equal(blockedExp.data.code, 'COUNTRY_SUBSCRIPTION_EXPIRED');

      // 6. Pasar a 'grace' (período de gracia) -> supera el control B2B y llega a PASS_NOT_FOUND (404)
      const graceRes = await req(
        'PATCH',
        `/api/v1/external/countries/${countryId}/billing`,
        { billing_status: 'grace' },
        superToken
      );
      assert.equal(graceRes.status, 200);

      const allowedGrace = await req(
        'POST',
        '/api/v1/external/passes/verify',
        { qr_token: 'dummy-token-for-b2b-check' },
        null,
        { 'x-api-key': rawApiKey }
      );
      assert.equal(allowedGrace.status, 404);
      assert.equal(allowedGrace.data.code, 'PASS_NOT_FOUND');
    } finally {
      await db
        .query(
          `UPDATE countries
           SET plan_code = $1,
               billing_status = $2,
               subscription_ends_at = $3,
               monthly_pass_quota = $4
           WHERE id = $5`,
          [
            prevBilling.plan_code || 'pilot',
            prevBilling.billing_status || 'active',
            prevBilling.subscription_ends_at || null,
            prevBilling.monthly_pass_quota ?? null,
            countryId,
          ]
        )
        .catch(() => {});
      if (tempIntegrationId) {
        await db.query('DELETE FROM country_integrations WHERE id = $1', [tempIntegrationId]).catch(() => {});
      }
      await db
        .query("DELETE FROM gate_access_logs WHERE qr_token LIKE 'dummy-to%'")
        .catch(() => {});
    }
  });

  // Escenario: exposición de configuración de pasarela y validación de webhook con el formato oficial
  // `x-signature` (`ts=<unix>,v1=<hmac>`) y `x-request-id` de Mercado Pago.
  // Precondiciones: servidor E2E en modo `mock` con comisión 7% y contrato con cotización pendiente.
  // Resultado esperado: `/payments/config` informa `mock` y `7%`; el webhook autentica la firma
  // reportando `verification_mode: 'mp_x_signature'` y limpia el contrato temporal.
  it('expone configuración de pasarela en /payments/config y valida firma oficial x-signature de Mercado Pago (Fase 3)', async () => {
    const cfgRes = await req('GET', '/api/v1/payments/config', undefined, ownerToken);
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.data.gateway_mode, 'mock');
    assert.equal(cfgRes.data.platform_fee_percent, 7);

    // Creamos un contrato + cotización pendiente para probar firma oficial MP x-signature (ts + v1)
    const cRes = await req(
      'POST',
      '/api/v1/contracts',
      {
        provider_id: providerId,
        description: 'Trabajo prueba firma Mercado Pago',
        agreed_amount: 12000,
      },
      ownerToken
    );
    assert.equal(cRes.status, 201);
    const mpContractId = cRes.data.contract.id;

    const qRes = await req(
      'POST',
      '/api/v1/payments/quote',
      { contract_id: mpContractId, agreed_amount: 12000 },
      ownerToken
    );
    assert.equal(qRes.status, 201);
    const gwPaymentId = qRes.data.transaction.gateway_payment_id;

    const tsHeader = String(Math.floor(Date.now() / 1000));
    const reqId = `e2e-mp-req-${ts}`;
    const manifest = `id:${gwPaymentId};request-id:${reqId};ts:${tsHeader};`;
    const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');

    const whRes = await req(
      'POST',
      '/api/v1/payments/webhook',
      { gateway_payment_id: gwPaymentId, status: 'approved' },
      null,
      {
        'x-signature': `ts=${tsHeader},v1=${v1}`,
        'x-request-id': reqId,
      }
    );
    assert.equal(whRes.status, 200);
    assert.equal(whRes.data.verification_mode, 'mp_x_signature');

    // Limpieza
    await db.query('DELETE FROM service_contracts WHERE id = $1', [mpContractId]);
  });

  // Escenario: ciclo post-pago completo — conformidad final con liberación escrow, emisión del
  // Comprobante del Hogar (`TLK-REC-*`) y circuito de reclamos/garantía con resolución administrativa.
  // Precondiciones: contrato nuevo pagado en modo mock (`in_progress` + transacción `approved`).
  // Resultado esperado: `/complete` libera el pago (`released`), `/receipt` retorna comprobante válido,
  // `/dispute` impide duplicados abiertos (409) y Superadmin resuelve el reclamo con nota y timestamp.
  it('registra conformidad final (con liberación escrow), genera Comprobante del Hogar y gestiona reclamos/garantía (Fase 4)', async () => {
    // 1. Crear contrato y pagarlo en modo mock -> queda 'in_progress' con transacción 'approved'
    const cRes = await req(
      'POST',
      '/api/v1/contracts',
      {
        provider_id: providerId,
        description: 'Instalación bomba de pileta con garantía',
        agreed_amount: 45000,
      },
      ownerToken
    );
    assert.equal(cRes.status, 201);
    const f4ContractId = cRes.data.contract.id;

    const payRes = await req(
      'POST',
      `/api/v1/contracts/${f4ContractId}/pay`,
      {},
      ownerToken
    );
    assert.equal(payRes.status, 200);
    assert.equal(payRes.data.contract.status, 'in_progress');
    assert.equal(payRes.data.transaction.status, 'approved');

    // 2. Residente registra conformidad final -> contrato 'completed' y transacción liberada ('released')
    const completeRes = await req(
      'PATCH',
      `/api/v1/contracts/${f4ContractId}/complete`,
      { completion_notes: 'Trabajo probado y conforme.' },
      ownerToken
    );
    assert.equal(completeRes.status, 200);
    assert.equal(completeRes.data.contract.status, 'completed');
    assert.ok(completeRes.data.contract.completed_at);
    assert.equal(completeRes.data.released_transactions_count, 1);

    // 3. Consultar Comprobante del Hogar (GET /api/v1/contracts/:id/receipt)
    const receiptRes = await req(
      'GET',
      `/api/v1/contracts/${f4ContractId}/receipt`,
      undefined,
      ownerToken
    );
    assert.equal(receiptRes.status, 200);
    assert.ok(receiptRes.data.receipt.receipt_code.startsWith('TLK-REC-'));
    assert.equal(receiptRes.data.receipt.contract.status, 'completed');
    assert.equal(receiptRes.data.receipt.payment.status, 'released');
    assert.equal(receiptRes.data.receipt.payment.total_amount, 45000);

    // 4. Abrir reclamo post-servicio y bloquear duplicado abierto (409)
    const disputeRes = await req(
      'POST',
      `/api/v1/contracts/${f4ContractId}/dispute`,
      {
        reason: 'Garantía post-servicio sin respuesta',
        details: 'La bomba pierde presión a las 48hs de instalada.',
      },
      ownerToken
    );
    assert.equal(disputeRes.status, 201);
    const disputeId = disputeRes.data.dispute.id;
    assert.equal(disputeRes.data.dispute.status, 'open');

    const dupDispute = await req(
      'POST',
      `/api/v1/contracts/${f4ContractId}/dispute`,
      { reason: 'Duplicado', details: 'Intento duplicado' },
      ownerToken
    );
    assert.equal(dupDispute.status, 409);

    // 5. Superadmin consulta listado de reclamos y lo resuelve con nota
    const listDisputes = await req('GET', '/api/v1/contracts/disputes?status=open', undefined, superToken);
    assert.equal(listDisputes.status, 200);
    assert.equal(listDisputes.data.disputes.some((d) => d.id === disputeId), true);

    const resolveRes = await req(
      'PATCH',
      `/api/v1/contracts/disputes/${disputeId}/resolve`,
      {
        status: 'resolved',
        resolution_notes: 'El prestador realizó visita de garantía y reemplazó el sello mecánico.',
      },
      superToken
    );
    assert.equal(resolveRes.status, 200);
    assert.equal(resolveRes.data.dispute.status, 'resolved');
    assert.ok(resolveRes.data.dispute.resolved_at);

    // Limpieza
    await db.query('DELETE FROM service_contracts WHERE id = $1', [f4ContractId]);
  });

  // Escenario: pausa/reactivación de visibilidad de una especialidad en el directorio sin perder
  // la aprobación de compliance, y consulta del resumen financiero del prestador (neto 93%).
  // Precondiciones: prestador aprobado con al menos un contrato registrado durante la suite.
  // Resultado esperado: ocultar especialidad la quita del directorio manteniendo `status: 'approved'`,
  // volver a mostrarla la restaura y `/contracts/provider` expone lista y `total_net_payout` numérico.
  it('persiste visibilidad por especialidad sin alterar compliance y expone contratos/ingresos en /contracts/provider (Evolutivas 1-2)', async () => {
    // 1. Ocultar especialidad del directorio manteniendo status = 'approved'
    const hideRes = await req(
      'PATCH',
      `/api/v1/providers/profile/${providerId}/visibility`,
      { is_visible_in_directory: false },
      provToken
    );
    assert.equal(hideRes.status, 200);
    assert.equal(hideRes.data.provider.is_visible_in_directory, false);
    assert.equal(hideRes.data.provider.status, 'approved');

    const dirHidden = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirHidden.status, 200);
    assert.equal(
      dirHidden.data.providers.some((p) => Number(p.provider_id) === Number(providerId)),
      false,
      'Una especialidad oculta no debe aparecer en el directorio de residentes'
    );

    // 2. Volver a mostrarla y verificar que reaparece en el directorio
    const showRes = await req(
      'PATCH',
      `/api/v1/providers/profile/${providerId}/visibility`,
      { is_visible_in_directory: true },
      provToken
    );
    assert.equal(showRes.status, 200);
    assert.equal(showRes.data.provider.is_visible_in_directory, true);

    const dirVisible = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirVisible.status, 200);
    assert.equal(
      dirVisible.data.providers.some((p) => Number(p.provider_id) === Number(providerId)),
      true
    );

    // 3. Consultar resumen de contratos e ingresos netos (93%) del prestador
    const earnRes = await req('GET', '/api/v1/contracts/provider', undefined, provToken);
    assert.equal(earnRes.status, 200);
    assert.equal(Array.isArray(earnRes.data.contracts), true);
    assert.equal(typeof earnRes.data.summary.total_net_payout, 'number');
    assert.ok(earnRes.data.summary.total_contracts >= 1);
  });

  // =========================================================================
  // FASE 8: Marketplace Fase 5 — Scoring/Termómetro, Favoritos, Disponible Hoy y Micro-tags
  // =========================================================================
  it('calcula reputación/termómetro, actividad en tu barrio, favoritos, disponible hoy y micro-tags en reseñas (Fase 5)', async () => {
    // 0. Resolver `user_id` del prestador autenticado mediante /api/v1/account/me
    const provAccount = await req('GET', '/api/v1/account/me', undefined, provToken);
    assert.equal(provAccount.status, 200);
    const provUserId = Number(provAccount.data.account?.id || provAccount.data.user?.id);

    // 1. Marcar al prestador como favorito y verificar persistencia en /favorites y /directory
    const addFav = await req('POST', `/api/v1/providers/favorites/${provUserId}`, {}, ownerToken);
    assert.equal(addFav.status, 201);
    assert.equal(addFav.data.is_favorite, true);

    const listFav = await req('GET', '/api/v1/providers/favorites', undefined, ownerToken);
    assert.equal(listFav.status, 200);
    assert.ok(listFav.data.favorite_provider_user_ids.includes(Number(provUserId)));

    // 2. Crear un nuevo contrato y reseñarlo con micro-tags (incluyendo un tag inválido que debe descartarse)
    const contractRes = await req(
      'POST',
      '/api/v1/contracts',
      {
        provider_id: providerId,
        description: 'Service preventivo Fase 5',
        agreed_amount: 45000,
      },
      ownerToken
    );
    assert.equal(contractRes.status, 201);
    const f5ContractId = contractRes.data.contract.id;

    const revRes = await req(
      'POST',
      '/api/v1/reviews/provider',
      {
        contract_id: f5ContractId,
        rating: 5,
        comment: 'Excelente atención y puntualidad',
        tags: ['Puntual', 'Prolijo', 'TagInvalidoIgnorado'],
      },
      ownerToken
    );
    assert.equal(revRes.status, 201);
    assert.deepEqual(revRes.data.review.tags, ['Puntual', 'Prolijo']);

    // 3. Verificar que GET /providers/directory devuelva reputación, actividad local, favorito, available_today y top_tags
    const dirRes = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirRes.status, 200);
    const entry = dirRes.data.providers.find((p) => Number(p.user_id) === Number(provUserId));
    assert.ok(entry, 'El prestador debe figurar en el directorio enriquecido');
    assert.equal(entry.is_favorite, true);
    assert.equal(entry.available_today, true);
    assert.ok(entry.community_activity_count >= 1, 'Debe reflejar actividad en la comunidad del residente');
    assert.ok(entry.reputation && typeof entry.reputation.score === 'number');
    assert.ok(entry.reputation.thermometer >= 1 && entry.reputation.thermometer <= 5);
    assert.ok(Array.isArray(entry.top_tags) && entry.top_tags.some((t) => t.tag === 'Puntual'));

    // 4. Crear un bloqueo "unavailable" hoy -> available_today debe pasar a false -> eliminar bloqueo -> vuelve a true
    const now = new Date();
    const blockStart = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const blockEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const blkCreate = await req(
      'POST',
      '/api/v1/passes/schedule/blocks',
      {
        block_type: 'unavailable',
        title: 'Bloqueo de prueba hoy',
        start_at: blockStart,
        end_at: blockEnd,
      },
      provToken
    );
    assert.equal(blkCreate.status, 201);
    const blockId = blkCreate.data.block.id;

    const dirBlocked = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    const blockedEntry = dirBlocked.data.providers.find((p) => Number(p.user_id) === Number(provUserId));
    assert.equal(blockedEntry.available_today, false);

    const blkDel = await req('DELETE', `/api/v1/passes/schedule/blocks/${blockId}`, undefined, provToken);
    assert.equal(blkDel.status, 200);

    // 5. Verificar reputación en el portal del prestador (GET /api/v1/providers/me) y quitar favorito
    const meRes = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(meRes.status, 200);
    assert.ok(meRes.data.reputation && typeof meRes.data.reputation.score === 'number');
    assert.ok(Array.isArray(meRes.data.reputation.top_tags));

    const delFav = await req('DELETE', `/api/v1/providers/favorites/${provUserId}`, undefined, ownerToken);
    assert.equal(delFav.status, 200);
    assert.equal(delFav.data.is_favorite, false);
  });

  // =========================================================================
  // FASE 9: Marketplace Fase 5.2 — Ficha comercial, Urgencias 24h, Tiempo de respuesta y Q&A público
  // =========================================================================
  it('gestiona ficha comercial rápida, urgencias 24h, tiempo de respuesta y Q&A público comunitario (Fase 5.2)', async () => {
    const provAccount = await req('GET', '/api/v1/account/me', undefined, provToken);
    assert.equal(provAccount.status, 200);
    const provUserId = Number(provAccount.data.account?.id || provAccount.data.user?.id);

    // 1. Actualizar ficha comercial rápida y activar Urgencias 24h desde Portal Prestador
    const commRes = await req(
      'PATCH',
      '/api/v1/providers/commercial-profile',
      {
        accepts_emergencies: true,
        quote_visit_policy: 'sin_cargo',
        invoice_type: 'factura_c',
        accepted_payment_methods: ['efectivo', 'transferencia', 'mercadopago'],
        service_bio: 'Especialista en tableros, térmicas y guardias 24h.',
      },
      provToken
    );
    assert.equal(commRes.status, 200);
    assert.equal(commRes.data.commercial_profile.accepts_emergencies, true);
    assert.equal(commRes.data.commercial_profile.quote_visit_policy, 'sin_cargo');

    // 2. Residente publica una pregunta pública (Q&A) en la ficha del prestador
    const askRes = await req(
      'POST',
      `/api/v1/providers/${provUserId}/questions`,
      { question: '¿Atendés urgencias por corte de disyuntor los fines de semana?' },
      ownerToken
    );
    assert.equal(askRes.status, 201);
    const questionId = askRes.data.question.id;
    assert.ok(questionId);

    // 3. Prestador responde la pregunta pública y queda visible en GET /:providerUserId/questions
    const ansRes = await req(
      'PATCH',
      `/api/v1/providers/questions/${questionId}/answer`,
      { answer: 'Sí, atendemos urgencias sábados y domingos las 24 horas.' },
      provToken
    );
    assert.equal(ansRes.status, 200);
    assert.ok(ansRes.data.question.answered_at);

    const listQRes = await req('GET', `/api/v1/providers/${provUserId}/questions`, undefined, ownerToken);
    assert.equal(listQRes.status, 200);
    assert.ok(
      listQRes.data.questions.some(
        (q) => Number(q.id) === Number(questionId) && q.answer.includes('24 horas')
      )
    );

    // 4. Verificar que el directorio exponga ficha comercial, urgencias, Q&A y tiempo de respuesta
    const dirRes = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirRes.status, 200);
    const entry = dirRes.data.providers.find((p) => Number(p.user_id) === Number(provUserId));
    assert.ok(entry);
    assert.equal(entry.accepts_emergencies, true);
    assert.equal(entry.quote_visit_policy, 'sin_cargo');
    assert.equal(entry.invoice_type, 'factura_c');
    assert.ok(entry.public_questions_count >= 1);
    assert.ok(entry.response_label, 'Debe calcular response_label a partir de visitas respondidas');

    // 5. Verificar que GET /api/v1/providers/me exponga commercial_profile, response_stats y public_questions
    const meRes = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.commercial_profile.accepts_emergencies, true);
    assert.ok(Array.isArray(meRes.data.public_questions) && meRes.data.public_questions.length >= 1);
  });

  // =========================================================================
  // FASE 10: Fase 5.3 — Catálogo Estándar Auto-Aprobado vs. Especialidad Personalizada Moderada + Compliance por Persona
  // =========================================================================
  it('auto-aprueba especialidades del catálogo estándar para prestador verificado y exige aprobación Ops para especialidades personalizadas (Fase 5.3)', async () => {
    const provAccount = await req('GET', '/api/v1/account/me', undefined, provToken);
    assert.equal(provAccount.status, 200);
    const provUserId = Number(provAccount.data.account?.id || provAccount.data.user?.id);

    // 1. El prestador ya está aprobado -> agrega un rubro del catálogo estándar ("Plomero") sin documentos nuevos -> debe auto-aprobarse
    const stdRes = await req(
      'POST',
      '/api/v1/providers/profile',
      { specialty: 'Plomero' },
      provToken
    );
    assert.equal(stdRes.status, 201);
    assert.equal(stdRes.data.auto_approved, true);
    assert.equal(stdRes.data.provider.status, 'approved');
    assert.equal(stdRes.data.provider.is_custom_specialty, false);

    // 2. El prestador propone una especialidad personalizada fuera del catálogo sin descripción -> debe rechazar 400 si marca is_custom_specialty=true
    const badCustom = await req(
      'POST',
      '/api/v1/providers/profile',
      { specialty: 'Domótica Residencial', is_custom_specialty: true, custom_specialty_description: 'abc' },
      provToken
    );
    assert.equal(badCustom.status, 400);

    // 3. Especialidad personalizada válida con descripción -> queda pendiente de moderación Ops y NO se auto-aprueba
    const customRes = await req(
      'POST',
      '/api/v1/providers/profile',
      {
        specialty: 'Domótica Residencial',
        is_custom_specialty: true,
        custom_specialty_description: 'Instalación y programación de domótica, cortinas y riego inteligente.',
      },
      provToken
    );
    assert.equal(customRes.status, 201);
    assert.equal(customRes.data.auto_approved, false);
    assert.equal(customRes.data.provider.status, 'pending');
    assert.equal(customRes.data.provider.is_custom_specialty, true);
    assert.equal(customRes.data.provider.specialty_approval_status, 'pending');
    const customProviderId = customRes.data.provider.id;

    // 4. Compliance a nivel persona (PATCH /compliance/user) aprueba rubros estándar pero mantiene el custom en revisión puntual
    const userApproveRes = await req(
      'PATCH',
      '/api/v1/providers/compliance/user',
      { user_id: provUserId, status: 'approved' },
      superToken
    );
    assert.equal(userApproveRes.status, 200);
    assert.ok(userApproveRes.data.pending_custom_specialties >= 1);

    // 5. Ops aprueba puntualmente la especialidad personalizada -> pasa a approved
    const approveCustom = await req(
      'PATCH',
      '/api/v1/providers/compliance',
      { provider_id: customProviderId, status: 'approved' },
      superToken
    );
    assert.equal(approveCustom.status, 200);
    assert.equal(approveCustom.data.provider.status, 'approved');
    assert.equal(approveCustom.data.provider.specialty_approval_status, 'approved');

    // 6. Editar especialidad estándar a otro rubro estándar sin cambiar documentos mantiene approved y NO duplica historial documental
    const meBeforeEdit = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(meBeforeEdit.status, 200);
    const docsCountBeforeEdit = (meBeforeEdit.data.document_history || []).length;

    const editStdRes = await req(
      'PATCH',
      `/api/v1/providers/profile/${stdRes.data.provider.id}`,
      { specialty: 'Carpintero', is_custom_specialty: false },
      provToken
    );
    assert.equal(editStdRes.status, 200);
    assert.equal(editStdRes.data.auto_approved, true);
    assert.equal(editStdRes.data.provider.status, 'approved');
    assert.equal(editStdRes.data.provider.specialty, 'Carpintero');
    assert.equal(editStdRes.data.provider.is_custom_specialty, false);

    const meAfterEdit = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal((meAfterEdit.data.document_history || []).length, docsCountBeforeEdit);

    // 6.5. Verificar que con múltiples especialidades aprobadas el directorio NO diluye `rating_avg` ni `reputation.score`
    const dirMultiSpec = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirMultiSpec.status, 200);
    const provInDir = dirMultiSpec.data.providers.find((p) => Number(p.user_id) === Number(provUserId));
    assert.ok(provInDir, 'El prestador multi-especialidad debe figurar en el directorio');
    assert.ok(Array.isArray(provInDir.specialties) && provInDir.specialties.length >= 2);
    assert.equal(
      Number(provInDir.rating_avg),
      Number(meAfterEdit.data.reputation.rating_avg),
      'El rating del directorio debe coincidir exactamente con el scoring real del prestador sin diluirse por especialidades sin reseñas'
    );
    assert.equal(
      Number(provInDir.reputation.score),
      Number(meAfterEdit.data.reputation.score),
      'El puntaje de reputación del directorio debe coincidir con el tablero Mi Reputación'
    );

    // 7. Renovar 1 documento personal (ART) lo propaga a todas las especialidades del usuario y agrega exactamente 1 versión al historial
    const renewedArtUrl = 'https://storage.trustlink.com/art_renovada_2027.pdf';
    const renewArtRes = await req(
      'PATCH',
      `/api/v1/providers/profile/${stdRes.data.provider.id}`,
      {
        insurance_policy_url: renewedArtUrl,
        insurance_expiry: '2028-06-30',
      },
      provToken
    );
    assert.equal(renewArtRes.status, 200);
    assert.equal(renewArtRes.data.provider.status, 'pending');

    const meAfterRenew = await req('GET', '/api/v1/providers/me', undefined, provToken);
    assert.equal(meAfterRenew.status, 200);
    assert.equal((meAfterRenew.data.document_history || []).length, docsCountBeforeEdit + 1);
    assert.ok(
      meAfterRenew.data.providers.every((p) => p.insurance_policy_url === renewedArtUrl),
      'La renovación de ART debe sincronizarse en todas las especialidades del mismo prestador'
    );
  });

  // =========================================================================
  // FASE 11: Fase 5.4 — Calendario Vivo (Jornada Semanal, Franjas cada 30 min y Privacidad Residente)
  // =========================================================================
  it('configura jornada semanal cada 30 min, bloquea trabajo externo y expone disponibilidad privada al residente (Fase 5.4)', async () => {
    const provAccount = await req('GET', '/api/v1/account/me', undefined, provToken);
    assert.equal(provAccount.status, 200);
    const provUserId = Number(provAccount.data.account?.id || provAccount.data.user?.id);

    // 1. Configurar jornada semanal: Lun-Vie 09:00..17:00, Sáb y Dom no laborables, franjas cada 30 min
    const rulesPayload = [
      { day_of_week: 1, is_working: true, start_time: '09:00', end_time: '17:00', slot_minutes: 30 },
      { day_of_week: 2, is_working: true, start_time: '09:00', end_time: '17:00', slot_minutes: 30 },
      { day_of_week: 3, is_working: true, start_time: '09:00', end_time: '17:00', slot_minutes: 30 },
      { day_of_week: 4, is_working: true, start_time: '09:00', end_time: '17:00', slot_minutes: 30 },
      { day_of_week: 5, is_working: true, start_time: '09:00', end_time: '17:00', slot_minutes: 30 },
      { day_of_week: 6, is_working: false, start_time: '09:00', end_time: '13:00', slot_minutes: 30 },
      { day_of_week: 0, is_working: false, start_time: '09:00', end_time: '13:00', slot_minutes: 30 },
    ];
    const saveRulesRes = await req(
      'PUT',
      '/api/v1/passes/schedule/rules',
      { slot_minutes: 30, rules: rulesPayload },
      provToken
    );
    assert.equal(saveRulesRes.status, 200);
    assert.equal(saveRulesRes.data.slot_minutes, 30);
    assert.equal(saveRulesRes.data.rules.length, 7);

    // 2. Bloquear un trabajo externo en el próximo Miércoles (2026-12-02) de 10:00 a 11:00 (Argentina UTC-3 = 13:00Z..14:00Z)
    const targetDate = '2026-12-02';
    const extBlockRes = await req(
      'POST',
      '/api/v1/passes/schedule/blocks',
      {
        block_type: 'external_visit',
        title: 'Obra confidencial cliente externo',
        start_at: `${targetDate}T13:00:00.000Z`,
        end_at: `${targetDate}T14:00:00.000Z`,
      },
      provToken
    );
    assert.equal(extBlockRes.status, 201);
    const createdBlockId = extBlockRes.data.block.id;

    // 3. El prestador ve su calendario vivo con detalle completo del trabajo externo en 10:00 y 10:30
    const provSchedRes = await req(
      'GET',
      `/api/v1/passes/schedule/provider?start_date=${targetDate}&days=3&tz_offset=180`,
      undefined,
      provToken
    );
    assert.equal(provSchedRes.status, 200);
    assert.equal(provSchedRes.data.calendar_days.length, 3);
    const provDay = provSchedRes.data.calendar_days[0];
    assert.equal(provDay.slots.length, 16); // 09:00..17:00 cada 30 min = 16 franjas
    const provSlot1000 = provDay.slots.find((s) => s.time === '10:00');
    const provSlot1030 = provDay.slots.find((s) => s.time === '10:30');
    const provSlot1100 = provDay.slots.find((s) => s.time === '11:00');
    assert.equal(provSlot1000.status, 'busy');
    assert.equal(provSlot1030.status, 'busy');
    assert.equal(provSlot1000.block.title, 'Obra confidencial cliente externo');
    assert.equal(provSlot1100.status, 'available');

    // 4. El residente consulta disponibilidad pública -> ve 10:00/10:30 ocupadas y 11:00 libre, SIN título privado
    const resAvail = await req(
      'GET',
      `/api/v1/passes/schedule/availability/${provUserId}?start_date=${targetDate}&days=3&tz_offset=180`,
      undefined,
      ownerToken
    );
    assert.equal(resAvail.status, 200);
    assert.equal(resAvail.data.days.length, 3);
    const resDay = resAvail.data.days[0];
    const resSlot1000 = resDay.slots.find((s) => s.time === '10:00');
    const resSlot1100 = resDay.slots.find((s) => s.time === '11:00');
    assert.equal(resSlot1000.status, 'busy');
    assert.equal(resSlot1000.block, undefined, 'Nunca debe exponer metadatos privados al residente');
    assert.equal(resSlot1100.status, 'available');

    // 5. Liberar el trabajo externo -> vuelve a quedar disponible
    const delBlock = await req('DELETE', `/api/v1/passes/schedule/blocks/${createdBlockId}`, undefined, provToken);
    assert.equal(delBlock.status, 200);

    // 6. Circuito completo de acuerdo mutuo de visita con ventana mínima 1h y estado tentativo:
    //    Residente pide turno (10:00->11:00) -> Prestador ve "tentative" en 3. Agenda pero otro residente aún ve "available"
    //    -> Prestador repacta a 11:30 (pending_resident) -> Residente acepta (confirmed) -> Bloqueo definitivo (11:30 y 12:00 busy)
    const meProv = await req('GET', '/api/v1/providers/me', undefined, provToken);
    const activeProvId = meProv.data.providers[0].id;
    const reqVisit = await req(
      'POST',
      '/api/v1/passes/visit-requests',
      {
        provider_id: activeProvId,
        preferred_date: `${targetDate}T13:00:00.000Z`,
        duration_minutes: 60,
        notes: '¿Podés pasar el miércoles de 10:00 a 11:00?',
      },
      ownerToken
    );
    assert.equal(reqVisit.status, 201);
    assert.equal(reqVisit.data.visit.status, 'pending_provider');
    assert.ok(reqVisit.data.visit.preferred_end_date, 'Debe calcular y guardar preferred_end_date (mínimo +1h)');
    const negVisitId = reqVisit.data.visit.id;

    // 6.1. En la agenda del prestador debe figurar como "tentative" (10:00 y 10:30), pero SIN bloquear aún a residentes
    const provTentativeRes = await req(
      'GET',
      `/api/v1/passes/schedule/provider?start_date=${targetDate}&days=1&tz_offset=180`,
      undefined,
      provToken
    );
    assert.equal(provTentativeRes.status, 200);
    assert.equal(provTentativeRes.data.calendar_days[0].tentative_count, 2);
    assert.equal(
      provTentativeRes.data.calendar_days[0].slots.find((s) => s.time === '10:00').status,
      'tentative'
    );
    assert.equal(
      provTentativeRes.data.calendar_days[0].slots.find((s) => s.time === '10:30').status,
      'tentative'
    );

    const resAvailWhilePending = await req(
      'GET',
      `/api/v1/passes/schedule/availability/${provUserId}?start_date=${targetDate}&days=1&tz_offset=180`,
      undefined,
      ownerToken
    );
    assert.equal(
      resAvailWhilePending.data.days[0].slots.find((s) => s.time === '10:00').status,
      'available',
      'Una solicitud pendiente NO debe bloquear la franja para otros residentes hasta ser confirmada'
    );

    // 6.2. Prestador repacta a las 11:30 (14:30Z -> 15:30Z) -> pasa a pending_resident
    const repactRes = await req(
      'PATCH',
      `/api/v1/passes/visit-requests/${negVisitId}/respond`,
      {
        action: 'propose',
        preferred_date: `${targetDate}T14:30:00.000Z`,
        reply_text: 'A las 10 estoy en obra, ¿te sirve 11:30?',
      },
      provToken
    );
    assert.equal(repactRes.status, 200);
    assert.equal(repactRes.data.visit.status, 'pending_resident');

    // 6.3. Residente acepta el horario propuesto -> pasa a confirmed y bloquea definitivamente 11:30 y 12:00 para todos
    const acceptRes = await req(
      'PATCH',
      `/api/v1/passes/visit-requests/${negVisitId}/resident-respond`,
      { action: 'accept' },
      ownerToken
    );
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.data.visit.status, 'confirmed');

    const resAvailAfterAgreement = await req(
      'GET',
      `/api/v1/passes/schedule/availability/${provUserId}?start_date=${targetDate}&days=1&tz_offset=180`,
      undefined,
      ownerToken
    );
    assert.equal(resAvailAfterAgreement.status, 200);
    const slot1130 = resAvailAfterAgreement.data.days[0].slots.find((s) => s.time === '11:30');
    const slot1200 = resAvailAfterAgreement.data.days[0].slots.find((s) => s.time === '12:00');
    assert.equal(slot1130.status, 'busy', 'La visita acordada debe bloquear 11:30 en la agenda pública');
    assert.equal(slot1200.status, 'busy', 'La visita acordada de 1 hora debe bloquear también 12:00');
  });

  // ===========================================================================
  // TEST 21: Analítica de usuarios, `initial_role` inmutable e identidad dual
  // ===========================================================================
  it('preserva initial_role ante cambios de identidad dual y expone analítica consolidada al Superadmin (Fase 5.5)', async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const dualEmail = `dual.origin.${suffix}@test.com`;

    // 1. Registrar una cuenta que nace como Residente (`owner`)
    const regDual = await req('POST', '/api/v1/auth/register', {
      country_id: 1,
      role: 'owner',
      first_name: 'Origen',
      last_name: 'Residente',
      dni: `94${suffix.slice(-6)}`,
      email: dualEmail,
      password: 'Password123!',
      fraction_type: 'fraccion',
      fraction_number: '2',
      lot_number: '44',
    });
    assert.equal(regDual.status, 201);
    assert.equal(regDual.data.user.initial_role, 'owner');

    const loginDual = await req('POST', '/api/v1/auth/login', {
      email: dualEmail,
      password: 'Password123!',
    });
    assert.equal(loginDual.status, 200);
    const dualToken = loginDual.data.token;

    // 2. Activar portal Prestador y cambiar portal principal a `provider` (sobrescribe `role` -> 'provider')
    const actProv = await req(
      'PATCH',
      '/api/v1/account/profile',
      { activate_provider_portal: true },
      dualToken
    );
    assert.equal(actProv.status, 200);

    const switchPrimary = await req(
      'PATCH',
      '/api/v1/account/primary-portal',
      { primary_portal: 'provider' },
      actProv.data.token || dualToken
    );
    assert.equal(switchPrimary.status, 200);
    assert.equal(switchPrimary.data.account.role, 'provider');

    // 3. Un usuario estándar NO puede consultar la analítica maestra
    const forbiddenRes = await req(
      'GET',
      '/api/v1/auth/users/analytics',
      undefined,
      switchPrimary.data.token || dualToken
    );
    assert.equal(forbiddenRes.status, 403);

    // 4. Superadmin consulta los 3 bloques de analítica (histórico y 7d) y verifica conversión cruzada
    const analyticsRes = await req(
      'GET',
      '/api/v1/auth/users/analytics?period=7d&country_id=1',
      undefined,
      superToken
    );
    assert.equal(analyticsRes.status, 200);
    const { block1_identity: b1, block2_activation: b2, block3_operations: b3 } = analyticsRes.data;

    assert.ok(b1.total_community_users >= 2, 'Debe contabilizar usuarios comunitarios');
    assert.ok(b1.created_as_resident >= 1, 'Debe conservar el origen inicial como Residente');
    assert.ok(b1.created_as_provider >= 1, 'Debe contabilizar el origen inicial como Prestador');
    assert.ok(b1.dual_accounts >= 1, 'Debe detectar cuentas duales activas');
    assert.ok(
      b1.resident_to_provider_count >= 1,
      'Debe detectar residentes de origen que activaron portal prestador incluso tras cambiar primary_portal'
    );
    assert.ok(b2.providers_registered >= 1 && b2.residents_registered >= 1);
    assert.ok(b3.growth.last_7d_total >= 1);
    assert.ok(Array.isArray(b3.by_community) && b3.by_community.length >= 1);

    // 5. Directorio nominal de cuentas generales (comunidad): filtro por origen + perfil dual y toggle seguro
    const commForbidden = await req(
      'GET',
      '/api/v1/auth/users/community',
      undefined,
      switchPrimary.data.token || dualToken
    );
    assert.equal(commForbidden.status, 403);

    const commListRes = await req(
      'GET',
      `/api/v1/auth/users/community?search=${encodeURIComponent(dualEmail)}&initial_origin=resident&current_profile=dual`,
      undefined,
      superToken
    );
    assert.equal(commListRes.status, 200);
    assert.equal(commListRes.data.users.length, 1);
    const listedDual = commListRes.data.users[0];
    assert.equal(listedDual.initial_origin, 'resident');
    assert.equal(listedDual.current_profile, 'dual');
    assert.equal(listedDual.is_active, true);

    const suspendRes = await req(
      'PATCH',
      `/api/v1/auth/users/community/${listedDual.id}/toggle`,
      { is_active: false },
      superToken
    );
    assert.equal(suspendRes.status, 200);
    assert.equal(suspendRes.data.user.is_active, false);

    const reactivateRes = await req(
      'PATCH',
      `/api/v1/auth/users/community/${listedDual.id}/toggle`,
      { is_active: true },
      superToken
    );
    assert.equal(reactivateRes.status, 200);
    assert.equal(reactivateRes.data.user.is_active, true);
  });

  // =========================================================================
  // 22. FASE 6.1: CONFIANZA PROGRESIVA (NIVELES 0..5), IDENTIDAD Y FILTRO VERIFICADOS
  // =========================================================================
  it('habilita visibilidad progresiva Nivel 1..5 con identidad validada, exige Nivel 4 para Socio Verificado y filtra Solo Verificados (Fase 6.1)', async () => {
    const ts = Date.now();
    const p6Email = `phase61.prov.${ts}@test.com`;
    const p6Dni = `${String(ts).slice(-6)}96`;

    // 1. Alta de prestador nuevo con especialidad estándar (sin identidad validada ni docs -> Nivel 0, oculto)
    const reg = await req('POST', '/api/v1/auth/register', {
      first_name: 'Progresivo',
      last_name: 'Fase61',
      dni: p6Dni,
      email: p6Email,
      password: 'Password123!',
      role: 'provider',
      country_id: 1,
    });
    assert.equal(reg.status, 201);
    const login = await req('POST', '/api/v1/auth/login', {
      email: p6Email,
      password: 'Password123!',
    });
    assert.equal(login.status, 200);
    const p6Token = login.data.token;
    const p6UserId = login.data.user.id;
    createdUserIds.push(p6UserId);

    const addSpec = await req(
      'POST',
      '/api/v1/providers/profile',
      { specialty: 'Plomero' },
      p6Token
    );
    assert.equal(addSpec.status, 201);
    const p6ProfId = addSpec.data.provider.id;

    const dirBeforeId = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirBeforeId.status, 200);
    assert.equal(
      dirBeforeId.data.providers.some((p) => Number(p.user_id) === Number(p6UserId)),
      false,
      'Sin identidad validada (Nivel 0) no debe aparecer en el directorio'
    );

    // 1.5. Prestador carga su archivo/enlace de DNI y verifica que /me y /all lo expongan
    const dniDocUrl = 'https://docs.test/dni-progresivo-p61.pdf';
    const uploadDniRes = await req(
      'PATCH',
      '/api/v1/providers/identity/document',
      { dni_document_url: dniDocUrl },
      p6Token
    );
    assert.equal(uploadDniRes.status, 200);
    assert.equal(uploadDniRes.data.user.dni_document_url, dniDocUrl);

    const meWithDni = await req('GET', '/api/v1/providers/me', undefined, p6Token);
    assert.equal(meWithDni.status, 200);
    assert.equal(meWithDni.data.dni_document_url, dniDocUrl);
    assert.equal(meWithDni.data.trust_level, 0);

    // 2. Superadmin valida DNI -> pasa a Nivel 1 (Perfil Básico), visible en directorio pero sin Pase QR
    const verifyId = await req(
      'PATCH',
      '/api/v1/providers/identity/verify',
      { user_id: p6UserId, verified: true },
      superToken
    );
    assert.equal(verifyId.status, 200);
    assert.equal(verifyId.data.user.identity_verified, true);

    const dirLevel1 = await req('GET', '/api/v1/providers/directory', undefined, ownerToken);
    assert.equal(dirLevel1.status, 200);
    const entryL1 = dirLevel1.data.providers.find((p) => Number(p.user_id) === Number(p6UserId));
    assert.ok(entryL1, 'Con identidad validada + rubro debe aparecer como Nivel 1');
    assert.equal(entryL1.trust_level, 1);
    assert.equal(entryL1.trust_badge.label, 'Perfil Básico');
    assert.equal(entryL1.is_verified, false);
    assert.equal(entryL1.can_issue_pass, false);

    // Con ?verified_only=true NO debe aparecer un prestador Nivel 1
    const dirVerifiedOnly1 = await req(
      'GET',
      '/api/v1/providers/directory?verified_only=true',
      undefined,
      ownerToken
    );
    assert.equal(dirVerifiedOnly1.status, 200);
    assert.equal(
      dirVerifiedOnly1.data.providers.some((p) => Number(p.user_id) === Number(p6UserId)),
      false,
      'El filtro verified_only=true debe excluir prestadores Nivel 1..3'
    );

    // 3. Intentar activar Socio Verificado (Nivel 5) antes de Nivel 4 debe rechazarse con 403
    const earlySub = await req(
      'POST',
      '/api/v1/billing/provider/subscribe',
      { plan_code: 'verified_monthly' },
      p6Token
    );
    assert.equal(earlySub.status, 403);

    // 4. Cargar Antecedentes -> Nivel 2 (Antecedentes al día)
    const futureDate = '2029-12-31';
    const addCrim = await req(
      'PATCH',
      `/api/v1/providers/profile/${p6ProfId}`,
      {
        criminal_record_url: 'https://docs.test/antecedentes-p61.pdf',
        criminal_record_expiry: futureDate,
      },
      p6Token
    );
    assert.equal(addCrim.status, 200);
    const meL2 = await req('GET', '/api/v1/providers/me', undefined, p6Token);
    assert.equal(meL2.data.trust_level, 2);
    assert.equal(meL2.data.trust_badge.label, 'Antecedentes al día');

    // 5. Cargar Póliza ART -> Nivel 3 (Doc. en validación)
    const addArt = await req(
      'PATCH',
      `/api/v1/providers/profile/${p6ProfId}`,
      {
        insurance_policy_url: 'https://docs.test/art-p61.pdf',
        insurance_expiry: futureDate,
      },
      p6Token
    );
    assert.equal(addArt.status, 200);
    const meL3 = await req('GET', '/api/v1/providers/me', undefined, p6Token);
    assert.equal(meL3.data.trust_level, 3);
    assert.equal(meL3.data.trust_badge.label, 'Doc. en validación');

    // 6. Superadmin aprueba compliance -> Nivel 4 (Verificado), aparece en verified_only=true y habilita suscripción Nivel 5
    const approveP6 = await req(
      'PATCH',
      '/api/v1/providers/compliance/user',
      { user_id: p6UserId, status: 'approved' },
      superToken
    );
    assert.equal(approveP6.status, 200);

    const dirVerifiedOnly4 = await req(
      'GET',
      '/api/v1/providers/directory?verified_only=true',
      undefined,
      ownerToken
    );
    const entryL4 = dirVerifiedOnly4.data.providers.find(
      (p) => Number(p.user_id) === Number(p6UserId)
    );
    assert.ok(entryL4, 'Nivel 4 Verificado debe aparecer con verified_only=true');
    assert.equal(entryL4.trust_level, 4);
    assert.equal(entryL4.trust_badge.label, 'Verificado');
    assert.equal(entryL4.is_verified, true);
    assert.equal(entryL4.can_issue_pass, true);

    // 7. Ahora sí puede activar Socio Verificado -> sube a Nivel 5 (Socio Verificado dorado)
    const subOk = await req(
      'POST',
      '/api/v1/billing/provider/subscribe',
      { plan_code: 'verified_monthly' },
      p6Token
    );
    assert.equal(subOk.status, 201);

    const meL5 = await req('GET', '/api/v1/providers/me', undefined, p6Token);
    assert.equal(meL5.data.trust_level, 5);
    assert.equal(meL5.data.trust_badge.label, 'Socio Verificado');
    assert.equal(meL5.data.trust_badge.checks.pass_qr_ok, true);
    assert.equal(meL5.data.trust_badge.checks.member_ok, true);

    // 8. Vidriera pública sin autenticación (/api/v1/providers/public-showcase):
    //    debe exponer el prestador con su nivel N5/checks/categorías y omitir estrictamente PII (email/phone/dni/docs)
    const publicShowcase = await req('GET', '/api/v1/providers/public-showcase');
    assert.equal(publicShowcase.status, 200);
    assert.ok(publicShowcase.data.summary && typeof publicShowcase.data.summary.total_active_providers === 'number');
    assert.ok(Array.isArray(publicShowcase.data.categories));
    assert.ok(Array.isArray(publicShowcase.data.providers) && publicShowcase.data.providers.length >= 1);

    const publicP6 = publicShowcase.data.providers.find(
      (p) => String(p.display_name || '').includes('Progresivo Fase61')
    );
    assert.ok(publicP6, 'El prestador Nivel 5 debe figurar en la vidriera pública de la Landing');
    assert.equal(publicP6.trust_level, 5);
    assert.equal(publicP6.can_issue_pass, true);
    assert.equal(publicP6.trust_badge?.checks?.pass_qr_ok, true);
    assert.equal('email' in publicP6, false, 'La vidriera pública nunca debe exponer email');
    assert.equal('phone' in publicP6, false, 'La vidriera pública nunca debe exponer teléfono');
    assert.equal('dni' in publicP6, false, 'La vidriera pública nunca debe exponer DNI');
    assert.equal('dni_document_url' in publicP6, false, 'La vidriera pública nunca debe exponer documentos');
    assert.equal('criminal_record_url' in publicP6, false, 'La vidriera pública nunca debe exponer documentos');
    assert.equal('insurance_policy_url' in publicP6, false, 'La vidriera pública nunca debe exponer documentos');
    assert.equal('vehicles' in publicP6, false, 'La vidriera pública nunca debe exponer patentes');
    assert.equal('employees' in publicP6, false, 'La vidriera pública nunca debe exponer nómina');
  });
});
