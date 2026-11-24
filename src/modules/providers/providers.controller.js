/**
 * @file providers.controller.js
 * @description Controlador completo del módulo de prestadores en TrustLink.
 * Gestiona credenciales/especialidades, historial de versiones documentales sin sobrescribir
 * registros anteriores, flota vehicular con seguro automotor, auditoría central,
 * directorio unificado para residentes (incluyendo la flota vehicular de cada prestador)
 * y suspensiones operativas locales.
 * @location /trustlink-backend/src/modules/providers/providers.controller.js
 */

const db = require('../../config/db');
const { ensureEvolutionSchema } = require('../../config/ensureEvolutionSchema');
const {
  MEMBERSHIP_PLANS,
  ensureProviderSubscriptionsTable,
  getActiveMembershipForUser,
} = require('../billing/billing.controller');

/**
 * Asegura la existencia de la tabla provider_document_versions de forma idempotente
 * para conservar todas las versiones cargadas (vigentes, vencidas o históricas).
 */
const ensureDocumentVersionsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.provider_document_versions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      provider_id INTEGER NULL REFERENCES public.providers(id) ON DELETE SET NULL,
      doc_type VARCHAR(40) NOT NULL CHECK (doc_type IN ('criminal', 'insurance')),
      document_url TEXT NOT NULL,
      valid_from DATE NULL,
      valid_to DATE NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
};

/**
 * Asegura que provider_vehicles cuente con los campos de seguro vehicular y vigencia.
 */
const ensureVehicleInsuranceColumns = async () => {
  await db.query(`
    ALTER TABLE public.provider_vehicles
    ADD COLUMN IF NOT EXISTS vehicle_insurance_url TEXT NULL,
    ADD COLUMN IF NOT EXISTS vehicle_insurance_from DATE NULL,
    ADD COLUMN IF NOT EXISTS vehicle_insurance_expiry DATE NULL;
  `);
};

/**
 * Asegura que provider_employees cuente con columnas para ayudantes/cuadrilla directa.
 */
const ensureProviderEmployeesColumns = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.provider_employees (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER REFERENCES public.providers(id) ON DELETE CASCADE,
      employee_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );
  `);
  await db.query(`
    ALTER TABLE public.provider_employees
    ADD COLUMN IF NOT EXISTS full_name VARCHAR(160) NULL,
    ADD COLUMN IF NOT EXISTS dni VARCHAR(30) NULL,
    ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL,
    ADD COLUMN IF NOT EXISTS role_label VARCHAR(80) DEFAULT 'Ayudante',
    ADD COLUMN IF NOT EXISTS insurance_policy_url TEXT NULL,
    ADD COLUMN IF NOT EXISTS insurance_expiry DATE NULL,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  `);
};

/**
 * Inserta una versión documental en el historial sin eliminar versiones previas.
 */
const recordDocumentVersion = async ({
  userId,
  providerId = null,
  docType,
  documentUrl,
  validFrom = null,
  validTo = null,
  status = 'pending'
}) => {
  if (!documentUrl || !String(documentUrl).trim()) return null;

  await ensureDocumentVersionsTable();

  const res = await db.query(
    `
      INSERT INTO public.provider_document_versions (
        user_id,
        provider_id,
        doc_type,
        document_url,
        valid_from,
        valid_to,
        status
      )
      VALUES ($1, $2, $3, $4, $5::date, $6::date, $7)
      RETURNING id, user_id, provider_id, doc_type, document_url, valid_from, valid_to, status, created_at;
    `,
    [
      userId,
      providerId,
      docType,
      String(documentUrl).trim(),
      validFrom || null,
      validTo || null,
      status || 'pending'
    ]
  );

  return res.rows[0] || null;
};

/**
 * Registra un nuevo perfil/especialidad para el prestador y guarda su versión documental
 * en el historial sin pisar cargas anteriores.
 */
const updateProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      specialty,
      criminal_record_url,
      criminal_record_from,
      criminal_record_expiry,
      insurance_policy_url,
      insurance_from,
      insurance_expiry
    } = req.body;

    if (!specialty || !String(specialty).trim()) {
      return res.status(400).json({ error: 'La especialidad del prestador es obligatoria.' });
    }

    const insertQuery = `
      INSERT INTO providers (
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        status
      )
      VALUES ($1, $2, $3, $4::date, $5, $6::date, 'pending')
      RETURNING
        id,
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        status,
        rating_avg,
        created_at;
    `;

    const values = [
      userId,
      String(specialty).trim(),
      criminal_record_url || null,
      criminal_record_expiry || null,
      insurance_policy_url || null,
      insurance_expiry || null
    ];

    const providerResult = await db.query(insertQuery, values);
    const createdProvider = providerResult.rows[0];

    if (criminal_record_url || criminal_record_expiry) {
      await recordDocumentVersion({
        userId,
        providerId: createdProvider.id,
        docType: 'criminal',
        documentUrl: criminal_record_url || 'Sin URL',
        validFrom: criminal_record_from || null,
        validTo: criminal_record_expiry || null,
        status: 'pending'
      });
    }

    if (insurance_policy_url || insurance_expiry) {
      await recordDocumentVersion({
        userId,
        providerId: createdProvider.id,
        docType: 'insurance',
        documentUrl: insurance_policy_url || 'Sin URL',
        validFrom: insurance_from || null,
        validTo: insurance_expiry || null,
        status: 'pending'
      });
    }

    return res.status(201).json({
      message: 'Perfil de compliance registrado y enviado a revisión con éxito.',
      provider: createdProvider
    });
  } catch (error) {
    console.error('Error al registrar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el perfil.' });
  }
};

/**
 * Edita un registro específico de compliance por su ID de provider
 * y registra la nueva versión documental en el historial sin borrar las anteriores.
 */
const editProviderProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const {
      specialty,
      criminal_record_url,
      criminal_record_from,
      criminal_record_expiry,
      insurance_policy_url,
      insurance_from,
      insurance_expiry
    } = req.body;

    const updateQuery = `
      UPDATE providers
      SET specialty = COALESCE($1, specialty),
          criminal_record_url = COALESCE($2, criminal_record_url),
          criminal_record_expiry = COALESCE($3::date, criminal_record_expiry),
          insurance_policy_url = COALESCE($4, insurance_policy_url),
          insurance_expiry = COALESCE($5::date, insurance_expiry),
          status = 'pending'
      WHERE id = $6 AND user_id = $7
      RETURNING
        id,
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        status,
        rating_avg,
        created_at;
    `;

    const result = await db.query(updateQuery, [
      specialty ? String(specialty).trim() : null,
      criminal_record_url || null,
      criminal_record_expiry || null,
      insurance_policy_url || null,
      insurance_expiry || null,
      id,
      userId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de prestador no encontrado o no autorizado.' });
    }

    const updatedProvider = result.rows[0];

    if (criminal_record_url || criminal_record_expiry) {
      await recordDocumentVersion({
        userId,
        providerId: updatedProvider.id,
        docType: 'criminal',
        documentUrl: criminal_record_url || 'Sin URL',
        validFrom: criminal_record_from || null,
        validTo: criminal_record_expiry || null,
        status: 'pending'
      });
    }

    if (insurance_policy_url || insurance_expiry) {
      await recordDocumentVersion({
        userId,
        providerId: updatedProvider.id,
        docType: 'insurance',
        documentUrl: insurance_policy_url || 'Sin URL',
        validFrom: insurance_from || null,
        validTo: insurance_expiry || null,
        status: 'pending'
      });
    }

    return res.status(200).json({
      message: 'Perfil y versión documental actualizados con éxito. Pendiente de aprobación.',
      provider: updatedProvider
    });
  } catch (error) {
    console.error('Error al editar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el perfil.' });
  }
};

/**
 * Agrega un vehículo asociado al prestador logueado, incluyendo su seguro automotor y fechas de vigencia.
 */
const addVehicle = async (req, res) => {
  try {
    await ensureVehicleInsuranceColumns();

    const userId = req.user.userId;
    const {
      vehicle_type,
      brand,
      model,
      color,
      plate,
      vehicle_insurance_url,
      vehicle_insurance_from,
      vehicle_insurance_expiry
    } = req.body;

    if (!plate || !String(plate).trim()) {
      return res.status(400).json({ error: 'La patente del vehículo es obligatoria.' });
    }

    const providerRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [userId]
    );

    let providerId;
    if (providerRes.rows.length === 0) {
      const newProv = await db.query(
        `
          INSERT INTO providers (user_id, specialty, status)
          VALUES ($1, 'Servicios Generales', 'pending')
          RETURNING id
        `,
        [userId]
      );
      providerId = newProv.rows[0].id;
    } else {
      providerId = providerRes.rows[0].id;
    }

    const vehicleQuery = `
      INSERT INTO provider_vehicles (
        provider_id,
        vehicle_type,
        brand,
        model,
        color,
        plate,
        vehicle_insurance_url,
        vehicle_insurance_from,
        vehicle_insurance_expiry
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date)
      RETURNING
        id,
        provider_id,
        vehicle_type,
        brand,
        model,
        color,
        plate,
        vehicle_insurance_url,
        vehicle_insurance_from,
        vehicle_insurance_expiry,
        created_at;
    `;

    const result = await db.query(vehicleQuery, [
      providerId,
      vehicle_type || 'Automóvil',
      brand ? String(brand).trim() : '',
      model ? String(model).trim() : '',
      color ? String(color).trim() : 'No especificado',
      String(plate).trim().toUpperCase(),
      vehicle_insurance_url ? String(vehicle_insurance_url).trim() : null,
      vehicle_insurance_from || null,
      vehicle_insurance_expiry || null
    ]);

    return res.status(201).json({
      message: 'Vehículo y seguro automotor registrados con éxito.',
      vehicle: result.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar vehículo:', error);
    return res.status(500).json({ error: 'Error interno al registrar vehículo.' });
  }
};

/**
 * Edita un vehículo existente del prestador, incluyendo seguro automotor y fechas de vigencia.
 */
const editVehicle = async (req, res) => {
  try {
    await ensureVehicleInsuranceColumns();

    const userId = req.user.userId;
    const { id } = req.params;
    const {
      vehicle_type,
      brand,
      model,
      color,
      plate,
      vehicle_insurance_url,
      vehicle_insurance_from,
      vehicle_insurance_expiry
    } = req.body;

    if (plate !== undefined && !String(plate).trim()) {
      return res.status(400).json({ error: 'La patente del vehículo no puede quedar vacía.' });
    }

    const providerRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    if (providerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }
    const providerIds = providerRes.rows.map((p) => p.id);

    const updateQuery = `
      UPDATE provider_vehicles
      SET vehicle_type = COALESCE($1, vehicle_type),
          brand = COALESCE($2, brand),
          model = COALESCE($3, model),
          color = COALESCE($4, color),
          plate = COALESCE($5, plate),
          vehicle_insurance_url = $6,
          vehicle_insurance_from = $7::date,
          vehicle_insurance_expiry = $8::date
      WHERE id = $9 AND provider_id = ANY($10::int[])
      RETURNING
        id,
        provider_id,
        vehicle_type,
        brand,
        model,
        color,
        plate,
        vehicle_insurance_url,
        vehicle_insurance_from,
        vehicle_insurance_expiry,
        created_at;
    `;

    const result = await db.query(updateQuery, [
      vehicle_type || null,
      brand !== undefined ? String(brand).trim() : null,
      model !== undefined ? String(model).trim() : null,
      color !== undefined ? String(color).trim() : null,
      plate !== undefined ? String(plate).trim().toUpperCase() : null,
      vehicle_insurance_url !== undefined ? String(vehicle_insurance_url).trim() || null : null,
      vehicle_insurance_from || null,
      vehicle_insurance_expiry || null,
      id,
      providerIds
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vehículo no encontrado o no autorizado.' });
    }

    return res.status(200).json({
      message: 'Vehículo y seguro automotor actualizados con éxito.',
      vehicle: result.rows[0]
    });
  } catch (error) {
    console.error('Error al editar vehículo:', error);
    return res.status(500).json({ error: 'Error interno al actualizar vehículo.' });
  }
};

/**
 * Calcula alertas de vencimiento (vencidos o próximos a vencer dentro de `windowDays` días)
 * para documentación personal, flota vehicular y cuadrilla de ayudantes.
 */
const evaluateExpiryDate = (rawDate, windowDays = 30) => {
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const diffDays = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return {
      severity: 'expired',
      days_remaining: diffDays,
      expiry_date: target.toISOString().slice(0, 10),
    };
  }
  if (diffDays <= windowDays) {
    return {
      severity: 'expiring_soon',
      days_remaining: diffDays,
      expiry_date: target.toISOString().slice(0, 10),
    };
  }
  return null;
};

const buildProviderExpiryAlerts = ({
  providers = [],
  vehicles = [],
  employees = [],
  windowDays = 30,
  providerMetaById = {},
}) => {
  const alerts = [];

  providers.forEach((p) => {
    const meta = providerMetaById[p.id] || {};
    const ownerLabel = meta.provider_name || p.specialty || `Perfil #${p.id}`;

    const crimEval = evaluateExpiryDate(p.criminal_record_expiry, windowDays);
    if (crimEval) {
      alerts.push({
        id: `criminal-${p.id}`,
        provider_id: p.id,
        provider_name: meta.provider_name || null,
        provider_phone: meta.provider_phone || null,
        provider_email: meta.provider_email || null,
        category: 'criminal_record',
        target_step: 'credentials',
        title: 'Antecedentes Penales',
        subtitle: `${ownerLabel}${p.specialty ? ` · ${p.specialty}` : ''}`,
        ...crimEval,
      });
    }

    const insEval = evaluateExpiryDate(p.insurance_expiry, windowDays);
    if (insEval) {
      alerts.push({
        id: `insurance-${p.id}`,
        provider_id: p.id,
        provider_name: meta.provider_name || null,
        provider_phone: meta.provider_phone || null,
        provider_email: meta.provider_email || null,
        category: 'provider_art',
        target_step: 'credentials',
        title: 'Póliza ART / Seguro Personal',
        subtitle: `${ownerLabel}${p.specialty ? ` · ${p.specialty}` : ''}`,
        ...insEval,
      });
    }
  });

  vehicles.forEach((v) => {
    const meta = providerMetaById[v.provider_id] || {};
    const vehEval = evaluateExpiryDate(v.vehicle_insurance_expiry, windowDays);
    if (vehEval) {
      alerts.push({
        id: `vehicle-${v.id}`,
        provider_id: v.provider_id,
        provider_name: meta.provider_name || null,
        provider_phone: meta.provider_phone || null,
        provider_email: meta.provider_email || null,
        category: 'vehicle_insurance',
        target_step: 'vehicles',
        title: `Seguro Vehicular (${v.plate || 'Sin patente'})`,
        subtitle: [meta.provider_name, [v.brand, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Vehículo registrado',
        ...vehEval,
      });
    }
  });

  employees
    .filter((e) => e.is_active !== false)
    .forEach((emp) => {
      const meta = providerMetaById[emp.provider_id] || {};
      const empEval = evaluateExpiryDate(emp.insurance_expiry, windowDays);
      if (empEval) {
        alerts.push({
          id: `employee-${emp.id}`,
          provider_id: emp.provider_id,
          provider_name: meta.provider_name || null,
          provider_phone: meta.provider_phone || null,
          provider_email: meta.provider_email || null,
          category: 'employee_art',
          target_step: 'vehicles',
          title: `ART Ayudante: ${emp.full_name || 'Sin nombre'}`,
          subtitle: [meta.provider_name, emp.dni ? `DNI ${emp.dni}` : null, emp.role_label].filter(Boolean).join(' · '),
          ...empEval,
        });
      }
    });

  alerts.sort((a, b) => a.days_remaining - b.days_remaining);
  return alerts;
};

/**
 * Obtiene especialidades, historial completo de versiones documentales
 * y flota vehicular del prestador logueado.
 */
const getMyProviderProfile = async (req, res) => {
  try {
    await ensureDocumentVersionsTable();
    await ensureVehicleInsuranceColumns();
    await ensureProviderEmployeesColumns();

    const userId = req.user.userId;
    const providersRes = await db.query(
      `
        SELECT
          id,
          specialty,
          criminal_record_url,
          criminal_record_expiry,
          insurance_policy_url,
          insurance_expiry,
          status,
          rating_avg,
          created_at
        FROM providers
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
      `,
      [userId]
    );

    const versionsRes = await db.query(
      `
        SELECT
          id,
          provider_id,
          doc_type,
          document_url,
          valid_from,
          valid_to,
          status,
          created_at
        FROM public.provider_document_versions
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
      `,
      [userId]
    );

    let vehicles = [];
    let employees = [];
    if (providersRes.rows.length > 0) {
      const providerIds = providersRes.rows.map((p) => p.id);
      const [vehiclesRes, employeesRes] = await Promise.all([
        db.query(
          `
            SELECT
              id,
              provider_id,
              vehicle_type,
              brand,
              model,
              color,
              plate,
              vehicle_insurance_url,
              vehicle_insurance_from,
              vehicle_insurance_expiry,
              created_at
            FROM provider_vehicles
            WHERE provider_id = ANY($1::int[])
            ORDER BY id DESC
          `,
          [providerIds]
        ),
        db.query(
          `
            SELECT
              pe.id,
              pe.provider_id,
              pe.employee_user_id,
              COALESCE(pe.full_name, TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) AS full_name,
              COALESCE(pe.dni, u.dni) AS dni,
              COALESCE(pe.phone, u.phone) AS phone,
              COALESCE(pe.role_label, 'Ayudante') AS role_label,
              pe.insurance_policy_url,
              pe.insurance_expiry,
              pe.is_active,
              pe.created_at
            FROM public.provider_employees pe
            LEFT JOIN public.users u ON u.id = pe.employee_user_id
            WHERE pe.provider_id = ANY($1::int[])
            ORDER BY pe.id DESC
          `,
          [providerIds]
        ),
      ]);
      vehicles = vehiclesRes.rows;
      employees = employeesRes.rows;
    }

    const [expiryAlerts, membership] = await Promise.all([
      Promise.resolve(
        buildProviderExpiryAlerts({
          providers: providersRes.rows,
          vehicles,
          employees,
          windowDays: 30,
        })
      ),
      getActiveMembershipForUser(userId),
    ]);

    return res.status(200).json({
      providers: providersRes.rows,
      document_history: versionsRes.rows,
      vehicles,
      employees,
      expiry_alerts: expiryAlerts,
      membership,
      membership_plans: MEMBERSHIP_PLANS,
    });
  } catch (error) {
    console.error('Error al obtener perfil del prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

/**
 * Lista TODOS los prestadores registrados para auditoría centralizada en Ops TrustLink.
 */
const listAllProvidersForOps = async (req, res) => {
  try {
    await ensureProviderSubscriptionsTable();
    const query = `
      SELECT
        u.id AS user_id,
        p.id AS provider_id,
        u.first_name,
        u.last_name,
        u.dni,
        u.email,
        COALESCE(p.specialty, 'Sin especificar (Perfil Incompleto)') AS specialty,
        p.criminal_record_url,
        p.criminal_record_expiry,
        p.insurance_policy_url,
        p.insurance_expiry,
        COALESCE(p.status::text, 'sin_perfil') AS status,
        COALESCE(p.rating_avg, 0.00) AS rating_avg,
        COALESCE(p.created_at, u.created_at) AS created_at,
        COALESCE(sub.is_verified_member, FALSE) AS is_verified_member,
        sub.plan_code AS membership_tier,
        sub.status AS membership_status,
        sub.ends_at AS membership_ends_at
      FROM users u
      LEFT JOIN providers p ON u.id = p.user_id
      LEFT JOIN LATERAL (
        SELECT
          ps.plan_code,
          ps.status,
          ps.ends_at,
          (ps.status IN ('active', 'trialing') AND ps.ends_at > NOW()) AS is_verified_member
        FROM public.provider_subscriptions ps
        WHERE ps.user_id = u.id
        ORDER BY
          CASE WHEN ps.status IN ('active', 'trialing') AND ps.ends_at > NOW() THEN 0 ELSE 1 END ASC,
          ps.ends_at DESC,
          ps.id DESC
        LIMIT 1
      ) sub ON TRUE
      WHERE p.id IS NOT NULL
         OR (
           LOWER(COALESCE(u.role::text, '')) NOT IN ('superadmin', 'admin', 'security')
           AND (LOWER(COALESCE(u.role::text, '')) = 'provider' OR COALESCE(u.can_use_provider, FALSE) = TRUE)
         )
      ORDER BY
        CASE COALESCE(p.status::text, 'sin_perfil')
          WHEN 'pending' THEN 0
          WHEN 'approved' THEN 1
          WHEN 'rejected' THEN 2
          ELSE 3
        END ASC,
        COALESCE(sub.is_verified_member, FALSE) DESC,
        COALESCE(p.rating_avg, 0.00) DESC,
        u.id ASC;
    `;
    const result = await db.query(query);
    return res.status(200).json({ count: result.rows.length, providers: result.rows });
  } catch (error) {
    console.error('Error al listar prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno.' });
  }
};

/**
 * Actualiza el estado de compliance de un prestador y sincroniza versiones documentales asociadas.
 */
const updateComplianceStatus = async (req, res) => {
  try {
    await ensureDocumentVersionsTable();

    const { provider_id, user_id, status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    let targetProviderId = provider_id;
    if (!targetProviderId && user_id) {
      const existing = await db.query(
        'SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [user_id]
      );
      if (existing.rows.length > 0) {
        targetProviderId = existing.rows[0].id;
      } else {
        const newProv = await db.query(
          `
            INSERT INTO providers (user_id, specialty, status)
            VALUES ($1, 'Servicios Generales', $2)
            RETURNING id
          `,
          [user_id, status]
        );
        targetProviderId = newProv.rows[0].id;
      }
    }

    const updateQuery = `
      UPDATE providers
      SET status = $1
      WHERE id = $2
      RETURNING id, user_id, specialty, status;
    `;

    const result = await db.query(updateQuery, [status, targetProviderId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado en la base de datos.' });
    }

    const updatedProvider = result.rows[0];
    await db.query(
      `
        UPDATE public.provider_document_versions
        SET status = $1
        WHERE provider_id = $2 OR user_id = $3
      `,
      [status, updatedProvider.id, updatedProvider.user_id]
    );

    return res.status(200).json({
      message: `Estado de compliance actualizado exitosamente a: ${status}`,
      provider: updatedProvider
    });
  } catch (error) {
    console.error('Error al actualizar compliance:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar la solicitud.' });
  }
};

/**
 * Lista los prestadores verificados unificados por usuario (u.id) para el Portal Residente,
 * incluyendo la flota vehicular registrada (`vehicles`) de cada prestador para seleccionarla al emitir QR.
 */
const listVerifiedProviders = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    await ensureProviderSubscriptionsTable();
    await ensureVehicleInsuranceColumns();
    await ensureProviderEmployeesColumns();

    const query = `
      WITH approved_profiles AS (
        SELECT
          p.id AS provider_id,
          p.user_id,
          u.first_name,
          u.last_name,
          u.phone,
          u.email,
          p.specialty,
          p.criminal_record_expiry,
          p.insurance_expiry,
          COALESCE(p.rating_avg, 0.00)::numeric(4,2) AS rating_avg,
          p.id AS ordered_id,
          (
            SELECT COUNT(*)::int
            FROM service_contracts sc
            WHERE sc.provider_id = p.id
          ) AS profile_jobs
        FROM providers p
        JOIN users u ON p.user_id = u.id
        WHERE p.status = 'approved'::provider_status
          AND COALESCE(u.is_active, TRUE) = TRUE
          AND COALESCE(u.can_use_provider, FALSE) = TRUE
      )
      SELECT
        (ARRAY_AGG(ap.provider_id ORDER BY ap.ordered_id ASC))[1] AS provider_id,
        ARRAY_AGG(ap.provider_id ORDER BY ap.ordered_id ASC) AS provider_ids,
        ap.user_id,
        ap.first_name,
        ap.last_name,
        ap.phone,
        ap.email,
        STRING_AGG(DISTINCT ap.specialty, ' · ' ORDER BY ap.specialty) AS specialties_label,
        ARRAY_AGG(DISTINCT ap.specialty ORDER BY ap.specialty) AS specialties,
        (ARRAY_AGG(ap.specialty ORDER BY ap.ordered_id ASC))[1] AS specialty,
        ROUND(AVG(ap.rating_avg)::numeric, 2) AS rating_avg,
        COALESCE(SUM(ap.profile_jobs), 0)::int AS total_jobs,
        COALESCE(sub.is_verified_member, FALSE) AS is_verified_member,
        sub.plan_code AS membership_tier,
        sub.ends_at AS membership_ends_at,
        (
          BOOL_OR(ap.criminal_record_expiry IS NOT NULL AND ap.criminal_record_expiry < CURRENT_DATE)
          OR BOOL_OR(ap.insurance_expiry IS NOT NULL AND ap.insurance_expiry < CURRENT_DATE)
        ) AS has_expired_docs,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', pv.id,
                'vehicle_type', pv.vehicle_type,
                'brand', pv.brand,
                'model', pv.model,
                'color', pv.color,
                'plate', pv.plate
              )
              ORDER BY pv.id DESC
            )
            FROM provider_vehicles pv
            JOIN providers p2 ON p2.id = pv.provider_id
            WHERE p2.user_id = ap.user_id
          ),
          '[]'::json
        ) AS vehicles,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', pe.id,
                'full_name', COALESCE(pe.full_name, TRIM(CONCAT(COALESCE(u_emp.first_name, ''), ' ', COALESCE(u_emp.last_name, '')))),
                'dni', COALESCE(pe.dni, u_emp.dni),
                'role_label', COALESCE(pe.role_label, 'Ayudante'),
                'insurance_expiry', pe.insurance_expiry,
                'is_active', pe.is_active
              )
              ORDER BY pe.id DESC
            )
            FROM public.provider_employees pe
            JOIN providers p3 ON p3.id = pe.provider_id
            LEFT JOIN public.users u_emp ON u_emp.id = pe.employee_user_id
            WHERE p3.user_id = ap.user_id AND COALESCE(pe.is_active, TRUE) = TRUE
          ),
          '[]'::json
        ) AS employees
      FROM approved_profiles ap
      LEFT JOIN LATERAL (
        SELECT
          ps.plan_code,
          ps.ends_at,
          TRUE AS is_verified_member
        FROM public.provider_subscriptions ps
        WHERE ps.user_id = ap.user_id
          AND ps.status IN ('active', 'trialing')
          AND ps.ends_at > NOW()
        ORDER BY
          CASE WHEN ps.plan_code = 'verified_pro' THEN 0 ELSE 1 END ASC,
          ps.ends_at DESC,
          ps.id DESC
        LIMIT 1
      ) sub ON TRUE
      GROUP BY
        ap.user_id,
        ap.first_name,
        ap.last_name,
        ap.phone,
        ap.email,
        sub.is_verified_member,
        sub.plan_code,
        sub.ends_at
      ORDER BY
        COALESCE(sub.is_verified_member, FALSE) DESC,
        CASE WHEN sub.plan_code = 'verified_pro' THEN 0 ELSE 1 END ASC,
        AVG(ap.rating_avg) DESC,
        ap.user_id ASC;
    `;

    const result = await db.query(query);

    return res.status(200).json({
      count: result.rows.length,
      providers: result.rows
    });
  } catch (error) {
    console.error('Error al listar prestadores verificados:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al obtener el directorio.'
    });
  }
};

/**
 * Asegura la existencia de la tabla de suspensiones operativas locales por comunidad.
 */
const ensureLocalSuspensionsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.provider_local_suspensions (
      id SERIAL PRIMARY KEY,
      country_id INTEGER NOT NULL REFERENCES public.countries(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
      created_by_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      lifted_at TIMESTAMP WITHOUT TIME ZONE NULL
    );
  `);
};

/**
 * Lista suspensiones locales por comunidad.
 */
const listLocalSuspensions = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();
    const countryIdParam = req.query.country_id ? parseInt(req.query.country_id, 10) : null;
    const isSuperadmin = req.user.role === 'superadmin';
    const effectiveCountryId =
      isSuperadmin && countryIdParam ? countryIdParam : req.user.countryId;

    const params = [];
    let whereClause = '';
    if (effectiveCountryId && Number.isInteger(effectiveCountryId) && effectiveCountryId > 0) {
      params.push(effectiveCountryId);
      whereClause = 'WHERE pls.country_id = $1';
    }

    const query = `
      SELECT
        pls.id,
        pls.country_id,
        c.name AS country_name,
        pls.provider_id,
        p.specialty,
        u.first_name,
        u.last_name,
        u.first_name AS provider_first_name,
        u.last_name AS provider_last_name,
        u.email,
        pls.reason,
        pls.active,
        CASE WHEN pls.active THEN 'active' ELSE 'lifted' END AS status,
        pls.created_at,
        pls.lifted_at
      FROM public.provider_local_suspensions pls
      JOIN public.providers p ON p.id = pls.provider_id
      JOIN public.users u ON u.id = p.user_id
      LEFT JOIN public.countries c ON c.id = pls.country_id
      ${whereClause}
      ORDER BY pls.active DESC, pls.id DESC;
    `;

    const countriesQuery = isSuperadmin
      ? db.query('SELECT id, name, is_active FROM public.countries ORDER BY id ASC')
      : effectiveCountryId
      ? db.query('SELECT id, name, is_active FROM public.countries WHERE id = $1 ORDER BY id ASC', [
          effectiveCountryId,
        ])
      : Promise.resolve({ rows: [] });

    const providersQuery = db.query(`
      SELECT
        p.id AS provider_id,
        p.specialty,
        p.status,
        u.first_name,
        u.last_name,
        u.email
      FROM public.providers p
      JOIN public.users u ON u.id = p.user_id
      ORDER BY u.first_name ASC, u.last_name ASC, p.id ASC
    `);

    const [result, countriesRes, providersRes] = await Promise.all([
      db.query(query, params),
      countriesQuery,
      providersQuery,
    ]);

    return res.status(200).json({
      count: result.rows.length,
      effective_country_id: effectiveCountryId || countriesRes.rows[0]?.id || null,
      countries: countriesRes.rows,
      providers: providersRes.rows,
      suspensions: result.rows,
    });
  } catch (error) {
    console.error('Error al listar suspensiones locales:', error);
    return res.status(500).json({ error: 'Error interno al consultar suspensiones locales.' });
  }
};

/**
 * Crea una suspensión operativa local en la comunidad.
 */
const createLocalSuspension = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();
    const { provider_id, reason, country_id } = req.body;
    const effectiveCountryId =
      req.user.role === 'superadmin' && country_id
        ? parseInt(country_id, 10)
        : req.user.countryId;

    if (!provider_id || !reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Debe indicar el prestador y el motivo del reporte.' });
    }

    const insertRes = await db.query(
      `
        INSERT INTO public.provider_local_suspensions (
          country_id,
          provider_id,
          created_by_user_id,
          reason,
          active
        )
        VALUES ($1, $2, $3, $4, TRUE)
        RETURNING *;
      `,
      [effectiveCountryId, provider_id, req.user.userId, String(reason).trim()]
    );

    return res.status(201).json({
      message: 'Suspensión local registrada para esta comunidad.',
      suspension: insertRes.rows[0]
    });
  } catch (error) {
    console.error('Error al crear suspensión local:', error);
    return res.status(500).json({ error: 'Error interno al registrar la suspensión local.' });
  }
};

/**
 * Levanta una suspensión operativa local activa.
 */
const liftLocalSuspension = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();
    const { id } = req.params;
    const isAdminLocal = req.user.role === 'admin' && req.user.countryId;

    const updated = isAdminLocal
      ? await db.query(
          `
            UPDATE public.provider_local_suspensions
            SET active = FALSE, lifted_at = NOW()
            WHERE id = $1 AND country_id = $2
            RETURNING *;
          `,
          [id, req.user.countryId]
        )
      : await db.query(
          `
            UPDATE public.provider_local_suspensions
            SET active = FALSE, lifted_at = NOW()
            WHERE id = $1
            RETURNING *;
          `,
          [id]
        );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Suspensión local no encontrada.' });
    }

    return res.status(200).json({
      message: 'Suspensión local levantada.',
      suspension: updated.rows[0]
    });
  } catch (error) {
    console.error('Error al levantar suspensión local:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la suspensión.' });
  }
};

/**
 * Lista los ayudantes / integrantes de cuadrilla del prestador autenticado.
 * GET /api/v1/providers/employees
 */
const listProviderEmployees = async (req, res) => {
  try {
    await ensureProviderEmployeesColumns();
    const userId = req.user.userId;
    const provRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    const providerIds = provRes.rows.map((r) => r.id);
    if (providerIds.length === 0) {
      return res.status(200).json({ count: 0, employees: [] });
    }

    const empRes = await db.query(
      `SELECT
         pe.id,
         pe.provider_id,
         pe.employee_user_id,
         COALESCE(pe.full_name, TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) AS full_name,
         COALESCE(pe.dni, u.dni) AS dni,
         COALESCE(pe.phone, u.phone) AS phone,
         COALESCE(pe.role_label, 'Ayudante') AS role_label,
         pe.insurance_policy_url,
         pe.insurance_expiry,
         pe.is_active,
         pe.created_at
       FROM public.provider_employees pe
       LEFT JOIN public.users u ON u.id = pe.employee_user_id
       WHERE pe.provider_id = ANY($1::int[])
       ORDER BY pe.id DESC`,
      [providerIds]
    );

    return res.status(200).json({ count: empRes.rows.length, employees: empRes.rows });
  } catch (error) {
    console.error('Error al listar ayudantes del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar ayudantes.' });
  }
};

/**
 * Registra un ayudante / integrante de cuadrilla para el prestador autenticado.
 * POST /api/v1/providers/employees
 */
const addProviderEmployee = async (req, res) => {
  try {
    await ensureProviderEmployeesColumns();
    const userId = req.user.userId;
    const {
      full_name,
      dni,
      phone,
      role_label,
      insurance_policy_url,
      insurance_expiry,
    } = req.body || {};

    if (!full_name || !String(full_name).trim() || !dni || !String(dni).trim()) {
      return res.status(400).json({ error: 'Nombre completo y DNI del ayudante son obligatorios.' });
    }

    const provRes = await db.query(
      'SELECT id FROM providers WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [userId]
    );

    let providerId;
    if (provRes.rows.length === 0) {
      const created = await db.query(
        `INSERT INTO providers (user_id, specialty, status)
         VALUES ($1, 'Servicios Generales', 'pending')
         RETURNING id`,
        [userId]
      );
      providerId = created.rows[0].id;
    } else {
      providerId = provRes.rows[0].id;
    }

    const insertRes = await db.query(
      `INSERT INTO public.provider_employees (
         provider_id, full_name, dni, phone, role_label,
         insurance_policy_url, insurance_expiry, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, TRUE)
       RETURNING id, provider_id, full_name, dni, phone, role_label,
                 insurance_policy_url, insurance_expiry, is_active, created_at`,
      [
        providerId,
        String(full_name).trim(),
        String(dni).trim(),
        phone ? String(phone).trim() : null,
        role_label ? String(role_label).trim() : 'Ayudante',
        insurance_policy_url ? String(insurance_policy_url).trim() : null,
        insurance_expiry || null,
      ]
    );

    return res.status(201).json({
      message: 'Ayudante registrado en tu cuadrilla correctamente.',
      employee: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al registrar ayudante:', error);
    return res.status(500).json({ error: 'Error interno al registrar ayudante.' });
  }
};

/**
 * Actualiza datos o estado de un ayudante del prestador autenticado.
 * PATCH /api/v1/providers/employees/:id
 */
const updateProviderEmployee = async (req, res) => {
  try {
    await ensureProviderEmployeesColumns();
    const userId = req.user.userId;
    const empId = Number(req.params.id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return res.status(400).json({ error: 'ID de ayudante inválido.' });
    }

    const provRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    const providerIds = provRes.rows.map((r) => r.id);
    if (providerIds.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    const {
      full_name,
      dni,
      phone,
      role_label,
      insurance_policy_url,
      insurance_expiry,
      is_active,
    } = req.body || {};

    const updated = await db.query(
      `UPDATE public.provider_employees
       SET full_name = COALESCE($1, full_name),
           dni = COALESCE($2, dni),
           phone = COALESCE($3, phone),
           role_label = COALESCE($4, role_label),
           insurance_policy_url = $5,
           insurance_expiry = $6::date,
           is_active = COALESCE($7, is_active)
       WHERE id = $8 AND provider_id = ANY($9::int[])
       RETURNING id, provider_id, full_name, dni, phone, role_label,
                 insurance_policy_url, insurance_expiry, is_active, created_at`,
      [
        full_name !== undefined ? String(full_name).trim() || null : null,
        dni !== undefined ? String(dni).trim() || null : null,
        phone !== undefined ? String(phone).trim() || null : null,
        role_label !== undefined ? String(role_label).trim() || null : null,
        insurance_policy_url !== undefined ? String(insurance_policy_url).trim() || null : null,
        insurance_expiry || null,
        typeof is_active === 'boolean' ? is_active : null,
        empId,
        providerIds,
      ]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Ayudante no encontrado o sin permisos.' });
    }

    return res.status(200).json({
      message: 'Datos del ayudante actualizados correctamente.',
      employee: updated.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar ayudante:', error);
    return res.status(500).json({ error: 'Error interno al actualizar ayudante.' });
  }
};

/**
 * Elimina un ayudante de la cuadrilla del prestador autenticado.
 * DELETE /api/v1/providers/employees/:id
 */
const deleteProviderEmployee = async (req, res) => {
  try {
    await ensureProviderEmployeesColumns();
    const userId = req.user.userId;
    const empId = Number(req.params.id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return res.status(400).json({ error: 'ID de ayudante inválido.' });
    }

    const provRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    const providerIds = provRes.rows.map((r) => r.id);

    const deleted = await db.query(
      `DELETE FROM public.provider_employees
       WHERE id = $1 AND provider_id = ANY($2::int[])
       RETURNING id`,
      [empId, providerIds]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Ayudante no encontrado o sin permisos.' });
    }

    return res.status(200).json({ message: 'Ayudante eliminado de tu cuadrilla.' });
  } catch (error) {
    console.error('Error al eliminar ayudante:', error);
    return res.status(500).json({ error: 'Error interno al eliminar ayudante.' });
  }
};

/**
 * Lista alertas proactivas de vencimiento (vencidos o próximos a vencer en N días)
 * para administración local o central de TrustLink.
 * GET /api/v1/providers/expiry-alerts?days=30
 */
const listExpiryAlertsForAdmin = async (req, res) => {
  try {
    await Promise.all([
      ensureVehicleInsuranceColumns(),
      ensureProviderEmployeesColumns(),
    ]);

    const rawDays = parseInt(req.query.days, 10);
    const windowDays = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 180 ? rawDays : 30;

    const [provRes, vehRes, empRes] = await Promise.all([
      db.query(`
        SELECT
          p.id,
          p.user_id,
          p.specialty,
          p.criminal_record_expiry,
          p.insurance_expiry,
          p.status,
          TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS provider_name,
          u.phone AS provider_phone,
          u.email AS provider_email
        FROM public.providers p
        JOIN public.users u ON u.id = p.user_id
        ORDER BY p.id ASC
      `),
      db.query(`
        SELECT id, provider_id, vehicle_type, brand, model, plate, vehicle_insurance_expiry
        FROM public.provider_vehicles
        WHERE vehicle_insurance_expiry IS NOT NULL
      `),
      db.query(`
        SELECT
          pe.id,
          pe.provider_id,
          COALESCE(pe.full_name, TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) AS full_name,
          COALESCE(pe.dni, u.dni) AS dni,
          COALESCE(pe.role_label, 'Ayudante') AS role_label,
          pe.insurance_expiry,
          pe.is_active
        FROM public.provider_employees pe
        LEFT JOIN public.users u ON u.id = pe.employee_user_id
        WHERE COALESCE(pe.is_active, TRUE) = TRUE AND pe.insurance_expiry IS NOT NULL
      `),
    ]);

    const providerMetaById = {};
    provRes.rows.forEach((p) => {
      providerMetaById[p.id] = {
        provider_name: p.provider_name || p.provider_email || `Prestador #${p.id}`,
        provider_phone: p.provider_phone || null,
        provider_email: p.provider_email || null,
      };
    });

    const alerts = buildProviderExpiryAlerts({
      providers: provRes.rows,
      vehicles: vehRes.rows,
      employees: empRes.rows,
      windowDays,
      providerMetaById,
    });

    const expiredCount = alerts.filter((a) => a.severity === 'expired').length;
    const expiringSoonCount = alerts.filter((a) => a.severity === 'expiring_soon').length;

    return res.status(200).json({
      window_days: windowDays,
      summary: {
        total: alerts.length,
        expired: expiredCount,
        expiring_soon: expiringSoonCount,
      },
      alerts,
    });
  } catch (error) {
    console.error('Error al consultar alertas de vencimiento:', error);
    return res.status(500).json({ error: 'Error interno al consultar alertas de vencimiento.' });
  }
};

module.exports = {
  updateProviderProfile,
  editProviderProfile,
  addVehicle,
  editVehicle,
  listProviderEmployees,
  addProviderEmployee,
  updateProviderEmployee,
  deleteProviderEmployee,
  getMyProviderProfile,
  listAllProvidersForOps,
  updateComplianceStatus,
  listVerifiedProviders,
  listLocalSuspensions,
  createLocalSuspension,
  liftLocalSuspension,
  listExpiryAlertsForAdmin
};