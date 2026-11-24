/**
 * @file providers.controller.js
 * @description Controlador completo del módulo de prestadores en TrustLink.
 * Gestiona perfiles de compliance y especialidades (con control de visibilidad en el directorio),
 * historial inmutable de versiones documentales sin sobrescribir registros previos, flota vehicular
 * con seguro automotor, cuadrilla de ayudantes con póliza ART, alertas proactivas de vencimiento,
 * auditoría centralizada para Ops, directorio público unificado con ranking Socio Verificado
 * y suspensiones operativas locales por comunidad.
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
 * Asegura de forma idempotente la existencia de la tabla `provider_document_versions`.
 * Permite almacenar un historial append-only de todas las versiones documentales cargadas
 * (antecedentes penales `'criminal'` y pólizas `'insurance'`), conservando registros
 * vigentes, vencidos e históricos para auditoría.
 *
 * @returns {Promise<void>}
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
 * Asegura de forma idempotente que la tabla `provider_vehicles` cuente con las columnas
 * necesarias para registrar la póliza de seguro automotor (`vehicle_insurance_url`)
 * y su ventana de vigencia (`vehicle_insurance_from`, `vehicle_insurance_expiry`).
 *
 * @returns {Promise<void>}
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
 * Asegura de forma idempotente la tabla `provider_employees` y sus columnas extendidas
 * para gestionar ayudantes / integrantes de cuadrilla directa.
 * Soporta tanto ayudantes vinculados a un usuario registrado (`employee_user_id`)
 * como altas directas con datos nominales (`full_name`, `dni`, `phone`, `role_label`),
 * póliza ART y bandera de actividad (`is_active`).
 *
 * @returns {Promise<void>}
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
 * Inserta una nueva versión documental en `provider_document_versions` sin modificar ni eliminar
 * versiones anteriores, garantizando trazabilidad histórica de compliance.
 * Si `documentUrl` viene vacío o solo con espacios, omite el registro y devuelve `null`.
 *
 * @param {Object} params - Datos de la versión documental a persistir.
 * @param {number} params.userId - ID del usuario prestador propietario del documento.
 * @param {number|null} [params.providerId=null] - ID del perfil/especialidad asociado en `providers`.
 * @param {'criminal'|'insurance'} params.docType - Tipo de documento (`criminal` o `insurance`).
 * @param {string} params.documentUrl - URL o referencia del archivo respaldatorio.
 * @param {string|null} [params.validFrom=null] - Fecha de inicio de vigencia (YYYY-MM-DD).
 * @param {string|null} [params.validTo=null] - Fecha de vencimiento (YYYY-MM-DD).
 * @param {string} [params.status='pending'] - Estado inicial de revisión documental.
 * @returns {Promise<Object|null>} Registro insertado o `null` si no se proveyó URL.
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
 * Registra un nuevo perfil/especialidad para el prestador autenticado en estado `'pending'`
 * y guarda las versiones documentales asociadas (antecedentes y/o seguro ART) en el historial
 * sin sobrescribir cargas anteriores.
 * POST /api/v1/providers/profile
 *
 * @param {import('express').Request} req - Solicitud HTTP con usuario autenticado y datos de especialidad/documentación.
 * @param {import('express').Response} res - Respuesta HTTP con el perfil creado (201).
 * @returns {Promise<import('express').Response>}
 */
const updateProviderProfile = async (req, res) => {
  try {
    // Etapa 1: Extracción y validación de la especialidad obligatoria
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

    // Etapa 2: Inserción del nuevo perfil en `providers` con estado inicial 'pending' para auditoría Ops
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

    // Etapa 3: Registro append-only de versiones documentales (antecedentes y póliza ART) si fueron informadas
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
 * Edita un perfil/especialidad existente perteneciente al prestador autenticado (`id` + `user_id`),
 * devuelve su estado de compliance a `'pending'` para una nueva auditoría y agrega al historial
 * las nuevas versiones documentales sin borrar las anteriores.
 * PUT /api/v1/providers/profile/:id
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` y campos a actualizar.
 * @param {import('express').Response} res - Respuesta HTTP con el perfil actualizado.
 * @returns {Promise<import('express').Response>}
 */
const editProviderProfile = async (req, res) => {
  try {
    // Etapa 1: Lectura de parámetros y actualización parcial (COALESCE) restringida al usuario dueño
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

    // Regla de compliance: cualquier modificación documental o de especialidad reinicia `status = 'pending'`
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

    // Etapa 2: Validar existencia y propiedad del perfil modificado
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de prestador no encontrado o no autorizado.' });
    }

    const updatedProvider = result.rows[0];

    // Etapa 3: Persistir nuevas versiones en el historial documental si se actualizaron URLs o vigencias
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
 * Registra un nuevo vehículo en la flota del prestador autenticado, incluyendo los datos
 * de su seguro automotor y fechas de vigencia. Si el usuario aún no posee un registro en
 * `providers`, crea automáticamente un perfil base `'Servicios Generales'` en estado `'pending'`.
 * POST /api/v1/providers/vehicles
 *
 * @param {import('express').Request} req - Solicitud HTTP con datos del vehículo y póliza automotor.
 * @param {import('express').Response} res - Respuesta HTTP con el vehículo creado (201).
 * @returns {Promise<import('express').Response>}
 */
const addVehicle = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas de seguro vehicular y validar patente obligatoria
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

    // Etapa 2: Resolver el `provider_id` más reciente del usuario o crear un perfil base si no existe
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

    // Etapa 3: Insertar el vehículo en `provider_vehicles` normalizando patente en mayúsculas
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
 * Actualiza los datos de un vehículo existente de la flota del prestador autenticado,
 * incluyendo seguro automotor y fechas de vigencia. Valida propiedad verificando que el vehículo
 * pertenezca a alguno de los perfiles (`provider_id`) del usuario logueado.
 * PUT /api/v1/providers/vehicles/:id
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` y campos del vehículo.
 * @param {import('express').Response} res - Respuesta HTTP con el vehículo actualizado.
 * @returns {Promise<import('express').Response>}
 */
const editVehicle = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas de seguro y validar que la patente no quede vacía si se informó
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

    // Etapa 2: Obtener todos los perfiles del prestador para restringir la edición solo a su flota
    const providerRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    if (providerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }
    const providerIds = providerRes.rows.map((p) => p.id);

    // Etapa 3: Actualizar vehículo (COALESCE en datos básicos; reemplazo directo en campos de seguro)
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
 * Evalúa una fecha de vencimiento respecto al día calendario actual y determina
 * si requiere alerta por documento vencido (`expired`) o próximo a vencer (`expiring_soon`)
 * dentro de la ventana de anticipación configurada.
 *
 * @param {string|Date|null|undefined} rawDate - Fecha de vencimiento a evaluar.
 * @param {number} [windowDays=30] - Ventana en días hacia adelante para alertar vencimientos próximos.
 * @returns {{ severity: 'expired'|'expiring_soon', days_remaining: number, expiry_date: string }|null}
 *          Objeto de evaluación de alerta o `null` si la fecha es inválida o aún tiene vigencia holgada.
 */
const evaluateExpiryDate = (rawDate, windowDays = 30) => {
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;

  // Normaliza ambas fechas a medianoche local para calcular la diferencia exacta en días calendario
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

/**
 * Consolida todas las alertas proactivas de vencimiento (vencidos y próximos a vencer)
 * a partir de perfiles/especialidades, flota vehicular y cuadrilla activa de ayudantes,
 * ordenándolas de mayor a menor urgencia (`days_remaining` ascendente).
 *
 * @param {Object} params - Conjuntos de entidades y parámetros de evaluación.
 * @param {Array<Object>} [params.providers=[]] - Perfiles de prestador con fechas de antecedentes y ART.
 * @param {Array<Object>} [params.vehicles=[]] - Vehículos con fecha de vencimiento de seguro automotor.
 * @param {Array<Object>} [params.employees=[]] - Ayudantes de cuadrilla con fecha de vencimiento de ART.
 * @param {number} [params.windowDays=30] - Cantidad de días de anticipación para alertas preventivas.
 * @param {Object<number, Object>} [params.providerMetaById={}] - Mapa auxiliar de contacto (nombre, teléfono, email) por `provider_id`.
 * @returns {Array<Object>} Lista de alertas normalizadas y ordenadas por urgencia.
 */
const buildProviderExpiryAlerts = ({
  providers = [],
  vehicles = [],
  employees = [],
  windowDays = 30,
  providerMetaById = {},
}) => {
  const alerts = [];

  // Etapa 1: Evaluar documentación personal de cada perfil (Antecedentes Penales y Póliza ART)
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

  // Etapa 2: Evaluar vencimientos de seguro automotor en toda la flota vehicular registrada
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

  // Etapa 3: Evaluar vencimientos de póliza ART solo para ayudantes activos de la cuadrilla
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

  // Etapa 4: Ordenar de más crítico (negativos / vencidos hace más días) a menos urgente
  alerts.sort((a, b) => a.days_remaining - b.days_remaining);
  return alerts;
};

/**
 * Activa u oculta temporalmente una especialidad del prestador en el directorio público
 * de residentes (`is_visible_in_directory`), sin alterar su estado de compliance ni requerir
 * una nueva auditoría documental.
 * PATCH /api/v1/providers/profile/:id/visibility
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` y booleano opcional `body.is_visible_in_directory`.
 * @param {import('express').Response} res - Respuesta HTTP con el nuevo estado de visibilidad.
 * @returns {Promise<import('express').Response>}
 */
const toggleSpecialtyVisibility = async (req, res) => {
  try {
    // Etapa 1: Asegurar columna de visibilidad y validar ID numérico de especialidad
    await ensureEvolutionSchema();
    const userId = Number(req.user.userId);
    const providerId = Number(req.params.id);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: 'ID de especialidad inválido.' });
    }

    // Etapa 2: Verificar existencia y propiedad de la especialidad para el usuario autenticado
    const existing = await db.query(
      `SELECT id, specialty, status, COALESCE(is_visible_in_directory, TRUE) AS is_visible_in_directory
       FROM providers
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [providerId, userId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Especialidad no encontrada o sin permisos.' });
    }

    // Si el cliente envía un booleano explícito se aplica; en caso contrario se invierte el valor actual
    const nextVisible =
      typeof req.body?.is_visible_in_directory === 'boolean'
        ? req.body.is_visible_in_directory
        : !existing.rows[0].is_visible_in_directory;

    // Etapa 3: Persistir el nuevo estado de visibilidad manteniendo intacto el `status` de compliance
    const updated = await db.query(
      `UPDATE providers
       SET is_visible_in_directory = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, user_id, specialty, status, is_visible_in_directory`,
      [nextVisible, providerId, userId]
    );

    return res.status(200).json({
      message: nextVisible
        ? `Especialidad "${updated.rows[0].specialty}" visible nuevamente en el directorio.`
        : `Especialidad "${updated.rows[0].specialty}" ocultada temporalmente del directorio (tu compliance sigue intacto).`,
      provider: updated.rows[0],
    });
  } catch (error) {
    console.error('Error al cambiar visibilidad de especialidad:', error);
    return res.status(500).json({ error: 'Error interno al actualizar la visibilidad de la especialidad.' });
  }
};

/**
 * Obtiene la vista consolidada del portal del prestador autenticado:
 * todas sus especialidades/perfiles (con estado de compliance y visibilidad),
 * el historial completo de versiones documentales, su flota vehicular, su cuadrilla de ayudantes,
 * las alertas proactivas de vencimiento a 30 días y su membresía Socio Verificado activa.
 * GET /api/v1/providers/me
 *
 * @param {import('express').Request} req - Solicitud HTTP del prestador autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con el perfil integral y planes disponibles.
 * @returns {Promise<import('express').Response>}
 */
const getMyProviderProfile = async (req, res) => {
  try {
    // Etapa 1: Asegurar de forma idempotente todas las tablas y columnas requeridas por el portal
    await ensureEvolutionSchema();
    await ensureDocumentVersionsTable();
    await ensureVehicleInsuranceColumns();
    await ensureProviderEmployeesColumns();

    // Etapa 2: Consultar perfiles/especialidades e historial inmutable de versiones documentales del usuario
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
          COALESCE(is_visible_in_directory, TRUE) AS is_visible_in_directory,
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

    // Etapa 3: Si el prestador tiene al menos un perfil, cargar en paralelo flota vehicular y cuadrilla de ayudantes
    let vehicles = [];
    let employees = [];
    if (providersRes.rows.length > 0) {
      const providerIds = providersRes.rows.map((p) => p.id);
      // Para ayudantes vinculados a un usuario registrado, `COALESCE` completa nombre/DNI/teléfono desde `users`
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

    // Etapa 4: Calcular alertas de vencimiento (ventana 30 días) y consultar membresía activa en paralelo
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
 * Lista todos los prestadores registrados (incluyendo cuentas habilitadas como prestador
 * que aún no completaron perfil, etiquetadas como `'sin_perfil'`) para el panel de
 * auditoría centralizada de Operaciones TrustLink.
 * GET /api/v1/providers/ops/all
 *
 * @param {import('express').Request} req - Solicitud HTTP de usuario Ops/Superadmin.
 * @param {import('express').Response} res - Respuesta HTTP con la nómina priorizada de prestadores.
 * @returns {Promise<import('express').Response>}
 */
const listAllProvidersForOps = async (req, res) => {
  try {
    await ensureProviderSubscriptionsTable();

    /*
     * Consulta consolidada para auditoría Ops:
     * - LEFT JOIN `providers`: conserva usuarios con rol 'provider' o flag `can_use_provider = TRUE`
     *   aun cuando todavía no hayan dado de alta ninguna especialidad (`status = 'sin_perfil'`).
     * - LEFT JOIN LATERAL `provider_subscriptions`: adjunta la suscripción vigente (o más reciente)
     *   para mostrar si es Socio Verificado (`is_verified_member`), su tier y vencimiento.
     * - WHERE: excluye cuentas puramente internas (`superadmin`, `admin`, `security`) que no tengan
     *   un perfil explícito en `providers`.
     * - ORDER BY: prioriza pendientes de revisión (`pending`), luego aprobados, rechazados y sin perfil;
     *   desempata por membresía verificada y calificación promedio.
     */
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
 * Actualiza el estado global de compliance (`approved`, `rejected` o `pending`) de un prestador
 * desde Operaciones TrustLink y sincroniza ese mismo estado en todas sus versiones documentales
 * registradas en `provider_document_versions`.
 * PATCH /api/v1/providers/compliance
 *
 * @param {import('express').Request} req - Solicitud HTTP con `provider_id` o `user_id` y el nuevo `status`.
 * @param {import('express').Response} res - Respuesta HTTP con el perfil actualizado.
 * @returns {Promise<import('express').Response>}
 */
const updateComplianceStatus = async (req, res) => {
  try {
    // Etapa 1: Asegurar tabla de historial documental y validar que el estado solicitado sea permitido
    await ensureDocumentVersionsTable();

    const { provider_id, user_id, status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    // Etapa 2: Resolver `targetProviderId` cuando Ops actúa por `user_id` (crea perfil base si faltaba)
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

    // Etapa 3: Actualizar el estado en `providers` y propagarlo a `provider_document_versions`
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
 * Lista los prestadores verificados y visibles en el directorio público del Portal Residente,
 * unificados por usuario (`u.id`) y rankeados priorizando miembros Socio Verificado (`verified_pro`),
 * luego membresía activa y finalmente mejor calificación promedio (`rating_avg`).
 * Incluye flota vehicular (`vehicles`) y ayudantes activos (`employees`) listos para emitir pases QR.
 * GET /api/v1/providers/verified
 *
 * @param {import('express').Request} req - Solicitud HTTP del residente autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con el directorio unificado y ordenado.
 * @returns {Promise<import('express').Response>}
 */
const listVerifiedProviders = async (req, res) => {
  try {
    // Etapa 1: Asegurar de forma idempotente todas las tablas/columnas consultadas por el directorio
    await ensureEvolutionSchema();
    await ensureProviderSubscriptionsTable();
    await ensureVehicleInsuranceColumns();
    await ensureProviderEmployeesColumns();

    /*
     * Etapa 2: Consulta consolidada del directorio público con ranking Socio Verificado:
     * 1) CTE `approved_profiles`: selecciona únicamente perfiles con compliance aprobado (`approved`),
     *    visibles en directorio (`is_visible_in_directory = TRUE`), usuario activo (`is_active = TRUE`)
     *    y permiso de prestador habilitado (`can_use_provider = TRUE`); además cuenta los contratos
     *    (`service_contracts`) ejecutados por cada perfil.
     * 2) Agregación principal (`GROUP BY ap.user_id`): unifica las distintas especialidades de una misma
     *    persona en `specialties` / `specialties_label`, promedia su `rating_avg`, suma `total_jobs`
     *    y calcula `has_expired_docs` si alguna credencial personal ya venció respecto a `CURRENT_DATE`.
     * 3) Subconsultas `JSON_AGG`: embebe toda la flota vehicular (`vehicles`) y la cuadrilla activa
     *    (`employees`, resolviendo nombre/DNI desde `users` si aplica) para selección al generar QR.
     * 4) `LEFT JOIN LATERAL` sobre `provider_subscriptions`: detecta membresía activa o en prueba
     *    (`status IN ('active', 'trialing') AND ends_at > NOW()`), priorizando el plan `verified_pro`.
     * 5) Ranking `ORDER BY`: 1° Socio Verificado activo, 2° plan `verified_pro`, 3° mayor rating promedio,
     *    4° `user_id` ascendente como desempate determinista.
     */
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
          AND COALESCE(p.is_visible_in_directory, TRUE) = TRUE
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
 * Asegura de forma idempotente la tabla `provider_local_suspensions`.
 * Permite a cada comunidad/country aplicar bloqueos operativos locales a un prestador
 * (por incidentes o normativa interna) sin alterar su estado de compliance global en TrustLink.
 *
 * @returns {Promise<void>}
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
 * Lista las suspensiones operativas locales junto con los catálogos auxiliares de comunidades
 * y prestadores necesarios para la consola de administración.
 * - `superadmin`: puede consultar todas las comunidades o filtrar por `?country_id=`.
 * - `admin` local: queda restringido automáticamente a su `req.user.countryId`.
 * GET /api/v1/providers/local-suspensions
 *
 * @param {import('express').Request} req - Solicitud HTTP con filtro opcional `query.country_id`.
 * @param {import('express').Response} res - Respuesta HTTP con suspensiones, comunidades y prestadores.
 * @returns {Promise<import('express').Response>}
 */
const listLocalSuspensions = async (req, res) => {
  try {
    // Etapa 1: Asegurar tabla y determinar la comunidad efectiva según el rol (aislamiento multi-tenant)
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

    // Etapa 2: Preparar la consulta de suspensiones (priorizando activas) y catálogos para el panel
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

    // Etapa 3: Ejecutar las tres consultas en paralelo y responder al panel de administración
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
 * Registra una suspensión operativa local activa (`active = TRUE`) para un prestador dentro de
 * una comunidad específica, dejando auditoría del usuario emisor (`created_by_user_id`) y motivo.
 * POST /api/v1/providers/local-suspensions
 *
 * @param {import('express').Request} req - Solicitud HTTP con `provider_id`, `reason` y `country_id` opcional (superadmin).
 * @param {import('express').Response} res - Respuesta HTTP con la suspensión creada (201).
 * @returns {Promise<import('express').Response>}
 */
const createLocalSuspension = async (req, res) => {
  try {
    // Etapa 1: Asegurar tabla, resolver comunidad según rol y validar campos obligatorios
    await ensureLocalSuspensionsTable();
    const { provider_id, reason, country_id } = req.body;
    const effectiveCountryId =
      req.user.role === 'superadmin' && country_id
        ? parseInt(country_id, 10)
        : req.user.countryId;

    if (!provider_id || !reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Debe indicar el prestador y el motivo del reporte.' });
    }

    // Etapa 2: Insertar la suspensión operativa local en estado activo
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
 * Levanta una suspensión operativa local (`active = FALSE`, `lifted_at = NOW()`).
 * Los administradores locales solo pueden levantar suspensiones pertenecientes a su propia comunidad;
 * `superadmin` puede levantar suspensiones de cualquier comunidad.
 * PATCH /api/v1/providers/local-suspensions/:id/lift
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id`.
 * @param {import('express').Response} res - Respuesta HTTP con el registro actualizado.
 * @returns {Promise<import('express').Response>}
 */
const liftLocalSuspension = async (req, res) => {
  try {
    await ensureLocalSuspensionsTable();
    const { id } = req.params;
    const isAdminLocal = req.user.role === 'admin' && req.user.countryId;

    // Aislamiento multi-tenant: si es admin de comunidad, filtra obligatoriamente por su `country_id`
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
 * Lista todos los ayudantes / integrantes de cuadrilla asociados a cualquiera de los perfiles
 * del prestador autenticado, resolviendo nombre, DNI y teléfono desde `users` cuando corresponda.
 * GET /api/v1/providers/employees
 *
 * @param {import('express').Request} req - Solicitud HTTP del prestador autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con la lista de ayudantes y su conteo.
 * @returns {Promise<import('express').Response>}
 */
const listProviderEmployees = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas de cuadrilla y recuperar todos los `provider_id` del usuario
    await ensureProviderEmployeesColumns();
    const userId = req.user.userId;
    const provRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    const providerIds = provRes.rows.map((r) => r.id);
    if (providerIds.length === 0) {
      return res.status(200).json({ count: 0, employees: [] });
    }

    // Etapa 2: Consultar integrantes de cuadrilla con fallback de datos personales hacia `users`
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
 * Registra un nuevo ayudante / integrante de cuadrilla para el prestador autenticado,
 * incluyendo sus datos identificatorios y cobertura ART. Si el prestador todavía no tiene
 * perfil en `providers`, crea uno base `'Servicios Generales'` en estado `'pending'`.
 * POST /api/v1/providers/employees
 *
 * @param {import('express').Request} req - Solicitud HTTP con nombre, DNI, rol y datos de póliza ART.
 * @param {import('express').Response} res - Respuesta HTTP con el ayudante creado (201).
 * @returns {Promise<import('express').Response>}
 */
const addProviderEmployee = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas de cuadrilla y validar campos obligatorios (nombre completo y DNI)
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

    // Etapa 2: Resolver el `provider_id` más reciente del usuario o crear un perfil base si aún no existe
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

    // Etapa 3: Insertar el ayudante en `provider_employees` activo por defecto
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
 * Actualiza los datos personales, póliza ART o estado de actividad (`is_active`)
 * de un ayudante perteneciente a la cuadrilla del prestador autenticado.
 * PATCH /api/v1/providers/employees/:id
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` y campos a modificar.
 * @param {import('express').Response} res - Respuesta HTTP con el ayudante actualizado.
 * @returns {Promise<import('express').Response>}
 */
const updateProviderEmployee = async (req, res) => {
  try {
    // Etapa 1: Validar ID de ayudante y obtener los `provider_id` propiedad del prestador
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

    // Etapa 2: Ejecutar actualización parcial controlada por propiedad (`provider_id = ANY(...)`)
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
 * Elimina definitivamente un ayudante de la cuadrilla del prestador autenticado,
 * validando previamente que pertenezca a alguno de sus perfiles (`provider_id`).
 * DELETE /api/v1/providers/employees/:id
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id`.
 * @param {import('express').Response} res - Respuesta HTTP confirmando la eliminación.
 * @returns {Promise<import('express').Response>}
 */
const deleteProviderEmployee = async (req, res) => {
  try {
    // Etapa 1: Validar ID de ayudante y obtener perfiles propiedad del usuario autenticado
    await ensureProviderEmployeesColumns();
    const userId = req.user.userId;
    const empId = Number(req.params.id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return res.status(400).json({ error: 'ID de ayudante inválido.' });
    }

    const provRes = await db.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
    const providerIds = provRes.rows.map((r) => r.id);

    // Etapa 2: Eliminar registro solo si coincide con la cuadrilla del prestador
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
 * Genera el tablero proactivo de alertas de vencimiento (documentos vencidos o próximos a vencer
 * dentro de una ventana configurable entre 1 y 180 días, default 30) para administración local
 * o central de TrustLink, abarcando credenciales personales, seguros vehiculares y ART de cuadrillas.
 * GET /api/v1/providers/expiry-alerts?days=30
 *
 * @param {import('express').Request} req - Solicitud HTTP con parámetro opcional `query.days`.
 * @param {import('express').Response} res - Respuesta HTTP con resumen cuantitativo y alertas ordenadas.
 * @returns {Promise<import('express').Response>}
 */
const listExpiryAlertsForAdmin = async (req, res) => {
  try {
    // Etapa 1: Asegurar columnas dependientes y normalizar ventana `days` (1..180, default 30)
    await Promise.all([
      ensureVehicleInsuranceColumns(),
      ensureProviderEmployeesColumns(),
    ]);

    const rawDays = parseInt(req.query.days, 10);
    const windowDays = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 180 ? rawDays : 30;

    // Etapa 2: Consultar en paralelo prestadores (con contacto), vehículos con seguro y ayudantes activos con ART
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

    // Etapa 3: Indexar metadatos de contacto por `provider_id` y calcular alertas consolidadas
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

    // Etapa 4: Calcular métricas agregadas por severidad y responder al panel administrativo
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
  toggleSpecialtyVisibility,
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