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
const {
  computeProviderReputation,
  normalizeCommercialProfileInput,
  computeResponseTimeStats,
  STANDARD_SPECIALTIES_CATALOG,
  resolveSpecialtyCatalogMatch,
  REVIEW_MICRO_TAGS,
} = require('../../utils/providerReputation');
const {
  computeProviderTrustLevel,
  isExpiryDatePast,
} = require('../../utils/providerTrustLevel');
const {
  DEFAULT_CRIMINAL_WINDOW_DAYS,
  computeEffectiveCriminalRecordExpiry,
} = require('../../utils/complianceExpiry');

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
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    ALTER TABLE public.provider_document_versions
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
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
 * Asegura de forma idempotente la tabla `provider_service_packages` para el catálogo
 * de servicios con precio fijo publicados por cada prestador.
 *
 * @returns {Promise<void>}
 */
const ensureServicePackagesTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.provider_service_packages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      provider_id INTEGER NULL REFERENCES public.providers(id) ON DELETE SET NULL,
      specialty VARCHAR(120) NOT NULL,
      title VARCHAR(160) NOT NULL,
      includes_description TEXT NULL,
      fixed_price NUMERIC(12, 2) NOT NULL CHECK (fixed_price > 0),
      estimated_duration_minutes INTEGER NOT NULL DEFAULT 60,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_provider_service_packages_user_id
    ON public.provider_service_packages (user_id);
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
  status = 'pending',
  metadata = {},
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
        status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8::jsonb)
      RETURNING id, user_id, provider_id, doc_type, document_url, valid_from, valid_to, status, metadata, created_at;
    `,
    [
      userId,
      providerId,
      docType,
      String(documentUrl).trim(),
      validFrom || null,
      validTo || null,
      status || 'pending',
      JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
    ]
  );

  return res.rows[0] || null;
};

/**
 * Registra un nuevo perfil/especialidad para el prestador autenticado (Fase 5.3):
 * - Si la especialidad pertenece al catálogo estándar (`STANDARD_SPECIALTIES_CATALOG`) y la persona
 *   ya posee compliance personal aprobado (y no está reemplazando documentos por otros sin auditar),
 *   se hereda su documentación vigente y se auto-aprueba al instante (`status = 'approved'`).
 * - Si la especialidad es personalizada (`is_custom_specialty = TRUE` o fuera del catálogo),
 *   exige una breve descripción cuando viene del flujo "Otra especialidad" y queda en revisión
 *   puntual de Operaciones (`status = 'pending'`, `specialty_approval_status = 'pending'`).
 * POST /api/v1/providers/profile
 *
 * @param {import('express').Request} req - Solicitud HTTP con especialidad, descripción opcional y documentos.
 * @param {import('express').Response} res - Respuesta HTTP `201` con el perfil creado y `auto_approved`.
 * @returns {Promise<import('express').Response>}
 */
const updateProviderProfile = async (req, res) => {
  try {
    await ensureEvolutionSchema();

    // Etapa 1: Extracción y validación de especialidad (catálogo estándar vs personalizada)
    const userId = req.user.userId;
    const {
      specialty,
      is_custom_specialty,
      custom_specialty_description,
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

    const catalogMatch = resolveSpecialtyCatalogMatch(specialty);
    const isCustom = Boolean(is_custom_specialty) || !catalogMatch.isStandard;
    const cleanSpecialty = catalogMatch.canonicalSpecialty;
    const cleanDescription =
      custom_specialty_description !== undefined && custom_specialty_description !== null
        ? String(custom_specialty_description).trim().slice(0, 300)
        : null;

    if (Boolean(is_custom_specialty) && (!cleanDescription || cleanDescription.length < 5)) {
      return res.status(400).json({
        error: 'Para proponer una especialidad personalizada debés incluir una breve descripción (mínimo 5 caracteres).',
      });
    }

    // Etapa 2: Verificar compliance personal aprobado y heredar documentación personal vigente del usuario
    const [existingApprovedRes, existingDocsRes] = await Promise.all([
      db.query(
        `SELECT
           criminal_record_url,
           criminal_record_expiry,
           insurance_policy_url,
           insurance_expiry
         FROM providers
         WHERE user_id = $1 AND status = 'approved'::provider_status
         ORDER BY id DESC
         LIMIT 1`,
        [userId]
      ),
      db.query(
        `SELECT
           criminal_record_url,
           criminal_record_expiry,
           insurance_policy_url,
           insurance_expiry
         FROM providers
         WHERE user_id = $1
           AND (
             criminal_record_url IS NOT NULL
             OR insurance_policy_url IS NOT NULL
             OR criminal_record_expiry IS NOT NULL
             OR insurance_expiry IS NOT NULL
           )
         ORDER BY id DESC
         LIMIT 1`,
        [userId]
      ),
    ]);
    const approvedBase = existingApprovedRes.rows[0] || null;
    const docsBase = approvedBase || existingDocsRes.rows[0] || null;
    const hasNewDocuments = Boolean(
      criminal_record_url || criminal_record_expiry || insurance_policy_url || insurance_expiry
    );

    const resolvedCriminalUrl = criminal_record_url || docsBase?.criminal_record_url || null;
    const resolvedCriminalExpiry =
      criminal_record_expiry || docsBase?.criminal_record_expiry || null;
    const resolvedInsuranceUrl = insurance_policy_url || docsBase?.insurance_policy_url || null;
    const resolvedInsuranceExpiry =
      insurance_expiry || docsBase?.insurance_expiry || null;

    // Auto-aprobación: solo si es rubro del catálogo estándar, la persona ya está aprobada y no sube docs nuevos sin auditar
    const shouldAutoApprove = !isCustom && Boolean(approvedBase) && !hasNewDocuments;
    const initialStatus = shouldAutoApprove ? 'approved' : 'pending';
    const specialtyApprovalStatus = isCustom ? 'pending' : 'approved';

    // Etapa 3: Inserción del nuevo perfil en `providers` con trazabilidad de catálogo/moderación
    const insertQuery = `
      INSERT INTO providers (
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        is_custom_specialty,
        custom_specialty_description,
        specialty_approval_status,
        status
      )
      VALUES ($1, $2, $3, $4::date, $5, $6::date, $7, $8, $9, $10::provider_status)
      RETURNING
        id,
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_expiry,
        insurance_policy_url,
        insurance_expiry,
        is_custom_specialty,
        custom_specialty_description,
        specialty_approval_status,
        status,
        rating_avg,
        created_at;
    `;

    const values = [
      userId,
      cleanSpecialty,
      resolvedCriminalUrl,
      resolvedCriminalExpiry,
      resolvedInsuranceUrl,
      resolvedInsuranceExpiry,
      isCustom,
      isCustom ? cleanDescription : null,
      specialtyApprovalStatus,
      initialStatus,
    ];

    const providerResult = await db.query(insertQuery, values);
    const createdProvider = providerResult.rows[0];

    // Etapa 4: Registro append-only de versiones documentales si fueron informadas en esta carga
    if (criminal_record_url || criminal_record_expiry) {
      await recordDocumentVersion({
        userId,
        providerId: createdProvider.id,
        docType: 'criminal',
        documentUrl: criminal_record_url || 'Sin URL',
        validFrom: criminal_record_from || null,
        validTo: criminal_record_expiry || null,
        status: initialStatus
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
        status: initialStatus
      });
    }

    const responseMessage = shouldAutoApprove
      ? `Especialidad "${cleanSpecialty}" activada automáticamente (tu compliance personal ya está aprobado).`
      : isCustom
      ? `Especialidad personalizada "${cleanSpecialty}" enviada a revisión de Operaciones TrustLink.`
      : 'Perfil de compliance registrado y enviado a revisión con éxito.';

    return res.status(201).json({
      message: responseMessage,
      auto_approved: shouldAutoApprove,
      provider: createdProvider
    });
  } catch (error) {
    console.error('Error al registrar perfil de prestador:', error);
    return res.status(500).json({ error: 'Error interno del servidor al actualizar el perfil.' });
  }
};

/**
 * Edita un perfil/especialidad existente o renueva documentación personal del prestador autenticado
 * (`id` + `user_id`) aplicando las reglas de Fase 5.3:
 * - **Edición de especialidad sin cambio documental:** resuelve si el rubro pertenece al catálogo
 *   estándar (`STANDARD_SPECIALTIES_CATALOG`) o es personalizado (`is_custom_specialty`). Si la
 *   persona ya posee compliance personal aprobado y cambia a un rubro estándar, se mantiene aprobada
 *   al instante (`auto_approved = true`); si pasa a una especialidad personalizada, queda en revisión
 *   puntual de Operaciones (`specialty_approval_status = 'pending'`).
 * - **Renovación/actualización documental (Antecedentes o ART):** sincroniza el documento personal
 *   en todas las especialidades del mismo `user_id`, agrega una única versión append-only en
 *   `provider_document_versions` (solo para el documento que realmente cambió) y pasa el compliance
 *   personal a `'pending'` para nueva auditoría de Operaciones.
 * PATCH /api/v1/providers/profile/:id
 *
 * @param {import('express').Request} req - Solicitud HTTP con `params.id` y campos a actualizar.
 * @param {import('express').Response} res - Respuesta HTTP con el perfil actualizado.
 * @returns {Promise<import('express').Response>}
 */
const editProviderProfile = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    await ensureDocumentVersionsTable();

    // Etapa 1: Validar existencia y propiedad del perfil objetivo
    const userId = req.user.userId;
    const { id } = req.params;
    const existingRes = await db.query(
      `
        SELECT
          id,
          user_id,
          specialty,
          criminal_record_url,
          criminal_record_issued_at,
          criminal_record_expiry,
          COALESCE(criminal_record_metadata, '{}'::jsonb) AS criminal_record_metadata,
          insurance_policy_url,
          insurance_expiry,
          COALESCE(insurance_metadata, '{}'::jsonb) AS insurance_metadata,
          COALESCE(is_custom_specialty, FALSE) AS is_custom_specialty,
          custom_specialty_description,
          COALESCE(specialty_approval_status, 'approved') AS specialty_approval_status,
          status
        FROM providers
        WHERE id = $1 AND user_id = $2
      `,
      [id, userId]
    );

    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de prestador no encontrado o no autorizado.' });
    }

    const existing = existingRes.rows[0];
    const {
      specialty,
      is_custom_specialty,
      custom_specialty_description,
      criminal_record_url,
      criminal_record_from,
      criminal_record_issued_at,
      criminal_record_expiry,
      criminal_record_metadata,
      insurance_policy_url,
      art_insurance_url,
      insurance_from,
      insurance_expiry,
      art_insurance_expiry,
      insurance_metadata,
    } = req.body;

    // Helper local para comparar fechas DATE/ISO sin falsos positivos por zona horaria
    const normalizeDateKey = (value) => {
      if (!value) return '';
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
      }
      const str = String(value).trim();
      return str.length >= 10 ? str.slice(0, 10) : str;
    };

    // Etapa 2: Detectar si se actualizaron realmente documentos personales (Antecedentes y/o Seguro AP/ART)
    const hasCriminalUrlField = Object.prototype.hasOwnProperty.call(req.body, 'criminal_record_url');
    const hasCriminalExpiryField = Object.prototype.hasOwnProperty.call(
      req.body,
      'criminal_record_expiry'
    );
    const incomingCriminalIssuedAt =
      criminal_record_issued_at ||
      criminal_record_metadata?.issued_at ||
      null;
    const hasCriminalMetaField =
      Boolean(incomingCriminalIssuedAt) ||
      (criminal_record_metadata && typeof criminal_record_metadata === 'object');
    const hasInsuranceUrlField =
      Object.prototype.hasOwnProperty.call(req.body, 'insurance_policy_url') ||
      Object.prototype.hasOwnProperty.call(req.body, 'art_insurance_url');
    const hasInsuranceExpiryField =
      Object.prototype.hasOwnProperty.call(req.body, 'insurance_expiry') ||
      Object.prototype.hasOwnProperty.call(req.body, 'art_insurance_expiry');
    const hasInsuranceMetaField = Boolean(insurance_metadata && typeof insurance_metadata === 'object');

    const incomingCriminalUrl = hasCriminalUrlField
      ? String(criminal_record_url || '').trim()
      : undefined;
    // Si envía fecha de emisión de Antecedentes sin vencimiento explícito, calcula vencimiento base de red (180 días)
    const computedBaseCriminalExpiry = incomingCriminalIssuedAt
      ? computeEffectiveCriminalRecordExpiry({
          criminalRecordIssuedAt: incomingCriminalIssuedAt,
          maxAgeDays: DEFAULT_CRIMINAL_WINDOW_DAYS,
        })
      : null;
    const incomingCriminalExpiry = hasCriminalExpiryField
      ? criminal_record_expiry || computedBaseCriminalExpiry || null
      : computedBaseCriminalExpiry || undefined;
    const rawInsuranceUrl =
      insurance_policy_url !== undefined ? insurance_policy_url : art_insurance_url;
    const rawInsuranceExpiry =
      insurance_expiry !== undefined ? insurance_expiry : art_insurance_expiry;
    const incomingInsuranceUrl = hasInsuranceUrlField
      ? String(rawInsuranceUrl || '').trim()
      : undefined;
    const incomingInsuranceExpiry = hasInsuranceExpiryField ? rawInsuranceExpiry || null : undefined;

    const currentCriminalUrl = String(existing.criminal_record_url || '').trim();
    const currentCriminalExpiryKey = normalizeDateKey(existing.criminal_record_expiry);
    const currentInsuranceUrl = String(existing.insurance_policy_url || '').trim();
    const currentInsuranceExpiryKey = normalizeDateKey(existing.insurance_expiry);

    const criminalChanged = Boolean(
      (incomingCriminalUrl !== undefined &&
        incomingCriminalUrl !== '' &&
        incomingCriminalUrl !== currentCriminalUrl) ||
        (incomingCriminalExpiry !== undefined &&
          normalizeDateKey(incomingCriminalExpiry) !== '' &&
          normalizeDateKey(incomingCriminalExpiry) !== currentCriminalExpiryKey) ||
        Boolean(criminal_record_from) ||
        hasCriminalMetaField
    );

    const insuranceChanged = Boolean(
      (incomingInsuranceUrl !== undefined &&
        incomingInsuranceUrl !== '' &&
        incomingInsuranceUrl !== currentInsuranceUrl) ||
        (incomingInsuranceExpiry !== undefined &&
          normalizeDateKey(incomingInsuranceExpiry) !== '' &&
          normalizeDateKey(incomingInsuranceExpiry) !== currentInsuranceExpiryKey) ||
        Boolean(insurance_from) ||
        hasInsuranceMetaField
    );

    const hasDocumentChanges = criminalChanged || insuranceChanged;

    // Etapa 3: Resolver especialidad (catálogo estándar vs personalizada) si fue enviada
    let nextSpecialty = existing.specialty;
    let nextIsCustom = Boolean(existing.is_custom_specialty);
    let nextCustomDescription = existing.custom_specialty_description || null;
    let nextSpecialtyApprovalStatus = existing.specialty_approval_status || 'approved';
    let specialtyChanged = false;

    if (specialty !== undefined && String(specialty).trim()) {
      const catalogMatch = resolveSpecialtyCatalogMatch(specialty);
      const requestedCustom = Boolean(is_custom_specialty) || !catalogMatch.isStandard;
      const cleanSpecialty = catalogMatch.canonicalSpecialty;
      const cleanDescription =
        custom_specialty_description !== undefined && custom_specialty_description !== null
          ? String(custom_specialty_description).trim().slice(0, 300)
          : existing.custom_specialty_description || null;

      if (Boolean(is_custom_specialty) && (!cleanDescription || cleanDescription.length < 5)) {
        return res.status(400).json({
          error:
            'Para proponer una especialidad personalizada debés incluir una breve descripción (mínimo 5 caracteres).',
        });
      }

      specialtyChanged =
        cleanSpecialty.toLowerCase() !== String(existing.specialty || '').trim().toLowerCase() ||
        requestedCustom !== Boolean(existing.is_custom_specialty) ||
        (requestedCustom &&
          String(cleanDescription || '') !== String(existing.custom_specialty_description || ''));

      nextSpecialty = cleanSpecialty;
      nextIsCustom = requestedCustom;
      nextCustomDescription = requestedCustom ? cleanDescription : null;

      if (!requestedCustom) {
        nextSpecialtyApprovalStatus = 'approved';
      } else if (
        !specialtyChanged &&
        existing.specialty_approval_status === 'approved'
      ) {
        nextSpecialtyApprovalStatus = 'approved';
      } else {
        nextSpecialtyApprovalStatus = 'pending';
      }
    }

    // Etapa 4: Determinar el estado de compliance resultante (auto-aprobación estándar vs auditoría)
    const approvedCheckRes = await db.query(
      `SELECT 1 FROM providers WHERE user_id = $1 AND status = 'approved'::provider_status LIMIT 1`,
      [userId]
    );
    const userHasApprovedCompliance = approvedCheckRes.rows.length > 0;

    let nextStatus = existing.status;
    let autoApproved = false;

    if (hasDocumentChanges) {
      nextStatus = 'pending';
    } else if (nextIsCustom && nextSpecialtyApprovalStatus !== 'approved') {
      nextStatus = 'pending';
    } else if (!nextIsCustom && (existing.status === 'approved' || userHasApprovedCompliance)) {
      nextStatus = 'approved';
      autoApproved = true;
    }

    const finalCriminalUrl =
      criminalChanged && incomingCriminalUrl ? incomingCriminalUrl : existing.criminal_record_url;
    const finalCriminalIssuedAt =
      criminalChanged && incomingCriminalIssuedAt
        ? incomingCriminalIssuedAt
        : existing.criminal_record_issued_at || null;
    const finalCriminalExpiry =
      criminalChanged && incomingCriminalExpiry !== undefined
        ? incomingCriminalExpiry
        : existing.criminal_record_expiry;
    const finalCriminalMeta = criminalChanged && hasCriminalMetaField
      ? {
          ...(existing.criminal_record_metadata || {}),
          ...(criminal_record_metadata || {}),
          ...(finalCriminalIssuedAt ? { issued_at: normalizeDateKey(finalCriminalIssuedAt) } : {}),
        }
      : existing.criminal_record_metadata || {};
    const finalInsuranceUrl =
      insuranceChanged && incomingInsuranceUrl
        ? incomingInsuranceUrl
        : existing.insurance_policy_url;
    const finalInsuranceExpiry =
      insuranceChanged && incomingInsuranceExpiry !== undefined
        ? incomingInsuranceExpiry
        : existing.insurance_expiry;
    const finalInsuranceMeta = insuranceChanged && hasInsuranceMetaField
      ? {
          ...(existing.insurance_metadata || {}),
          ...(insurance_metadata || {}),
        }
      : existing.insurance_metadata || {};

    // Etapa 5: Persistir actualización en la fila objetivo
    const updateQuery = `
      UPDATE providers
      SET specialty = $1,
          criminal_record_url = $2,
          criminal_record_issued_at = $3::date,
          criminal_record_expiry = $4::date,
          criminal_record_metadata = $5::jsonb,
          insurance_policy_url = $6,
          insurance_expiry = $7::date,
          insurance_metadata = $8::jsonb,
          is_custom_specialty = $9,
          custom_specialty_description = $10,
          specialty_approval_status = $11,
          status = $12::provider_status
      WHERE id = $13 AND user_id = $14
      RETURNING
        id,
        user_id,
        specialty,
        criminal_record_url,
        criminal_record_issued_at,
        criminal_record_expiry,
        criminal_record_metadata,
        insurance_policy_url,
        insurance_expiry,
        insurance_metadata,
        is_custom_specialty,
        custom_specialty_description,
        specialty_approval_status,
        status,
        rating_avg,
        created_at;
    `;

    const result = await db.query(updateQuery, [
      nextSpecialty,
      finalCriminalUrl || null,
      finalCriminalIssuedAt || null,
      finalCriminalExpiry || null,
      JSON.stringify(finalCriminalMeta),
      finalInsuranceUrl || null,
      finalInsuranceExpiry || null,
      JSON.stringify(finalInsuranceMeta),
      nextIsCustom,
      nextCustomDescription,
      nextSpecialtyApprovalStatus,
      nextStatus,
      id,
      userId
    ]);

    const updatedProvider = result.rows[0];

    // Etapa 6: Si hubo renovación documental, propagar el documento personal a todas las especialidades
    // del prestador, resetear el sello N4 (requiere re-cotejo de PDFs) y registrar versiones append-only
    if (hasDocumentChanges) {
      await db.query(
        `
          UPDATE providers
          SET criminal_record_url = CASE WHEN $1::boolean THEN $2 ELSE criminal_record_url END,
              criminal_record_issued_at = CASE WHEN $1::boolean THEN $3::date ELSE criminal_record_issued_at END,
              criminal_record_expiry = CASE WHEN $1::boolean THEN $4::date ELSE criminal_record_expiry END,
              criminal_record_metadata = CASE WHEN $1::boolean THEN $5::jsonb ELSE criminal_record_metadata END,
              insurance_policy_url = CASE WHEN $6::boolean THEN $7 ELSE insurance_policy_url END,
              insurance_expiry = CASE WHEN $6::boolean THEN $8::date ELSE insurance_expiry END,
              insurance_metadata = CASE WHEN $6::boolean THEN $9::jsonb ELSE insurance_metadata END,
              status = 'pending'::provider_status
          WHERE user_id = $10 AND id <> $11
        `,
        [
          criminalChanged,
          finalCriminalUrl || null,
          finalCriminalIssuedAt || null,
          finalCriminalExpiry || null,
          JSON.stringify(finalCriminalMeta),
          insuranceChanged,
          finalInsuranceUrl || null,
          finalInsuranceExpiry || null,
          JSON.stringify(finalInsuranceMeta),
          userId,
          updatedProvider.id
        ]
      );

      await db.query(
        `UPDATE users SET auto_verified = FALSE, auto_verified_at = NULL WHERE id = $1`,
        [userId]
      );

      if (criminalChanged) {
        await recordDocumentVersion({
          userId,
          providerId: updatedProvider.id,
          docType: 'criminal',
          documentUrl: finalCriminalUrl || 'Sin URL',
          validFrom: finalCriminalIssuedAt || criminal_record_from || null,
          validTo: finalCriminalExpiry || null,
          status: 'pending',
          metadata: finalCriminalMeta,
        });
      }

      if (insuranceChanged) {
        await recordDocumentVersion({
          userId,
          providerId: updatedProvider.id,
          docType: 'insurance',
          documentUrl: finalInsuranceUrl || 'Sin URL',
          validFrom: insurance_from || null,
          validTo: finalInsuranceExpiry || null,
          status: 'pending',
          metadata: finalInsuranceMeta,
        });
      }
    }

    const responseMessage = hasDocumentChanges
      ? 'Documentación personal renovada y sincronizada en tus especialidades. Pendiente de auditoría de Operaciones.'
      : autoApproved
      ? `Especialidad "${updatedProvider.specialty}" actualizada y habilitada automáticamente.`
      : nextIsCustom && nextSpecialtyApprovalStatus === 'pending'
      ? `Especialidad personalizada "${updatedProvider.specialty}" enviada a revisión de Operaciones TrustLink.`
      : 'Especialidad actualizada correctamente.';

    return res.status(200).json({
      message: responseMessage,
      auto_approved: autoApproved,
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

  // Etapa 1: Evaluar documentación personal agrupada por persona (`user_id`), evitando duplicar
  // Antecedentes Penales o Póliza ART cuando un mismo prestador tiene múltiples especialidades.
  const personalDocsByKey = new Map();
  providers.forEach((p) => {
    const meta = providerMetaById[p.id] || {};
    const ownerLabel = meta.provider_name || p.specialty || `Perfil #${p.id}`;
    const personKey = p.user_id ? `user-${p.user_id}` : `prov-${p.id}`;

    const registerPersonalAlert = (category, title, evalResult, idPrefix) => {
      if (!evalResult) return;
      const mapKey = `${category}:${personKey}`;
      const existing = personalDocsByKey.get(mapKey);
      if (!existing) {
        const specialties = p.specialty ? [p.specialty] : [];
        personalDocsByKey.set(mapKey, {
          id: `${idPrefix}-${p.user_id || p.id}`,
          user_id: p.user_id || null,
          provider_id: p.id,
          provider_name: meta.provider_name || null,
          provider_phone: meta.provider_phone || null,
          provider_email: meta.provider_email || null,
          category,
          target_step: 'credentials',
          title,
          owner_label: ownerLabel,
          specialties,
          subtitle: `${ownerLabel}${specialties.length ? ` · ${specialties.join(' · ')}` : ''}`,
          ...evalResult,
        });
      } else {
        if (p.specialty && !existing.specialties.includes(p.specialty)) {
          existing.specialties.push(p.specialty);
          existing.subtitle = `${existing.owner_label} · ${existing.specialties.join(' · ')}`;
        }
        // Si hubiera fechas distintas entre rubros históricos, conservar la más crítica (menor days_remaining)
        if (evalResult.days_remaining < existing.days_remaining) {
          existing.days_remaining = evalResult.days_remaining;
          existing.expiry_date = evalResult.expiry_date;
          existing.severity = evalResult.severity;
        }
      }
    };

    registerPersonalAlert(
      'criminal_record',
      'Antecedentes Penales',
      evaluateExpiryDate(p.criminal_record_expiry, windowDays),
      'criminal'
    );
    registerPersonalAlert(
      'provider_art',
      'Póliza ART / Seguro Personal',
      evaluateExpiryDate(p.insurance_expiry, windowDays),
      'insurance'
    );
  });

  personalDocsByKey.forEach((item) => {
    const { owner_label: _ignoredOwnerLabel, ...cleanAlert } = item;
    alerts.push(cleanAlert);
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
          criminal_record_issued_at,
          criminal_record_expiry,
          COALESCE(criminal_record_metadata, '{}'::jsonb) AS criminal_record_metadata,
          insurance_policy_url,
          insurance_expiry,
          COALESCE(insurance_metadata, '{}'::jsonb) AS insurance_metadata,
          status,
          COALESCE(is_visible_in_directory, TRUE) AS is_visible_in_directory,
          COALESCE(is_custom_specialty, FALSE) AS is_custom_specialty,
          custom_specialty_description,
          COALESCE(specialty_approval_status, 'approved') AS specialty_approval_status,
          COALESCE(accepts_emergencies, FALSE) AS accepts_emergencies,
          COALESCE(quote_visit_policy, 'consultar') AS quote_visit_policy,
          COALESCE(invoice_type, 'consultar') AS invoice_type,
          COALESCE(accepted_payment_methods, '["efectivo","transferencia","mercadopago"]'::jsonb) AS accepted_payment_methods,
          service_bio,
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
          COALESCE(metadata, '{}'::jsonb) AS metadata,
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

    // Etapa 4: Calcular alertas de vencimiento (30 días), membresía, reputación, tiempo de respuesta y Q&A en paralelo
    const [expiryAlerts, membership, repMetricsRes, topTagsRes, visitsForSpeedRes, publicQuestionsRes] =
      await Promise.all([
        Promise.resolve(
          buildProviderExpiryAlerts({
            providers: providersRes.rows.map((p) => ({ ...p, user_id: p.user_id || userId })),
            vehicles,
            employees,
            windowDays: 30,
          })
        ),
        getActiveMembershipForUser(userId),
        db.query(
          `
            SELECT
              (SELECT COUNT(*)::int FROM service_contracts sc JOIN providers p ON p.id = sc.provider_id WHERE p.user_id = $1) AS total_jobs,
              (SELECT COUNT(*)::int FROM service_contracts sc JOIN providers p ON p.id = sc.provider_id WHERE p.user_id = $1 AND sc.status = 'completed'::contract_status) AS completed_jobs,
              (SELECT COUNT(*)::int FROM provider_reviews pr JOIN providers p ON p.id = pr.provider_id WHERE p.user_id = $1) AS reviews_count,
              (SELECT COALESCE(AVG(pr.rating), 0)::numeric(4,2) FROM provider_reviews pr JOIN providers p ON p.id = pr.provider_id WHERE p.user_id = $1) AS rating_avg,
              (SELECT COUNT(*)::int FROM public.service_disputes sd JOIN service_contracts sc ON sc.id = sd.contract_id JOIN providers p ON p.id = sc.provider_id WHERE p.user_id = $1) AS disputes_count
          `,
          [userId]
        ),
        db.query(
          `
            SELECT tag, COUNT(*)::int AS count
            FROM provider_reviews pr
            JOIN providers p ON p.id = pr.provider_id
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.tags, '[]'::jsonb)) AS tag
            WHERE p.user_id = $1
            GROUP BY tag
            ORDER BY count DESC, tag ASC
            LIMIT 5
          `,
          [userId]
        ),
        db
          .query(
            `
              SELECT vr.created_at, vr.messages
              FROM visit_requests vr
              JOIN providers p ON p.id = vr.provider_id
              WHERE p.user_id = $1
              ORDER BY vr.id DESC
              LIMIT 100
            `,
            [userId]
          )
          .catch(() => ({ rows: [] })),
        db.query(
          `
            SELECT
              q.id,
              q.provider_user_id,
              q.asked_by_user_id,
              q.question,
              q.answer,
              q.created_at,
              q.answered_at,
              u.first_name AS asked_by_first_name,
              u.last_name AS asked_by_last_name
            FROM public.provider_public_questions q
            LEFT JOIN public.users u ON u.id = q.asked_by_user_id
            WHERE q.provider_user_id = $1
            ORDER BY (q.answer IS NULL) DESC, q.id DESC
            LIMIT 50
          `,
          [userId]
        ),
      ]);

    const repRow = repMetricsRes.rows[0] || {};
    const responseStats = computeResponseTimeStats(visitsForSpeedRes.rows);
    const hasExpiredPersonalDocs = expiryAlerts.some(
      (a) => a.severity === 'expired' && (a.category === 'criminal_record' || a.category === 'art_insurance')
    );
    const reputation = {
      ...computeProviderReputation({
        ratingAvg: Number(repRow.rating_avg || providersRes.rows[0]?.rating_avg || 0),
        reviewsCount: Number(repRow.reviews_count || 0),
        completedJobs: Number(repRow.completed_jobs || 0),
        totalJobs: Number(repRow.total_jobs || 0),
        disputesCount: Number(repRow.disputes_count || 0),
        hasExpiredDocs: hasExpiredPersonalDocs,
        isVerifiedMember: Boolean(membership?.is_verified_member),
      }),
      rating_avg: Number(repRow.rating_avg || 0),
      reviews_count: Number(repRow.reviews_count || 0),
      completed_jobs: Number(repRow.completed_jobs || 0),
      total_jobs: Number(repRow.total_jobs || 0),
      disputes_count: Number(repRow.disputes_count || 0),
      top_tags: topTagsRes.rows,
      avg_response_minutes: responseStats.avg_response_minutes,
      response_label: responseStats.response_label,
    };

    // Consultar estado de N0–N4 (celular, DNI frente/dorso, identidad validada y cotejo automático N4)
    const userIdentityRes = await db.query(
      `SELECT
         dni,
         dni_document_url,
         dni_back_url,
         COALESCE(phone_verified, TRUE) AS phone_verified,
         phone_verified_at,
         COALESCE(identity_verified, FALSE) AS identity_verified,
         identity_verified_at,
         COALESCE(auto_verified, FALSE) AS auto_verified,
         auto_verified_at,
         COALESCE(is_active, TRUE) AS is_active
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    const userIdentityRow = userIdentityRes.rows[0] || {};
    const meRows = providersRes.rows || [];
    const meHasVisibleSpec = meRows.some(
      (r) =>
        r.status !== 'rejected' &&
        String(r.specialty_approval_status || 'approved').toLowerCase() === 'approved' &&
        r.is_visible_in_directory !== false
    );
    const meHasCriminalDoc = meRows.some((r) => Boolean(r.criminal_record_url)) ||
      (versionsRes.rows || []).some((v) => {
        const dt = String(v.doc_type || '').toLowerCase();
        return dt.includes('criminal') || dt.includes('anteced');
      });
    const meHasArtDoc = meRows.some((r) => Boolean(r.insurance_policy_url)) ||
      (versionsRes.rows || []).some((v) => {
        const dt = String(v.doc_type || '').toLowerCase();
        return dt.includes('art') || dt.includes('seguro') || dt.includes('insurance');
      });
    const meLatestCriminalIssuedAt =
      meRows.find((r) => r.criminal_record_issued_at)?.criminal_record_issued_at || null;
    const meLatestCriminalExpiry =
      meRows.find((r) => r.criminal_record_expiry)?.criminal_record_expiry || null;
    const meCrimExpired = meRows.some((r) => isExpiryDatePast(r.criminal_record_expiry));
    const meArtExpired = meRows.some((r) => isExpiryDatePast(r.insurance_expiry));
    const meComplianceApproved = meRows.some((r) => r.status === 'approved');
    const meAllRejected = meRows.length > 0 && meRows.every((r) => r.status === 'rejected');

    const trustBadge = computeProviderTrustLevel({
      userIsActive: userIdentityRow.is_active !== false,
      phoneVerified: userIdentityRow.phone_verified !== false,
      identityVerified: Boolean(userIdentityRow.identity_verified),
      hasVisibleSpecialty: meHasVisibleSpec,
      hasCriminalDoc: meHasCriminalDoc,
      criminalExpired: meCrimExpired,
      criminalRecordIssuedAt: meLatestCriminalIssuedAt,
      criminalRecordExpiry: meLatestCriminalExpiry,
      criminalRecordMaxAgeDays: DEFAULT_CRIMINAL_WINDOW_DAYS,
      hasArtDoc: meHasArtDoc,
      artExpired: meArtExpired,
      complianceApproved: meComplianceApproved,
      autoVerified: Boolean(userIdentityRow.auto_verified),
      isAllRejected: meAllRejected,
      isVerifiedMember: Boolean(membership?.is_verified_member),
    });

    const primaryProfile = providersRes.rows[0] || null;
    const commercialProfile = primaryProfile
      ? {
          accepts_emergencies: Boolean(primaryProfile.accepts_emergencies),
          quote_visit_policy: primaryProfile.quote_visit_policy || 'consultar',
          invoice_type: primaryProfile.invoice_type || 'consultar',
          accepted_payment_methods: Array.isArray(primaryProfile.accepted_payment_methods)
            ? primaryProfile.accepted_payment_methods
            : ['efectivo', 'transferencia', 'mercadopago'],
          service_bio: primaryProfile.service_bio || '',
        }
      : {
          accepts_emergencies: false,
          quote_visit_policy: 'consultar',
          invoice_type: 'consultar',
          accepted_payment_methods: ['efectivo', 'transferencia', 'mercadopago'],
          service_bio: '',
        };

    await ensureServicePackagesTable();
    const servicePackagesRes = await db.query(
      `SELECT id, user_id, provider_id, specialty, title, includes_description,
              fixed_price, estimated_duration_minutes, is_active, created_at, updated_at
       FROM public.provider_service_packages
       WHERE user_id = $1
       ORDER BY is_active DESC, id DESC`,
      [userId]
    );

    return res.status(200).json({
      dni: userIdentityRow.dni || null,
      dni_document_url: userIdentityRow.dni_document_url || null,
      dni_back_url: userIdentityRow.dni_back_url || null,
      phone_verified: userIdentityRow.phone_verified !== false,
      phone_verified_at: userIdentityRow.phone_verified_at || null,
      identity_verified: Boolean(userIdentityRow.identity_verified) || meComplianceApproved,
      identity_verified_at: userIdentityRow.identity_verified_at || null,
      auto_verified: Boolean(userIdentityRow.auto_verified),
      auto_verified_at: userIdentityRow.auto_verified_at || null,
      is_featured_partner: Boolean(trustBadge.is_featured_partner),
      trust_level: trustBadge.level,
      trust_badge: trustBadge,
      providers: providersRes.rows,
      document_history: versionsRes.rows,
      vehicles,
      employees,
      expiry_alerts: expiryAlerts,
      membership,
      membership_plans: MEMBERSHIP_PLANS,
      reputation,
      response_stats: responseStats,
      commercial_profile: commercialProfile,
      public_questions: publicQuestionsRes.rows,
      service_packages: servicePackagesRes.rows,
      standard_specialties_catalog: STANDARD_SPECIALTIES_CATALOG,
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
 * Incluye indicadores de catálogo estándar vs. especialidad personalizada (`is_custom_specialty`,
 * `custom_specialty_description`, `specialty_approval_status`).
 * GET /api/v1/providers/all
 *
 * @param {import('express').Request} req - Solicitud HTTP de usuario Ops/Superadmin.
 * @param {import('express').Response} res - Respuesta HTTP con la nómina priorizada de prestadores.
 * @returns {Promise<import('express').Response>}
 */
const listAllProvidersForOps = async (req, res) => {
  try {
    await ensureEvolutionSchema();
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
        u.dni_document_url,
        u.dni_back_url,
        u.email,
        u.phone,
        COALESCE(u.phone_verified, TRUE) AS phone_verified,
        COALESCE(u.identity_verified, FALSE) AS identity_verified,
        u.identity_verified_at,
        COALESCE(u.auto_verified, FALSE) AS auto_verified,
        u.auto_verified_at,
        COALESCE(u.is_active, TRUE) AS user_is_active,
        COALESCE(p.is_visible_in_directory, TRUE) AS is_visible_in_directory,
        COALESCE(p.specialty, 'Sin especificar (Perfil Incompleto)') AS specialty,
        COALESCE(p.is_custom_specialty, FALSE) AS is_custom_specialty,
        p.custom_specialty_description,
        COALESCE(p.specialty_approval_status, 'approved') AS specialty_approval_status,
        p.criminal_record_url,
        p.criminal_record_issued_at,
        p.criminal_record_expiry,
        COALESCE(p.criminal_record_metadata, '{}'::jsonb) AS criminal_record_metadata,
        p.insurance_policy_url,
        p.insurance_expiry,
        COALESCE(p.insurance_metadata, '{}'::jsonb) AS insurance_metadata,
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
    return res.status(200).json({
      count: result.rows.length,
      standard_specialties_catalog: STANDARD_SPECIALTIES_CATALOG,
      providers: result.rows,
    });
  } catch (error) {
    console.error('Error al listar prestadores para Ops:', error);
    return res.status(500).json({ error: 'Error interno.' });
  }
};

/**
 * Actualiza el estado de compliance (`approved`, `rejected` o `pending`) de una especialidad puntual
 * (o de una especialidad personalizada en moderación) y sincroniza `specialty_approval_status`
 * y las versiones documentales registradas en `provider_document_versions`.
 * PATCH /api/v1/providers/compliance
 *
 * @param {import('express').Request} req - Solicitud HTTP con `provider_id` o `user_id` y el nuevo `status`.
 * @param {import('express').Response} res - Respuesta HTTP con el perfil actualizado.
 * @returns {Promise<import('express').Response>}
 */
const updateComplianceStatus = async (req, res) => {
  try {
    // Etapa 1: Asegurar esquema/tabla de historial documental y validar que el estado solicitado sea permitido
    await ensureEvolutionSchema();
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
            VALUES ($1, 'Mantenimiento General', $2)
            RETURNING id
          `,
          [user_id, status]
        );
        targetProviderId = newProv.rows[0].id;
      }
    }

    // Etapa 3: Actualizar estado y estado de moderación de especialidad en `providers`
    const updateQuery = `
      UPDATE providers
      SET status = $1::provider_status,
          specialty_approval_status = CASE
            WHEN COALESCE(is_custom_specialty, FALSE) = TRUE THEN $2::varchar
            ELSE COALESCE(specialty_approval_status, 'approved')
          END
      WHERE id = $3
      RETURNING id, user_id, specialty, is_custom_specialty, specialty_approval_status, status;
    `;

    const result = await db.query(updateQuery, [status, status, targetProviderId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado en la base de datos.' });
    }

    const updatedProvider = result.rows[0];
    if (status === 'approved' && updatedProvider?.user_id) {
      await db.query(
        `UPDATE users
         SET identity_verified = TRUE,
             identity_verified_at = COALESCE(identity_verified_at, NOW())
         WHERE id = $1`,
        [updatedProvider.user_id]
      );
    }
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
 * Aprueba, rechaza o vuelve a pendiente el compliance personal consolidado de una persona (`user_id`)
 * en una sola operación (Fase 5.3):
 * - Al aprobar (`'approved'`): aprueba todas las especialidades del catálogo estándar (`is_custom_specialty = FALSE`)
 *   y las personalizadas ya moderadas, dejando en revisión puntual cualquier especialidad personalizada nueva
 *   (`is_custom_specialty = TRUE AND specialty_approval_status = 'pending'`).
 * - Al rechazar o volver a pendiente: aplica el estado a todos los perfiles de esa persona y sincroniza
 *   `provider_document_versions`.
 * PATCH /api/v1/providers/compliance/user
 *
 * @param {import('express').Request} req - Solicitud HTTP con `{ user_id, status }`.
 * @param {import('express').Response} res - Respuesta HTTP con el resumen de perfiles actualizados.
 * @returns {Promise<import('express').Response>}
 */
const updateUserComplianceStatus = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    await ensureDocumentVersionsTable();

    const targetUserId = parseInt(req.body?.user_id, 10);
    const status = String(req.body?.status || '').trim().toLowerCase();

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un user_id válido.' });
    }
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado de compliance inválido.' });
    }

    const existingRes = await db.query(
      `SELECT id, is_custom_specialty, COALESCE(specialty_approval_status, 'approved') AS specialty_approval_status
       FROM providers
       WHERE user_id = $1`,
      [targetUserId]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'El usuario aún no tiene perfiles de prestador cargados.' });
    }

    let updatedRows = [];
    if (status === 'approved') {
      const updRes = await db.query(
        `UPDATE providers
         SET status = 'approved'::provider_status
         WHERE user_id = $1
           AND (
             COALESCE(is_custom_specialty, FALSE) = FALSE
             OR COALESCE(specialty_approval_status, 'approved') = 'approved'
           )
         RETURNING id, user_id, specialty, status`,
        [targetUserId]
      );
      updatedRows = updRes.rows;
    } else {
      const updRes = await db.query(
        `UPDATE providers
         SET status = $1::provider_status
         WHERE user_id = $2
         RETURNING id, user_id, specialty, status`,
        [status, targetUserId]
      );
      updatedRows = updRes.rows;
    }

    if (status === 'approved') {
      await db.query(
        `UPDATE users
         SET identity_verified = TRUE,
             identity_verified_at = COALESCE(identity_verified_at, NOW())
         WHERE id = $1`,
        [targetUserId]
      );
    }

    await db.query(
      `UPDATE public.provider_document_versions
       SET status = $1
       WHERE user_id = $2`,
      [status, targetUserId]
    );

    const pendingCustomCount = existingRes.rows.filter(
      (r) => Boolean(r.is_custom_specialty) && r.specialty_approval_status === 'pending'
    ).length;

    return res.status(200).json({
      message:
        status === 'approved'
          ? pendingCustomCount > 0
            ? `Compliance personal aprobado (${updatedRows.length} rubro(s) estándar activados). Queda(n) ${pendingCustomCount} especialidad(es) personalizada(s) para revisión puntual.`
            : `Compliance personal aprobado correctamente (${updatedRows.length} especialidad(es) activas).`
          : `Compliance personal actualizado a "${status}" (${updatedRows.length} registro(s)).`,
      user_id: targetUserId,
      status,
      updated_count: updatedRows.length,
      pending_custom_specialties: pendingCustomCount,
      providers: updatedRows,
    });
  } catch (error) {
    console.error('Error al actualizar compliance personal del prestador:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el compliance personal.' });
  }
};

/**
 * Registra o actualiza el enlace/archivo del documento de identidad (DNI) del prestador autenticado
 * para que Administración TrustLink pueda revisarlo y aprobar su validación de DNI (Nivel 1).
 * PATCH /api/v1/providers/identity/document
 *
 * @param {import('express').Request} req - Solicitud HTTP con `{ dni_document_url }`.
 * @param {import('express').Response} res - Respuesta HTTP con el registro actualizado.
 * @returns {Promise<import('express').Response>}
 */
const updateMyIdentityDocument = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const userId = Number(req.user.userId);
    const rawUrl = String(req.body?.dni_document_url || '').trim();
    const rawBackUrl =
      req.body?.dni_back_url !== undefined && req.body?.dni_back_url !== null
        ? String(req.body.dni_back_url).trim()
        : undefined;
    const rawDni =
      req.body?.dni !== undefined && req.body?.dni !== null
        ? String(req.body.dni).replace(/\D+/g, '').trim()
        : undefined;

    if (!rawUrl || rawUrl.length < 4) {
      return res.status(400).json({
        error: 'Ingresá el enlace o URL válida de tu documento de identidad (frente o PDF).',
      });
    }

    if (rawDni !== undefined && rawDni.length > 0) {
      if (rawDni.length < 6 || rawDni.length > 12) {
        return res.status(400).json({ error: 'Ingresá un número de DNI válido (solo dígitos).' });
      }
      const dupCheck = await db.query('SELECT id FROM users WHERE dni = $1 AND id <> $2 LIMIT 1', [
        rawDni,
        userId,
      ]);
      if (dupCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Ese número de DNI ya está asociado a otra cuenta.' });
      }
    }

    const cleanUrl = rawUrl.slice(0, 1000);
    const cleanBackUrl = rawBackUrl !== undefined ? (rawBackUrl ? rawBackUrl.slice(0, 1000) : null) : undefined;

    const upd = await db.query(
      `UPDATE users
       SET dni_document_url = $1,
           dni_back_url = CASE WHEN $2::boolean THEN $3 ELSE dni_back_url END,
           dni = CASE WHEN $4::boolean THEN $5 ELSE dni END
       WHERE id = $6
       RETURNING id, first_name, last_name, dni, dni_document_url, dni_back_url, identity_verified, identity_verified_at`,
      [
        cleanUrl,
        cleanBackUrl !== undefined,
        cleanBackUrl ?? null,
        Boolean(rawDni),
        rawDni || null,
        userId,
      ]
    );

    if (upd.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    return res.status(200).json({
      message: upd.rows[0].identity_verified
        ? 'Documento de identidad (DNI) actualizado correctamente.'
        : 'Documento de identidad (DNI) cargado. Administración TrustLink ya puede revisarlo para validar tu Nivel 1.',
      user: upd.rows[0],
    });
  } catch (error) {
    console.error('Error al cargar documento de identidad (DNI):', error);
    return res.status(500).json({ error: 'Error interno al guardar el documento de identidad.' });
  }
};

/**
 * Valida o revoca la identidad básica (DNI) de un prestador para habilitar o pausar
 * su visibilidad progresiva de Nivel 1 (Perfil Básico) en el directorio de residentes.
 * PATCH /api/v1/providers/identity/verify
 */
const updateUserIdentityVerification = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const targetUserId = parseInt(req.body?.user_id, 10);
    const verified = req.body?.verified !== undefined ? Boolean(req.body.verified) : true;

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un user_id válido.' });
    }

    const upd = await db.query(
      `UPDATE users
       SET identity_verified = $1,
           identity_verified_at = CASE WHEN $1 THEN COALESCE(identity_verified_at, NOW()) ELSE NULL END
       WHERE id = $2
       RETURNING id, first_name, last_name, dni, dni_document_url, dni_back_url, email, identity_verified, identity_verified_at`,
      [verified, targetUserId]
    );

    if (upd.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    return res.status(200).json({
      message: verified
        ? 'DNI validado correctamente. El prestador ya puede figurar en el directorio (Nivel 1) si tiene especialidad activa.'
        : 'Validación de DNI revocada.',
      user: upd.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar validación de DNI:', error);
    return res.status(500).json({ error: 'Error interno al actualizar validación de DNI.' });
  }
};

/**
 * Otorga o revoca el sello Nivel 4 "Verificado TrustLink" (cotejo automático/cruzado de PDFs
 * contra los datos cargados por el prestador). Exige tener Nivel 3 (compliance aprobado) vigente.
 * PATCH /api/v1/providers/auto-verify
 */
const updateUserAutoVerification = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const targetUserId = parseInt(req.body?.user_id, 10);
    const verified = req.body?.verified !== undefined ? Boolean(req.body.verified) : true;

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un user_id válido.' });
    }

    if (verified) {
      const checkRes = await db.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'approved'::provider_status)::int AS approved_count
         FROM providers
         WHERE user_id = $1`,
        [targetUserId]
      );
      if (Number(checkRes.rows[0]?.approved_count || 0) === 0) {
        return res.status(400).json({
          error: 'Para otorgar el sello Nivel 4 (Verificado), el prestador primero debe tener Nivel 3 (compliance aprobado).',
        });
      }
    }

    const upd = await db.query(
      `UPDATE users
       SET auto_verified = $1,
           auto_verified_at = CASE WHEN $1 THEN NOW() ELSE NULL END
       WHERE id = $2
       RETURNING id, first_name, last_name, email, auto_verified, auto_verified_at`,
      [verified, targetUserId]
    );

    if (upd.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    return res.status(200).json({
      message: verified
        ? 'Sello Nivel 4 (Verificado TrustLink — cotejo de PDFs) otorgado correctamente.'
        : 'Sello Nivel 4 (Verificado TrustLink) revocado.',
      user: upd.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar verificación automática N4:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el sello Nivel 4.' });
  }
};

/**
 * Permite al rol `superadmin` asignar directamente una especialidad (de catálogo o nueva)
 * a un prestador existente desde el panel de Compliance:
 * - Evita duplicados (insensible a mayúsculas/tildes) para el mismo `user_id`.
 * - Hereda la documentación vigente del prestador (Antecedentes + Seguro AP/ART) y su estado
 *   de compliance personal (`approved` si ya está aprobado en N3/N4, o `pending` si aún no).
 * - Marca `specialty_approval_status = 'approved'` y `is_visible_in_directory = TRUE` al ser
 *   cargada directamente por un `superadmin`.
 * POST /api/v1/providers/admin/specialty
 */
const addSpecialtyForProviderByAdmin = async (req, res) => {
  try {
    await ensureEvolutionSchema();

    const targetUserId = parseInt(req.body?.user_id, 10);
    const rawSpecialty = String(req.body?.specialty || '').trim();

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un user_id válido.' });
    }
    if (!rawSpecialty || rawSpecialty.length < 2) {
      return res.status(400).json({ error: 'Indicá un nombre de especialidad válido (mínimo 2 caracteres).' });
    }

    const userRes = await db.query(
      'SELECT id, first_name, last_name, email, role, is_active FROM users WHERE id = $1 LIMIT 1',
      [targetUserId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario prestador no encontrado.' });
    }

    const catalogMatch = resolveSpecialtyCatalogMatch(rawSpecialty);
    const cleanSpecialty = String(catalogMatch.canonicalSpecialty || rawSpecialty).trim().slice(0, 100);
    const isCustom = !catalogMatch.isStandard;

    const existingSpecsRes = await db.query(
      `SELECT
         id,
         specialty,
         status,
         criminal_record_url,
         criminal_record_issued_at,
         criminal_record_expiry,
         COALESCE(criminal_record_metadata, '{}'::jsonb) AS criminal_record_metadata,
         insurance_policy_url,
         insurance_expiry,
         COALESCE(insurance_metadata, '{}'::jsonb) AS insurance_metadata
       FROM providers
       WHERE user_id = $1
       ORDER BY id DESC`,
      [targetUserId]
    );

    const normalizeKey = (s) =>
      String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();

    const targetNorm = normalizeKey(cleanSpecialty);
    const alreadyExists = existingSpecsRes.rows.some((r) => normalizeKey(r.specialty) === targetNorm);
    if (alreadyExists) {
      return res.status(409).json({
        error: `El prestador ya tiene cargada la especialidad "${cleanSpecialty}".`,
      });
    }

    const approvedBase = existingSpecsRes.rows.find((r) => r.status === 'approved') || null;
    const docsBase =
      approvedBase ||
      existingSpecsRes.rows.find(
        (r) =>
          r.criminal_record_url ||
          r.insurance_policy_url ||
          r.criminal_record_expiry ||
          r.insurance_expiry
      ) ||
      null;

    const initialStatus = approvedBase ? 'approved' : 'pending';

    const insertRes = await db.query(
      `INSERT INTO providers (
         user_id,
         specialty,
         criminal_record_url,
         criminal_record_issued_at,
         criminal_record_expiry,
         criminal_record_metadata,
         insurance_policy_url,
         insurance_expiry,
         insurance_metadata,
         is_custom_specialty,
         specialty_approval_status,
         is_visible_in_directory,
         status
       )
       VALUES ($1, $2, $3, $4::date, $5::date, $6::jsonb, $7, $8::date, $9::jsonb, $10, 'approved', TRUE, $11::provider_status)
       RETURNING
         id,
         user_id,
         specialty,
         is_custom_specialty,
         specialty_approval_status,
         is_visible_in_directory,
         status,
         created_at`,
      [
        targetUserId,
        cleanSpecialty,
        docsBase?.criminal_record_url || null,
        docsBase?.criminal_record_issued_at || null,
        docsBase?.criminal_record_expiry || null,
        JSON.stringify(docsBase?.criminal_record_metadata || {}),
        docsBase?.insurance_policy_url || null,
        docsBase?.insurance_expiry || null,
        JSON.stringify(docsBase?.insurance_metadata || {}),
        isCustom,
        initialStatus,
      ]
    );

    return res.status(201).json({
      message: `Especialidad "${cleanSpecialty}" agregada correctamente al prestador.`,
      provider: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al agregar especialidad desde Superadmin:', error);
    return res.status(500).json({ error: 'Error interno al agregar la especialidad.' });
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
    await ensureLocalSuspensionsTable();
    await db.query(`
      CREATE TABLE IF NOT EXISTS provider_schedule_blocks (
        id SERIAL PRIMARY KEY,
        provider_id INTEGER NOT NULL,
        block_type VARCHAR(30) NOT NULL DEFAULT 'unavailable',
        title VARCHAR(160) NOT NULL,
        start_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        end_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        source_ref VARCHAR(80) NULL,
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    const viewerUserId = req.user?.userId ? Number(req.user.userId) : null;
    const viewerCountryId = req.user?.countryId ? Number(req.user.countryId) : null;

    // Consultar la ventana de vigencia de Antecedentes Penales configurada por la comunidad del residente
    let communityCriminalWindowDays = DEFAULT_CRIMINAL_WINDOW_DAYS;
    if (viewerCountryId) {
      const winRes = await db
        .query(
          'SELECT COALESCE(criminal_record_max_age_days, 180) AS max_days FROM countries WHERE id = $1 LIMIT 1',
          [viewerCountryId]
        )
        .catch(() => ({ rows: [] }));
      if (winRes.rows[0]?.max_days) {
        communityCriminalWindowDays = Number(winRes.rows[0].max_days);
      }
    }

    /*
     * Etapa 2: Consulta consolidada del directorio público enriquecido (Fase 5 — Marketplace & Scoring):
     * 1) CTE `approved_profiles`: filtra perfiles con compliance aprobado (`approved`), visibles en
     *    directorio (`is_visible_in_directory = TRUE`), cuenta activa y portal prestador habilitado;
     *    calcula trabajos totales/completados, reseñas, reclamos y actividad hiper-local en el barrio
     *    del residente autenticado (`community_jobs_count` y `community_visits_count`).
     * 2) Agregación principal (`GROUP BY ap.user_id`): unifica las especialidades de la persona,
     *    promedia `rating_avg`, calcula `has_expired_docs`, `has_active_local_suspension`,
     *    favoritos (`is_favorite`), disponibilidad hoy (`has_open_schedule_today`) y `top_tags`.
     * 3) Subconsultas `JSON_AGG`: embebe flota vehicular (`vehicles`) y cuadrilla activa (`employees`).
     * 4) `LEFT JOIN LATERAL` sobre `provider_subscriptions`: detecta membresía Socio Verificado activa.
     * 5) Ranking `ORDER BY`: 1° Socio Verificado activo, 2° `verified_pro`, 3° mayor rating promedio,
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
          COALESCE(u.phone_verified, TRUE) AS phone_verified,
          COALESCE(u.identity_verified, FALSE) AS identity_verified,
          COALESCE(u.auto_verified, FALSE) AS auto_verified,
          p.status AS profile_status,
          p.criminal_record_url,
          p.criminal_record_issued_at,
          p.insurance_policy_url,
          p.specialty,
          p.criminal_record_expiry,
          p.insurance_expiry,
          COALESCE(p.accepts_emergencies, FALSE) AS accepts_emergencies,
          COALESCE(p.quote_visit_policy, 'consultar') AS quote_visit_policy,
          COALESCE(p.invoice_type, 'consultar') AS invoice_type,
          COALESCE(p.accepted_payment_methods, '["efectivo","transferencia","mercadopago"]'::jsonb) AS accepted_payment_methods,
          p.service_bio,
          COALESCE(p.rating_avg, 0.00)::numeric(4,2) AS rating_avg,
          p.id AS ordered_id,
          (
            SELECT COUNT(*)::int
            FROM service_contracts sc
            WHERE sc.provider_id = p.id
          ) AS profile_jobs,
          (
            SELECT COUNT(*)::int
            FROM service_contracts sc
            WHERE sc.provider_id = p.id
              AND sc.status = 'completed'::contract_status
          ) AS profile_completed_jobs,
          (
            SELECT COUNT(*)::int
            FROM provider_reviews pr
            WHERE pr.provider_id = p.id
          ) AS profile_reviews_count,
          (
            SELECT COUNT(*)::int
            FROM public.service_disputes sd
            JOIN service_contracts sc ON sc.id = sd.contract_id
            WHERE sc.provider_id = p.id
          ) AS profile_disputes_count,
          (
            SELECT COUNT(*)::int
            FROM service_contracts sc
            WHERE sc.provider_id = p.id
              AND $2::int IS NOT NULL
              AND sc.country_id = $2::int
              AND sc.status IN ('in_progress'::contract_status, 'completed'::contract_status)
          ) AS profile_community_jobs,
          (
            SELECT COUNT(*)::int
            FROM access_passes ap_pass
            WHERE ap_pass.provider_id = p.id
              AND $2::int IS NOT NULL
              AND ap_pass.country_id = $2::int
              AND ap_pass.status = 'used'::pass_status
          ) AS profile_community_visits
        FROM providers p
        JOIN users u ON p.user_id = u.id
        WHERE (
            p.status = 'approved'::provider_status
            OR (
              COALESCE(u.phone_verified, TRUE) = TRUE
              AND COALESCE(u.identity_verified, FALSE) = TRUE
              AND p.status = 'pending'::provider_status
            )
          )
          AND COALESCE(p.specialty_approval_status, 'approved') = 'approved'
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
        -- Promedio consolidado real a nivel persona desde provider_reviews (evita dilucion por especialidades sin resenas)
        COALESCE(
          (
            SELECT ROUND(AVG(pr.rating)::numeric, 2)
            FROM provider_reviews pr
            JOIN providers p_rev ON p_rev.id = pr.provider_id
            WHERE p_rev.user_id = ap.user_id
          ),
          ROUND(AVG(ap.rating_avg) FILTER (WHERE ap.rating_avg > 0)::numeric, 2),
          0.00
        ) AS rating_avg,
        COALESCE(SUM(ap.profile_jobs), 0)::int AS total_jobs,
        COALESCE(SUM(ap.profile_completed_jobs), 0)::int AS completed_jobs,
        COALESCE(SUM(ap.profile_reviews_count), 0)::int AS reviews_count,
        COALESCE(SUM(ap.profile_disputes_count), 0)::int AS disputes_count,
        COALESCE(SUM(ap.profile_community_jobs), 0)::int AS community_jobs_count,
        COALESCE(SUM(ap.profile_community_visits), 0)::int AS community_visits_count,
        BOOL_OR(ap.accepts_emergencies) AS accepts_emergencies,
        (ARRAY_AGG(ap.quote_visit_policy ORDER BY ap.ordered_id ASC))[1] AS quote_visit_policy,
        (ARRAY_AGG(ap.invoice_type ORDER BY ap.ordered_id ASC))[1] AS invoice_type,
        (ARRAY_AGG(ap.accepted_payment_methods ORDER BY ap.ordered_id ASC))[1] AS accepted_payment_methods,
        (ARRAY_AGG(ap.service_bio ORDER BY ap.ordered_id ASC) FILTER (WHERE ap.service_bio IS NOT NULL))[1] AS service_bio,
        (
          SELECT COUNT(*)::int
          FROM public.provider_public_questions ppq
          WHERE ppq.provider_user_id = ap.user_id
        ) AS public_questions_count,
        (
          SELECT COUNT(*)::int
          FROM public.provider_public_questions ppq
          WHERE ppq.provider_user_id = ap.user_id
            AND ppq.answer IS NULL
        ) AS unanswered_questions_count,
        COALESCE(sub.is_verified_member, FALSE) AS is_verified_member,
        sub.plan_code AS membership_tier,
        sub.ends_at AS membership_ends_at,
        BOOL_OR(ap.phone_verified) AS phone_verified,
        BOOL_OR(ap.identity_verified) AS identity_verified,
        BOOL_OR(ap.auto_verified) AS auto_verified,
        BOOL_OR(ap.profile_status = 'approved'::provider_status) AS has_approved_compliance,
        BOOL_OR(ap.criminal_record_url IS NOT NULL AND BTRIM(ap.criminal_record_url) <> '') AS has_criminal_doc,
        BOOL_OR(ap.insurance_policy_url IS NOT NULL AND BTRIM(ap.insurance_policy_url) <> '') AS has_art_doc,
        MAX(ap.criminal_record_issued_at) AS criminal_record_issued_at,
        MAX(ap.criminal_record_expiry) AS criminal_record_expiry,
        BOOL_OR(ap.criminal_record_expiry IS NOT NULL AND ap.criminal_record_expiry < CURRENT_DATE) AS criminal_expired,
        BOOL_OR(ap.insurance_expiry IS NOT NULL AND ap.insurance_expiry < CURRENT_DATE) AS art_expired,
        (
          BOOL_OR(ap.criminal_record_expiry IS NOT NULL AND ap.criminal_record_expiry < CURRENT_DATE)
          OR BOOL_OR(ap.insurance_expiry IS NOT NULL AND ap.insurance_expiry < CURRENT_DATE)
        ) AS has_expired_docs,
        EXISTS (
          SELECT 1
          FROM public.provider_local_suspensions pls
          JOIN providers p_sus ON p_sus.id = pls.provider_id
          WHERE p_sus.user_id = ap.user_id
            AND pls.active = TRUE
            AND $2::int IS NOT NULL
            AND pls.country_id = $2::int
        ) AS has_active_local_suspension,
        EXISTS (
          SELECT 1
          FROM public.resident_favorite_providers rfp
          WHERE rfp.resident_user_id = $1::int
            AND rfp.provider_user_id = ap.user_id
        ) AS is_favorite,
        NOT EXISTS (
          SELECT 1
          FROM provider_schedule_blocks psb
          JOIN providers p_blk ON p_blk.id = psb.provider_id
          WHERE p_blk.user_id = ap.user_id
            AND psb.block_type = 'unavailable'
            AND psb.start_at < (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day')
            AND psb.end_at > (NOW() AT TIME ZONE 'UTC')
        ) AS has_open_schedule_today,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT('tag', t.tag, 'count', t.cnt)
              ORDER BY t.cnt DESC, t.tag ASC
            )
            FROM (
              SELECT tag, COUNT(*)::int AS cnt
              FROM provider_reviews pr
              JOIN providers p4 ON p4.id = pr.provider_id
              CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.tags, '[]'::jsonb)) AS tag
              WHERE p4.user_id = ap.user_id
              GROUP BY tag
              ORDER BY cnt DESC, tag ASC
              LIMIT 3
            ) t
          ),
          '[]'::json
        ) AS top_tags,
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
        rating_avg DESC,
        ap.user_id ASC;
    `;

    const result = await db.query(query, [viewerUserId, viewerCountryId]);

    // Etapa 2.5: Consultar en batch hilos de `visit_requests` y catálogo de servicios con precio fijo
    await ensureServicePackagesTable();
    const providerUserIds = result.rows.map((r) => Number(r.user_id)).filter(Boolean);
    const visitsByUserId = new Map();
    const packagesByUserId = new Map();
    if (providerUserIds.length > 0) {
      const [visitsRes, packagesRes] = await Promise.all([
        db
          .query(
            `
              SELECT p.user_id, vr.created_at, vr.messages
              FROM visit_requests vr
              JOIN providers p ON p.id = vr.provider_id
              WHERE p.user_id = ANY($1::int[])
              ORDER BY vr.id DESC
              LIMIT 1000
            `,
            [providerUserIds]
          )
          .catch(() => ({ rows: [] })),
        db
          .query(
            `
              SELECT id, user_id, provider_id, specialty, title, includes_description,
                     fixed_price, estimated_duration_minutes, is_active
              FROM public.provider_service_packages
              WHERE user_id = ANY($1::int[]) AND is_active = TRUE
              ORDER BY fixed_price ASC, id DESC
            `,
            [providerUserIds]
          )
          .catch(() => ({ rows: [] })),
      ]);

      for (const vr of visitsRes.rows) {
        const uid = Number(vr.user_id);
        if (!visitsByUserId.has(uid)) visitsByUserId.set(uid, []);
        visitsByUserId.get(uid).push(vr);
      }
      for (const pkg of packagesRes.rows) {
        const uid = Number(pkg.user_id);
        if (!packagesByUserId.has(uid)) packagesByUserId.set(uid, []);
        packagesByUserId.get(uid).push({
          ...pkg,
          fixed_price: Number(pkg.fixed_price || 0),
          estimated_duration_minutes: Number(pkg.estimated_duration_minutes || 60),
        });
      }
    }

    // Etapa 3: Calcular termómetro de reputación, tiempo de respuesta, disponibilidad hoy y actividad hiper-local
    const enrichedProviders = result.rows.map((row) => {
      const hasExpiredDocs = Boolean(row.has_expired_docs);
      const hasActiveLocalSuspension = Boolean(row.has_active_local_suspension);
      const availableToday =
        Boolean(row.has_open_schedule_today) && !hasExpiredDocs && !hasActiveLocalSuspension;
      const communityJobsCount = Number(row.community_jobs_count || 0);
      const communityVisitsCount = Number(row.community_visits_count || 0);
      const communityActivityCount = Math.max(communityJobsCount, communityVisitsCount);
      const responseStats = computeResponseTimeStats(visitsByUserId.get(Number(row.user_id)) || []);

      const reputation = computeProviderReputation({
        ratingAvg: Number(row.rating_avg || 0),
        reviewsCount: Number(row.reviews_count || 0),
        completedJobs: Number(row.completed_jobs || 0),
        totalJobs: Number(row.total_jobs || 0),
        disputesCount: Number(row.disputes_count || 0),
        hasExpiredDocs,
        hasActiveLocalSuspension,
        isVerifiedMember: Boolean(row.is_verified_member),
      });

      const trustBadge = computeProviderTrustLevel({
        userIsActive: true,
        phoneVerified: row.phone_verified !== false,
        identityVerified: Boolean(row.identity_verified),
        hasVisibleSpecialty: true,
        hasCriminalDoc: Boolean(row.has_criminal_doc),
        criminalExpired: Boolean(row.criminal_expired),
        criminalRecordIssuedAt: row.criminal_record_issued_at || null,
        criminalRecordExpiry: row.criminal_record_expiry || null,
        criminalRecordMaxAgeDays: communityCriminalWindowDays,
        hasArtDoc: Boolean(row.has_art_doc),
        artExpired: Boolean(row.art_expired),
        complianceApproved: Boolean(row.has_approved_compliance),
        autoVerified: Boolean(row.auto_verified),
        isAllRejected: false,
        isVerifiedMember: Boolean(row.is_verified_member),
      });

      const effectiveHasExpiredDocs = Boolean(trustBadge.has_expired_docs);

      return {
        ...row,
        has_expired_docs: effectiveHasExpiredDocs,
        identity_verified: Boolean(row.identity_verified) || Boolean(row.has_approved_compliance),
        auto_verified: Boolean(row.auto_verified),
        is_featured_partner: Boolean(trustBadge.is_featured_partner),
        trust_level: trustBadge.level,
        trust_tier: trustBadge.tier,
        trust_badge: trustBadge,
        is_verified: trustBadge.is_verified,
        can_issue_pass: trustBadge.can_issue_pass,
        available_today: Boolean(row.has_open_schedule_today) && !effectiveHasExpiredDocs && !hasActiveLocalSuspension,
        community_jobs_count: communityJobsCount,
        community_visits_count: communityVisitsCount,
        community_activity_count: communityActivityCount,
        avg_response_minutes: responseStats.avg_response_minutes,
        response_label: responseStats.response_label,
        service_packages: packagesByUserId.get(Number(row.user_id)) || [],
        reputation,
      };
    });

    // Ordenar priorizando: 1) Eje Comercial (Destacado en N3–N4), 2) Nivel de Confianza (4 -> 3 -> 2 -> 1), 3) Rating
    enrichedProviders.sort((a, b) => {
      const aFeat = a.is_featured_partner ? 1 : 0;
      const bFeat = b.is_featured_partner ? 1 : 0;
      if (bFeat !== aFeat) return bFeat - aFeat;
      if (b.trust_level !== a.trust_level) return b.trust_level - a.trust_level;
      const aPro = a.membership_tier === 'verified_pro' ? 0 : 1;
      const bPro = b.membership_tier === 'verified_pro' ? 0 : 1;
      if (aPro !== bPro) return aPro - bPro;
      const ratingDiff = Number(b.rating_avg || 0) - Number(a.rating_avg || 0);
      if (ratingDiff !== 0) return ratingDiff;
      return Number(a.user_id || 0) - Number(b.user_id || 0);
    });

    const verifiedOnly =
      String(req.query.verified_only || '').trim().toLowerCase() === 'true' ||
      String(req.query.verified_only || '').trim() === '1';
    const finalProviders = verifiedOnly
      ? enrichedProviders.filter((p) => p.is_verified)
      : enrichedProviders;

    return res.status(200).json({
      count: finalProviders.length,
      community_criminal_window_days: communityCriminalWindowDays,
      available_review_tags: REVIEW_MICRO_TAGS,
      providers: finalProviders,
    });
  } catch (error) {
    console.error('Error al listar prestadores verificados:', error);
    return res.status(500).json({
      error: 'Error interno del servidor al obtener el directorio.'
    });
  }
};

/**
 * Vidriera pública de prestadores activos para la Landing sin autenticación.
 * Expone exclusivamente datos comerciales, especialidades, insignias de confianza progresiva
 * (`N1..N5`), controles verificados (`DNI · Antecedentes · ART · Pase QR`), reputación y
 * conteos por categoría, omitiendo estrictamente datos personales sensibles (`email`, `phone`,
 * `dni`, enlaces documentales, patentes y nómina de ayudantes).
 * GET /api/v1/providers/public-showcase
 *
 * @param {import('express').Request} req - Solicitud HTTP pública con parámetros opcionales `limit` y `verified_only`.
 * @param {import('express').Response} res - Respuesta HTTP con resumen de red, categorías y tarjetas seguras.
 * @returns {Promise<import('express').Response>}
 */
const listPublicProviderShowcase = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    await db.query(`
      CREATE TABLE IF NOT EXISTS provider_schedule_blocks (
        id SERIAL PRIMARY KEY,
        provider_id INTEGER NOT NULL,
        block_type VARCHAR(30) NOT NULL DEFAULT 'unavailable',
        title VARCHAR(160) NOT NULL,
        start_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        end_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        source_ref VARCHAR(80) NULL,
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(24, requestedLimit))
      : 24;
    const verifiedOnly =
      String(req.query.verified_only || '').trim().toLowerCase() === 'true' ||
      String(req.query.verified_only || '').trim() === '1';

    const [showcaseRes, communitiesRes] = await Promise.all([
      db.query(`
        WITH visible_profiles AS (
          SELECT
            p.id AS provider_id,
            p.user_id,
            u.first_name,
            u.last_name,
            COALESCE(u.phone_verified, TRUE) AS phone_verified,
            COALESCE(u.identity_verified, FALSE) AS identity_verified,
            COALESCE(u.auto_verified, FALSE) AS auto_verified,
            p.status AS profile_status,
            p.criminal_record_url,
            p.criminal_record_issued_at,
            p.insurance_policy_url,
            p.specialty,
            p.criminal_record_expiry,
            p.insurance_expiry,
            COALESCE(p.accepts_emergencies, FALSE) AS accepts_emergencies,
            COALESCE(p.quote_visit_policy, 'consultar') AS quote_visit_policy,
            COALESCE(p.invoice_type, 'consultar') AS invoice_type,
            COALESCE(p.accepted_payment_methods, '["efectivo","transferencia","mercadopago"]'::jsonb) AS accepted_payment_methods,
            p.service_bio,
            COALESCE(p.rating_avg, 0.00)::numeric(4,2) AS rating_avg,
            p.id AS ordered_id,
            (
              SELECT COUNT(*)::int
              FROM service_contracts sc
              WHERE sc.provider_id = p.id
            ) AS profile_jobs,
            (
              SELECT COUNT(*)::int
              FROM service_contracts sc
              WHERE sc.provider_id = p.id
                AND sc.status = 'completed'::contract_status
            ) AS profile_completed_jobs,
            (
              SELECT COUNT(*)::int
              FROM provider_reviews pr
              WHERE pr.provider_id = p.id
            ) AS profile_reviews_count,
            (
              SELECT COUNT(*)::int
              FROM public.service_disputes sd
              JOIN service_contracts sc ON sc.id = sd.contract_id
              WHERE sc.provider_id = p.id
            ) AS profile_disputes_count
          FROM providers p
          JOIN users u ON p.user_id = u.id
          WHERE (
              p.status = 'approved'::provider_status
              OR (COALESCE(u.identity_verified, FALSE) = TRUE AND p.status = 'pending'::provider_status)
            )
            AND COALESCE(p.specialty_approval_status, 'approved') = 'approved'
            AND COALESCE(p.is_visible_in_directory, TRUE) = TRUE
            AND COALESCE(u.is_active, TRUE) = TRUE
            AND COALESCE(u.can_use_provider, FALSE) = TRUE
        )
        SELECT
          (ARRAY_AGG(vp.provider_id ORDER BY vp.ordered_id ASC))[1] AS showcase_id,
          vp.user_id,
          vp.first_name,
          vp.last_name,
          STRING_AGG(DISTINCT vp.specialty, ' · ' ORDER BY vp.specialty) AS specialties_label,
          ARRAY_AGG(DISTINCT vp.specialty ORDER BY vp.specialty) AS specialties,
          (ARRAY_AGG(vp.specialty ORDER BY vp.ordered_id ASC))[1] AS specialty,
          COALESCE(
            (
              SELECT ROUND(AVG(pr.rating)::numeric, 2)
              FROM provider_reviews pr
              JOIN providers p_rev ON p_rev.id = pr.provider_id
              WHERE p_rev.user_id = vp.user_id
            ),
            ROUND(AVG(vp.rating_avg) FILTER (WHERE vp.rating_avg > 0)::numeric, 2),
            0.00
          ) AS rating_avg,
          COALESCE(SUM(vp.profile_jobs), 0)::int AS total_jobs,
          COALESCE(SUM(vp.profile_completed_jobs), 0)::int AS completed_jobs,
          COALESCE(SUM(vp.profile_reviews_count), 0)::int AS reviews_count,
          COALESCE(SUM(vp.profile_disputes_count), 0)::int AS disputes_count,
          BOOL_OR(vp.accepts_emergencies) AS accepts_emergencies,
          (ARRAY_AGG(vp.quote_visit_policy ORDER BY vp.ordered_id ASC))[1] AS quote_visit_policy,
          (ARRAY_AGG(vp.invoice_type ORDER BY vp.ordered_id ASC))[1] AS invoice_type,
          (ARRAY_AGG(vp.accepted_payment_methods ORDER BY vp.ordered_id ASC))[1] AS accepted_payment_methods,
          (ARRAY_AGG(vp.service_bio ORDER BY vp.ordered_id ASC) FILTER (WHERE vp.service_bio IS NOT NULL))[1] AS service_bio,
          (
            SELECT COUNT(*)::int
            FROM public.provider_public_questions ppq
            WHERE ppq.provider_user_id = vp.user_id
              AND ppq.answer IS NOT NULL
          ) AS answered_questions_count,
          COALESCE(sub.is_verified_member, FALSE) AS is_verified_member,
          sub.plan_code AS membership_tier,
          BOOL_OR(vp.phone_verified) AS phone_verified,
          BOOL_OR(vp.identity_verified) AS identity_verified,
          BOOL_OR(vp.auto_verified) AS auto_verified,
          BOOL_OR(vp.profile_status = 'approved'::provider_status) AS has_approved_compliance,
          BOOL_OR(vp.criminal_record_url IS NOT NULL AND BTRIM(vp.criminal_record_url) <> '') AS has_criminal_doc,
          BOOL_OR(vp.insurance_policy_url IS NOT NULL AND BTRIM(vp.insurance_policy_url) <> '') AS has_art_doc,
          MAX(vp.criminal_record_issued_at) AS criminal_record_issued_at,
          MAX(vp.criminal_record_expiry) AS criminal_record_expiry,
          BOOL_OR(vp.criminal_record_expiry IS NOT NULL AND vp.criminal_record_expiry < CURRENT_DATE) AS criminal_expired,
          BOOL_OR(vp.insurance_expiry IS NOT NULL AND vp.insurance_expiry < CURRENT_DATE) AS art_expired,
          (
            BOOL_OR(vp.criminal_record_expiry IS NOT NULL AND vp.criminal_record_expiry < CURRENT_DATE)
            OR BOOL_OR(vp.insurance_expiry IS NOT NULL AND vp.insurance_expiry < CURRENT_DATE)
          ) AS has_expired_docs,
          NOT EXISTS (
            SELECT 1
            FROM provider_schedule_blocks psb
            JOIN providers p_blk ON p_blk.id = psb.provider_id
            WHERE p_blk.user_id = vp.user_id
              AND psb.block_type = 'unavailable'
              AND psb.start_at < (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day')
              AND psb.end_at > (NOW() AT TIME ZONE 'UTC')
          ) AS has_open_schedule_today,
          COALESCE(
            (
              SELECT JSON_AGG(
                JSON_BUILD_OBJECT('tag', t.tag, 'count', t.cnt)
                ORDER BY t.cnt DESC, t.tag ASC
              )
              FROM (
                SELECT tag, COUNT(*)::int AS cnt
                FROM provider_reviews pr
                JOIN providers p4 ON p4.id = pr.provider_id
                CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.tags, '[]'::jsonb)) AS tag
                WHERE p4.user_id = vp.user_id
                GROUP BY tag
                ORDER BY cnt DESC, tag ASC
                LIMIT 3
              ) t
            ),
            '[]'::json
          ) AS top_tags
        FROM visible_profiles vp
        LEFT JOIN LATERAL (
          SELECT
            ps.plan_code,
            TRUE AS is_verified_member
          FROM public.provider_subscriptions ps
          WHERE ps.user_id = vp.user_id
            AND ps.status IN ('active', 'trialing')
            AND ps.ends_at > NOW()
          ORDER BY
            CASE WHEN ps.plan_code = 'verified_pro' THEN 0 ELSE 1 END ASC,
            ps.ends_at DESC,
            ps.id DESC
          LIMIT 1
        ) sub ON TRUE
        GROUP BY
          vp.user_id,
          vp.first_name,
          vp.last_name,
          sub.is_verified_member,
          sub.plan_code
      `),
      db.query(`SELECT COUNT(*)::int AS total FROM public.countries`).catch(() => ({
        rows: [{ total: 0 }],
      })),
    ]);

    await ensureServicePackagesTable();
    const showcaseUserIds = showcaseRes.rows.map((r) => Number(r.user_id)).filter(Boolean);
    const showcasePackagesByUserId = new Map();
    if (showcaseUserIds.length > 0) {
      const spRes = await db
        .query(
          `SELECT id, user_id, provider_id, specialty, title, includes_description,
                  fixed_price, estimated_duration_minutes
           FROM public.provider_service_packages
           WHERE user_id = ANY($1::int[]) AND is_active = TRUE
           ORDER BY fixed_price ASC, id DESC`,
          [showcaseUserIds]
        )
        .catch(() => ({ rows: [] }));
      for (const pkg of spRes.rows) {
        const uid = Number(pkg.user_id);
        if (!showcasePackagesByUserId.has(uid)) showcasePackagesByUserId.set(uid, []);
        showcasePackagesByUserId.get(uid).push({
          id: Number(pkg.id),
          specialty: pkg.specialty,
          title: pkg.title,
          includes_description: pkg.includes_description || null,
          fixed_price: Number(pkg.fixed_price || 0),
          estimated_duration_minutes: Number(pkg.estimated_duration_minutes || 60),
        });
      }
    }

    const enriched = showcaseRes.rows.map((row) => {
      const hasExpiredDocs = Boolean(row.has_expired_docs);
      const trustBadge = computeProviderTrustLevel({
        userIsActive: true,
        phoneVerified: row.phone_verified !== false,
        identityVerified: Boolean(row.identity_verified),
        hasVisibleSpecialty: true,
        hasCriminalDoc: Boolean(row.has_criminal_doc),
        criminalExpired: Boolean(row.criminal_expired),
        criminalRecordIssuedAt: row.criminal_record_issued_at || null,
        criminalRecordExpiry: row.criminal_record_expiry || null,
        criminalRecordMaxAgeDays: DEFAULT_CRIMINAL_WINDOW_DAYS,
        hasArtDoc: Boolean(row.has_art_doc),
        artExpired: Boolean(row.art_expired),
        complianceApproved: Boolean(row.has_approved_compliance),
        autoVerified: Boolean(row.auto_verified),
        isAllRejected: false,
        isVerifiedMember: Boolean(row.is_verified_member),
      });

      const effectiveHasExpiredDocs = Boolean(trustBadge.has_expired_docs);

      const reputation = computeProviderReputation({
        ratingAvg: Number(row.rating_avg || 0),
        reviewsCount: Number(row.reviews_count || 0),
        completedJobs: Number(row.completed_jobs || 0),
        totalJobs: Number(row.total_jobs || 0),
        disputesCount: Number(row.disputes_count || 0),
        hasExpiredDocs: effectiveHasExpiredDocs,
        hasActiveLocalSuspension: false,
        isVerifiedMember: Boolean(row.is_verified_member),
      });

      const displayName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Prestador TrustLink';

      return {
        showcase_id: Number(row.showcase_id),
        display_name: displayName,
        first_name: row.first_name || '',
        last_name: row.last_name || '',
        specialty: row.specialty || '',
        specialties: Array.isArray(row.specialties) ? row.specialties : [],
        specialties_label: row.specialties_label || row.specialty || '',
        rating_avg: Number(row.rating_avg || 0),
        reviews_count: Number(row.reviews_count || 0),
        completed_jobs: Number(row.completed_jobs || 0),
        accepts_emergencies: Boolean(row.accepts_emergencies),
        quote_visit_policy: row.quote_visit_policy || 'consultar',
        invoice_type: row.invoice_type || 'consultar',
        accepted_payment_methods: Array.isArray(row.accepted_payment_methods)
          ? row.accepted_payment_methods
          : ['efectivo', 'transferencia', 'mercadopago'],
        service_bio: row.service_bio ? String(row.service_bio).slice(0, 220) : null,
        answered_questions_count: Number(row.answered_questions_count || 0),
        top_tags: Array.isArray(row.top_tags) ? row.top_tags : [],
        is_verified_member: Boolean(row.is_verified_member),
        is_featured_partner: Boolean(trustBadge.is_featured_partner),
        membership_tier: row.membership_tier || null,
        has_expired_docs: effectiveHasExpiredDocs,
        available_today: Boolean(row.has_open_schedule_today) && !effectiveHasExpiredDocs,
        auto_verified: Boolean(row.auto_verified),
        trust_level: trustBadge.level,
        trust_tier: trustBadge.tier,
        trust_badge: trustBadge,
        is_verified: trustBadge.is_verified,
        can_issue_pass: trustBadge.can_issue_pass,
        service_packages: showcasePackagesByUserId.get(Number(row.user_id)) || [],
        reputation,
      };
    });

    // Priorizar vigentes primero, luego nivel de confianza (5 -> 1), plan pro, rating y trabajos completados
    enriched.sort((a, b) => {
      if (a.has_expired_docs !== b.has_expired_docs) return a.has_expired_docs ? 1 : -1;
      if (b.trust_level !== a.trust_level) return b.trust_level - a.trust_level;
      const aPro = a.membership_tier === 'verified_pro' ? 0 : 1;
      const bPro = b.membership_tier === 'verified_pro' ? 0 : 1;
      if (aPro !== bPro) return aPro - bPro;
      if (b.rating_avg !== a.rating_avg) return b.rating_avg - a.rating_avg;
      return b.completed_jobs - a.completed_jobs;
    });

    // Construir conteo real por categoría/rubro para la grilla visual de la Landing
    const categoryMap = new Map();
    enriched.forEach((prov) => {
      const specs = Array.isArray(prov.specialties) && prov.specialties.length > 0
        ? prov.specialties
        : prov.specialty
          ? [prov.specialty]
          : [];
      specs.forEach((rawSpec) => {
        const name = String(rawSpec || '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        const curr = categoryMap.get(key) || { name, total_count: 0, verified_count: 0 };
        curr.total_count += 1;
        if (prov.is_verified && !prov.has_expired_docs) {
          curr.verified_count += 1;
        }
        categoryMap.set(key, curr);
      });
    });

    const categories = Array.from(categoryMap.values()).sort((a, b) => {
      if (b.verified_count !== a.verified_count) return b.verified_count - a.verified_count;
      if (b.total_count !== a.total_count) return b.total_count - a.total_count;
      return a.name.localeCompare(b.name, 'es');
    });

    const filteredProviders = verifiedOnly
      ? enriched.filter((p) => p.is_verified && !p.has_expired_docs)
      : enriched;

    return res.status(200).json({
      summary: {
        total_active_providers: enriched.length,
        verified_providers: enriched.filter((p) => p.is_verified && !p.has_expired_docs).length,
        socio_providers: enriched.filter((p) => p.trust_level === 5 && !p.has_expired_docs).length,
        emergency_providers: enriched.filter((p) => p.accepts_emergencies && !p.has_expired_docs).length,
        total_communities: Number(communitiesRes.rows[0]?.total || 0),
      },
      categories,
      count: Math.min(filteredProviders.length, limit),
      providers: filteredProviders.slice(0, limit),
    });
  } catch (error) {
    console.error('Error al consultar vidriera pública de prestadores:', error);
    return res.status(500).json({
      error: 'Error interno al consultar la vidriera pública de prestadores.',
    });
  }
};

/**
 * Lista los `provider_user_id` guardados como favoritos por el residente autenticado.
 * GET /api/v1/providers/favorites
 *
 * @param {import('express').Request} req - Solicitud HTTP del residente autenticado.
 * @param {import('express').Response} res - Respuesta HTTP con los IDs favoritos del residente.
 * @returns {Promise<import('express').Response>}
 */
const listFavoriteProviders = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const residentUserId = Number(req.user.userId);
    const favRes = await db.query(
      `SELECT provider_user_id, created_at
       FROM public.resident_favorite_providers
       WHERE resident_user_id = $1
       ORDER BY created_at DESC`,
      [residentUserId]
    );
    return res.status(200).json({
      count: favRes.rows.length,
      favorite_provider_user_ids: favRes.rows.map((r) => Number(r.provider_user_id)),
      favorites: favRes.rows,
    });
  } catch (error) {
    console.error('Error al listar prestadores favoritos:', error);
    return res.status(500).json({ error: 'Error interno al consultar tus favoritos.' });
  }
};

/**
 * Agrega un prestador (`providerUserId`) a la lista de "Mis prestadores de confianza"
 * del residente autenticado de forma idempotente (`ON CONFLICT DO NOTHING`).
 * POST /api/v1/providers/favorites/:providerUserId
 *
 * @param {import('express').Request} req - Solicitud HTTP con `:providerUserId` en params.
 * @param {import('express').Response} res - Respuesta HTTP `201` confirmando el favorito.
 * @returns {Promise<import('express').Response>}
 */
const addFavoriteProvider = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const residentUserId = Number(req.user.userId);
    const providerUserId = parseInt(req.params.providerUserId, 10);

    if (!Number.isInteger(providerUserId) || providerUserId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un identificador de prestador válido.' });
    }

    // Verificar que el usuario objetivo posea al menos un perfil registrado en `providers`
    const targetRes = await db.query(
      `SELECT id FROM providers WHERE user_id = $1 LIMIT 1`,
      [providerUserId]
    );
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    await db.query(
      `INSERT INTO public.resident_favorite_providers (resident_user_id, provider_user_id)
       VALUES ($1, $2)
       ON CONFLICT (resident_user_id, provider_user_id) DO NOTHING`,
      [residentUserId, providerUserId]
    );

    return res.status(201).json({
      message: 'Prestador guardado en tus favoritos de confianza.',
      provider_user_id: providerUserId,
      is_favorite: true,
    });
  } catch (error) {
    console.error('Error al guardar prestador favorito:', error);
    return res.status(500).json({ error: 'Error interno al guardar el prestador en favoritos.' });
  }
};

/**
 * Quita un prestador (`providerUserId`) de los favoritos del residente autenticado.
 * DELETE /api/v1/providers/favorites/:providerUserId
 *
 * @param {import('express').Request} req - Solicitud HTTP con `:providerUserId` en params.
 * @param {import('express').Response} res - Respuesta HTTP `200` confirmando la eliminación.
 * @returns {Promise<import('express').Response>}
 */
const removeFavoriteProvider = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const residentUserId = Number(req.user.userId);
    const providerUserId = parseInt(req.params.providerUserId, 10);

    if (!Number.isInteger(providerUserId) || providerUserId <= 0) {
      return res.status(400).json({ error: 'Debe indicar un identificador de prestador válido.' });
    }

    await db.query(
      `DELETE FROM public.resident_favorite_providers
       WHERE resident_user_id = $1 AND provider_user_id = $2`,
      [residentUserId, providerUserId]
    );

    return res.status(200).json({
      message: 'Prestador quitado de tus favoritos.',
      provider_user_id: providerUserId,
      is_favorite: false,
    });
  } catch (error) {
    console.error('Error al quitar prestador favorito:', error);
    return res.status(500).json({ error: 'Error interno al quitar el prestador de favoritos.' });
  }
};

/**
 * Actualiza la ficha comercial rápida del prestador autenticado en todas sus especialidades:
 * urgencias 24h, política de presupuesto/visita, condición de facturación, medios de pago
 * aceptados y breve descripción de servicios.
 * PATCH /api/v1/providers/commercial-profile
 *
 * @param {import('express').Request} req - Solicitud HTTP con los campos de ficha comercial.
 * @param {import('express').Response} res - Respuesta HTTP con la ficha normalizada y persistida.
 * @returns {Promise<import('express').Response>}
 */
const updateCommercialProfile = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const userId = Number(req.user.userId);
    const normalized = normalizeCommercialProfileInput(req.body || {});

    const updated = await db.query(
      `UPDATE providers
       SET
         accepts_emergencies = $1,
         quote_visit_policy = $2,
         invoice_type = $3,
         accepted_payment_methods = $4::jsonb,
         service_bio = $5
       WHERE user_id = $6
       RETURNING id`,
      [
        normalized.accepts_emergencies,
        normalized.quote_visit_policy,
        normalized.invoice_type,
        JSON.stringify(normalized.accepted_payment_methods),
        normalized.service_bio,
        userId,
      ]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({
        error: 'Primero debés registrar al menos una especialidad en Credenciales antes de completar tu ficha comercial.',
      });
    }

    return res.status(200).json({
      message: 'Ficha comercial y disponibilidad de urgencias actualizadas correctamente.',
      updated_profiles: updated.rows.length,
      commercial_profile: normalized,
    });
  } catch (error) {
    console.error('Error al actualizar ficha comercial del prestador:', error);
    return res.status(500).json({ error: 'Error interno al guardar la ficha comercial.' });
  }
};

/**
 * Lista las preguntas y respuestas públicas (Q&A estilo ficha de producto) de un prestador
 * identificado por `providerUserId`, visibles para toda la comunidad.
 * GET /api/v1/providers/:providerUserId/questions
 *
 * @param {import('express').Request} req - Solicitud HTTP con `:providerUserId` en params.
 * @param {import('express').Response} res - Respuesta HTTP con la lista ordenada de preguntas y respuestas.
 * @returns {Promise<import('express').Response>}
 */
const listProviderPublicQuestions = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const providerUserId = parseInt(req.params.providerUserId, 10);
    if (!Number.isInteger(providerUserId) || providerUserId <= 0) {
      return res.status(400).json({ error: 'Identificador de prestador inválido.' });
    }

    const questionsRes = await db.query(
      `SELECT
        q.id,
        q.provider_user_id,
        q.asked_by_user_id,
        q.question,
        q.answer,
        q.created_at,
        q.answered_at,
        u.first_name AS asked_by_first_name,
        u.last_name AS asked_by_last_name
       FROM public.provider_public_questions q
       LEFT JOIN public.users u ON u.id = q.asked_by_user_id
       WHERE q.provider_user_id = $1
       ORDER BY (q.answer IS NOT NULL) DESC, q.id DESC
       LIMIT 100`,
      [providerUserId]
    );

    return res.status(200).json({
      provider_user_id: providerUserId,
      count: questionsRes.rows.length,
      questions: questionsRes.rows,
    });
  } catch (error) {
    console.error('Error al consultar preguntas públicas del prestador:', error);
    return res.status(500).json({ error: 'Error interno al consultar preguntas del prestador.' });
  }
};

/**
 * Publica una nueva pregunta pública de un residente en la ficha del prestador (`providerUserId`).
 * POST /api/v1/providers/:providerUserId/questions
 *
 * @param {import('express').Request} req - Solicitud HTTP con `{ question }` en body.
 * @param {import('express').Response} res - Respuesta HTTP `201` con la pregunta registrada.
 * @returns {Promise<import('express').Response>}
 */
const askProviderPublicQuestion = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const askedByUserId = Number(req.user.userId);
    const providerUserId = parseInt(req.params.providerUserId, 10);
    const question = String(req.body?.question || '').trim();

    if (!Number.isInteger(providerUserId) || providerUserId <= 0) {
      return res.status(400).json({ error: 'Identificador de prestador inválido.' });
    }
    if (question.length < 5 || question.length > 400) {
      return res.status(400).json({
        error: 'La pregunta debe tener entre 5 y 400 caracteres.',
      });
    }

    // Validar que el destinatario sea un prestador registrado
    const targetRes = await db.query(
      `SELECT id FROM providers WHERE user_id = $1 LIMIT 1`,
      [providerUserId]
    );
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prestador no encontrado.' });
    }

    const insertRes = await db.query(
      `INSERT INTO public.provider_public_questions (provider_user_id, asked_by_user_id, question)
       VALUES ($1, $2, $3)
       RETURNING id, provider_user_id, asked_by_user_id, question, answer, created_at, answered_at`,
      [providerUserId, askedByUserId, question]
    );

    return res.status(201).json({
      message: 'Pregunta publicada. Cuando el prestador responda quedará visible para la comunidad.',
      question: insertRes.rows[0],
    });
  } catch (error) {
    console.error('Error al publicar pregunta pública al prestador:', error);
    return res.status(500).json({ error: 'Error interno al publicar la pregunta.' });
  }
};

/**
 * Permite al prestador dueño (o `superadmin`) responder o editar la respuesta de una
 * pregunta pública recibida en su ficha.
 * PATCH /api/v1/providers/questions/:questionId/answer
 *
 * @param {import('express').Request} req - Solicitud HTTP con `{ answer }` en body.
 * @param {import('express').Response} res - Respuesta HTTP `200` con la pregunta respondida.
 * @returns {Promise<import('express').Response>}
 */
const answerProviderPublicQuestion = async (req, res) => {
  try {
    await ensureEvolutionSchema();
    const actorUserId = Number(req.user.userId);
    const isSuperadmin = req.user.role === 'superadmin';
    const questionId = parseInt(req.params.questionId, 10);
    const answer = String(req.body?.answer || '').trim();

    if (!Number.isInteger(questionId) || questionId <= 0) {
      return res.status(400).json({ error: 'Identificador de pregunta inválido.' });
    }
    if (answer.length < 2 || answer.length > 500) {
      return res.status(400).json({
        error: 'La respuesta debe tener entre 2 y 500 caracteres.',
      });
    }

    const existingRes = await db.query(
      `SELECT id, provider_user_id FROM public.provider_public_questions WHERE id = $1`,
      [questionId]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pregunta no encontrada.' });
    }
    if (!isSuperadmin && Number(existingRes.rows[0].provider_user_id) !== actorUserId) {
      return res.status(403).json({
        error: 'Solo el prestador destinatario puede responder esta pregunta.',
      });
    }

    const updatedRes = await db.query(
      `UPDATE public.provider_public_questions
       SET answer = $1, answered_by_user_id = $2, answered_at = NOW()
       WHERE id = $3
       RETURNING id, provider_user_id, asked_by_user_id, question, answer, created_at, answered_at`,
      [answer, actorUserId, questionId]
    );

    return res.status(200).json({
      message: 'Respuesta publicada en tu ficha pública.',
      question: updatedRes.rows[0],
    });
  } catch (error) {
    console.error('Error al responder pregunta pública:', error);
    return res.status(500).json({ error: 'Error interno al guardar la respuesta.' });
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
    // Si es admin local sin `countryId` en el JWT, se consulta `users.country_id` en BD por si fue asignado tras iniciar sesión
    await ensureLocalSuspensionsTable();
    const countryIdParam = req.query.country_id ? parseInt(req.query.country_id, 10) : null;
    const isSuperadmin = req.user.role === 'superadmin';
    let effectiveCountryId =
      isSuperadmin && countryIdParam ? countryIdParam : req.user.countryId || null;

    if (!isSuperadmin && !effectiveCountryId && req.user?.userId) {
      const userCountryRes = await db.query(
        'SELECT country_id FROM public.users WHERE id = $1 LIMIT 1',
        [Number(req.user.userId)]
      );
      effectiveCountryId = userCountryRes.rows[0]?.country_id || null;
    }

    const params = [];
    let whereClause = '';
    if (effectiveCountryId && Number.isInteger(Number(effectiveCountryId)) && Number(effectiveCountryId) > 0) {
      params.push(Number(effectiveCountryId));
      whereClause = 'WHERE pls.country_id = $1';
    } else if (!isSuperadmin) {
      // Admin local sin barrio asignado: no exponer suspensiones de otras comunidades
      whereClause = 'WHERE 1 = 0';
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
          Number(effectiveCountryId),
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
    let effectiveCountryId =
      req.user.role === 'superadmin' && country_id
        ? parseInt(country_id, 10)
        : req.user.countryId || null;

    if (req.user.role !== 'superadmin' && !effectiveCountryId && req.user?.userId) {
      const userCountryRes = await db.query(
        'SELECT country_id FROM public.users WHERE id = $1 LIMIT 1',
        [Number(req.user.userId)]
      );
      effectiveCountryId = userCountryRes.rows[0]?.country_id || null;
    }

    if (!effectiveCountryId) {
      return res.status(400).json({
        error: 'Tu cuenta no tiene una comunidad asignada para registrar suspensiones locales.',
      });
    }

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

/**
 * Lista los servicios con precio fijo publicados por el prestador autenticado.
 * GET /api/v1/providers/service-packages
 */
const listMyServicePackages = async (req, res) => {
  try {
    await ensureServicePackagesTable();
    const userId = Number(req.user.userId);
    const result = await db.query(
      `SELECT id, user_id, provider_id, specialty, title, includes_description,
              fixed_price, estimated_duration_minutes, is_active, created_at, updated_at
       FROM public.provider_service_packages
       WHERE user_id = $1
       ORDER BY is_active DESC, id DESC`,
      [userId]
    );
    return res.status(200).json({ service_packages: result.rows });
  } catch (error) {
    console.error('Error al listar servicios con precio fijo:', error);
    return res.status(500).json({ error: 'Error interno al consultar tus servicios con precio fijo.' });
  }
};

/**
 * Crea un nuevo servicio estandarizado con precio fijo en el catálogo del prestador.
 * POST /api/v1/providers/service-packages
 */
const createServicePackage = async (req, res) => {
  try {
    await ensureServicePackagesTable();
    const userId = Number(req.user.userId);
    const {
      specialty,
      title,
      includes_description,
      fixed_price,
      estimated_duration_minutes,
    } = req.body || {};

    const cleanTitle = String(title || '').trim().slice(0, 160);
    const cleanIncludes = includes_description ? String(includes_description).trim().slice(0, 500) : null;
    const numericPrice = Number(fixed_price);
    const rawDuration = Number(estimated_duration_minutes || 60);
    const safeDuration = Number.isFinite(rawDuration)
      ? Math.min(480, Math.max(30, Math.round(rawDuration)))
      : 60;

    if (cleanTitle.length < 3) {
      return res.status(400).json({ error: 'Indicá un nombre claro para el servicio (mínimo 3 caracteres).' });
    }
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).json({ error: 'Ingresá un precio fijo válido mayor a cero.' });
    }

    const profilesRes = await db.query(
      `SELECT id, specialty
       FROM providers
       WHERE user_id = $1
       ORDER BY CASE WHEN status = 'approved'::provider_status THEN 0 ELSE 1 END, id ASC`,
      [userId]
    );
    if (profilesRes.rows.length === 0) {
      return res.status(400).json({ error: 'Registrá primero al menos una especialidad en tu perfil.' });
    }

    const requestedSpec = String(specialty || '').trim();
    const matchedProfile =
      profilesRes.rows.find(
        (p) => requestedSpec && String(p.specialty || '').trim().toLowerCase() === requestedSpec.toLowerCase()
      ) || profilesRes.rows[0];
    const resolvedSpecialty = requestedSpec || matchedProfile.specialty || 'Servicio General';

    const inserted = await db.query(
      `INSERT INTO public.provider_service_packages (
         user_id, provider_id, specialty, title, includes_description,
         fixed_price, estimated_duration_minutes, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING *`,
      [
        userId,
        Number(matchedProfile.id),
        resolvedSpecialty.slice(0, 120),
        cleanTitle,
        cleanIncludes,
        Number(numericPrice.toFixed(2)),
        safeDuration,
      ]
    );

    return res.status(201).json({
      message: `Servicio "${cleanTitle}" publicado con precio fijo.`,
      service_package: inserted.rows[0],
    });
  } catch (error) {
    console.error('Error al crear servicio con precio fijo:', error);
    return res.status(500).json({ error: 'Error interno al crear el servicio con precio fijo.' });
  }
};

/**
 * Edita o pausa/activa un servicio con precio fijo propio del prestador.
 * PATCH /api/v1/providers/service-packages/:id
 */
const updateServicePackage = async (req, res) => {
  try {
    await ensureServicePackagesTable();
    const userId = Number(req.user.userId);
    const pkgId = Number(req.params.id);
    if (!Number.isInteger(pkgId) || pkgId <= 0) {
      return res.status(400).json({ error: 'ID de servicio inválido.' });
    }

    const existingRes = await db.query(
      'SELECT * FROM public.provider_service_packages WHERE id = $1 AND user_id = $2 LIMIT 1',
      [pkgId, userId]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Servicio con precio fijo no encontrado.' });
    }
    const current = existingRes.rows[0];
    const body = req.body || {};

    const nextTitle =
      body.title !== undefined ? String(body.title).trim().slice(0, 160) : current.title;
    if (nextTitle.length < 3) {
      return res.status(400).json({ error: 'El nombre del servicio debe tener al menos 3 caracteres.' });
    }

    const nextPrice =
      body.fixed_price !== undefined ? Number(body.fixed_price) : Number(current.fixed_price);
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
      return res.status(400).json({ error: 'Ingresá un precio fijo válido mayor a cero.' });
    }

    const nextDurationRaw =
      body.estimated_duration_minutes !== undefined
        ? Number(body.estimated_duration_minutes)
        : Number(current.estimated_duration_minutes || 60);
    const nextDuration = Number.isFinite(nextDurationRaw)
      ? Math.min(480, Math.max(30, Math.round(nextDurationRaw)))
      : 60;

    const nextIncludes =
      body.includes_description !== undefined
        ? body.includes_description
          ? String(body.includes_description).trim().slice(0, 500)
          : null
        : current.includes_description;

    const nextIsActive =
      typeof body.is_active === 'boolean' ? body.is_active : Boolean(current.is_active);

    let nextSpecialty = current.specialty;
    let nextProviderId = current.provider_id;
    if (body.specialty !== undefined && String(body.specialty).trim()) {
      const requestedSpec = String(body.specialty).trim().slice(0, 120);
      nextSpecialty = requestedSpec;
      const specMatch = await db.query(
        `SELECT id FROM providers
         WHERE user_id = $1 AND LOWER(TRIM(COALESCE(specialty, ''))) = LOWER(TRIM($2))
         ORDER BY id ASC LIMIT 1`,
        [userId, requestedSpec]
      );
      if (specMatch.rows.length > 0) {
        nextProviderId = Number(specMatch.rows[0].id);
      }
    }

    const updated = await db.query(
      `UPDATE public.provider_service_packages
       SET provider_id = $1,
           specialty = $2,
           title = $3,
           includes_description = $4,
           fixed_price = $5,
           estimated_duration_minutes = $6,
           is_active = $7,
           updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [
        nextProviderId,
        nextSpecialty,
        nextTitle,
        nextIncludes,
        Number(nextPrice.toFixed(2)),
        nextDuration,
        nextIsActive,
        pkgId,
        userId,
      ]
    );

    return res.status(200).json({
      message: 'Servicio actualizado correctamente.',
      service_package: updated.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar servicio con precio fijo:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el servicio.' });
  }
};

/**
 * Elimina un servicio con precio fijo del catálogo del prestador.
 * DELETE /api/v1/providers/service-packages/:id
 */
const deleteServicePackage = async (req, res) => {
  try {
    await ensureServicePackagesTable();
    const userId = Number(req.user.userId);
    const pkgId = Number(req.params.id);
    if (!Number.isInteger(pkgId) || pkgId <= 0) {
      return res.status(400).json({ error: 'ID de servicio inválido.' });
    }

    const deleted = await db.query(
      'DELETE FROM public.provider_service_packages WHERE id = $1 AND user_id = $2 RETURNING id, title',
      [pkgId, userId]
    );
    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado o sin permisos.' });
    }

    return res.status(200).json({
      message: `Servicio "${deleted.rows[0].title}" eliminado de tu catálogo.`,
    });
  } catch (error) {
    console.error('Error al eliminar servicio con precio fijo:', error);
    return res.status(500).json({ error: 'Error interno al eliminar el servicio.' });
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
  listMyServicePackages,
  createServicePackage,
  updateServicePackage,
  deleteServicePackage,
  getMyProviderProfile,
  listAllProvidersForOps,
  updateComplianceStatus,
  updateUserComplianceStatus,
  updateMyIdentityDocument,
  updateUserIdentityVerification,
  updateUserAutoVerification,
  addSpecialtyForProviderByAdmin,
  listVerifiedProviders,
  listPublicProviderShowcase,
  listFavoriteProviders,
  addFavoriteProvider,
  removeFavoriteProvider,
  updateCommercialProfile,
  listProviderPublicQuestions,
  askProviderPublicQuestion,
  answerProviderPublicQuestion,
  listLocalSuspensions,
  createLocalSuspension,
  liftLocalSuspension,
  listExpiryAlertsForAdmin
};