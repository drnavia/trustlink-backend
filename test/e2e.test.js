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
});
