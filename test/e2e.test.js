/**
 * @file e2e.test.js
 * @description Suite automatizada de pruebas de integración end-to-end para TrustLink Backend
 * usando el runner nativo `node:test`. Levanta una instancia aislada en puerto temporal,
 * valida todos los flujos críticos y limpia los registros temporales al finalizar.
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

const PORT = Number(process.env.TEST_PORT || 4197);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = 'tlk_e2e_webhook_secret';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

describe('TrustLink Backend — E2E Core Suite', () => {
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

  const ts = Date.now();

  before(async () => {
    serverProc = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: String(PORT), PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET },
      stdio: 'ignore',
    });

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

    superToken = jwt.sign(
      { userId: 1, countryId, role: 'superadmin', email: 'e2e-super@trustlink.local' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

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

  it('expone /health y catálogo público de comunidades en GET /api/v1/auth/countries', async () => {
    const h = await req('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.data.status, 'ONLINE');

    const c = await req('GET', '/api/v1/auth/countries');
    assert.equal(c.status, 200);
    assert.equal(Array.isArray(c.data.countries), true);
    assert.ok(c.data.countries.length >= 1);
  });

  it('bloquea registro público de roles privilegiados y permite alta protegida de security', async () => {
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

  it('registra owner y provider con ubicación normalizada y devuelve perfil enriquecido en login', async () => {
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

    superRealToken = jwt.sign(
      { userId: ownerUserId, countryId, role: 'superadmin', email: ownerEmail },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

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

  it('gestiona perfil documental (POST/PATCH), flota con seguro (POST/PATCH) y aprobación compliance', async () => {
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

    const approve = await req(
      'PATCH',
      '/api/v1/providers/compliance',
      { provider_id: providerId, status: 'approved' },
      superToken
    );
    assert.equal(approve.status, 200);
  });

  it('coordina visitas, emite/edita pases QR y aplica ingreso único + suspensión local en ambas garitas', async () => {
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

    const scan1 = await req('POST', '/api/v1/passes/verify', { qr_token: pass1Qr }, secToken);
    assert.equal(scan1.status, 200);
    assert.equal(scan1.data.details.status, 'used');

    const rescan1 = await req('POST', '/api/v1/passes/verify', { qr_token: pass1Qr }, secToken);
    assert.equal(rescan1.status, 403);
    assert.equal(rescan1.data.code, 'PASS_ALREADY_USED');

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

    const extBlocked = await req(
      'POST',
      '/api/v1/external/passes/verify',
      { qr_token: pass2Qr, country_id: countryId },
      secToken
    );
    assert.equal(extBlocked.status, 403);
    assert.equal(extBlocked.data.code, 'LOCAL_SUSPENSION_ACTIVE');

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

  it('procesa contratos, checkout 7%/93%, webhook HMAC y reseñas cruzadas bidireccionales', async () => {
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

  it('habilita identidad dual bidireccional y portal principal desde /api/v1/account', async () => {
    const me = await req('GET', '/api/v1/account/me', undefined, ownerToken);
    assert.equal(me.status, 200);
    assert.equal(Array.isArray(me.data.countries), true);

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

  it('envía cabeceras defensivas, permite recuperación de contraseña y CRUD de ayudantes/cuadrilla', async () => {
    const healthRes = await fetch(`${BASE}/health`);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(healthRes.headers.get('x-powered-by'), null);

    // Flujo forgot-password -> reset-password -> login con nueva contraseña
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

    // CRUD de ayudantes / cuadrilla del prestador
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
});
