# TrustLink — Especificación Oficial de Confianza Progresiva (N0 → N4) y Eje Comercial

> Versión: **2.0** · Fecha: **2026-11-26**
> Alcance: `trustlink-backend` + `trustlink-web`

---

## 1. Arquitectura de 3 Ejes Independientes

Para preservar la credibilidad ante residentes y garitas sin limitar el crecimiento comercial del marketplace, TrustLink separa estrictamente **tres ejes**:

| Eje | Qué mide | Cómo se obtiene |
| --- | --- | --- |
| **1. Confianza y Seguridad (`N0 → N4`)** | Cumplimiento documental, identidad y habilitación para garita | **100% objetivo — nunca se compra** |
| **2. Reputación (`★ + Termómetro`)** | Experiencia real de vecinos en trabajos conformados | Reseñas cruzadas post-servicio |
| **3. Visibilidad Comercial (`Destacado / Publicidad`)** | Posicionamiento prioritario, banners y herramientas Pro | Membresía / campañas **(habilitada solo desde `N3` o `N4` vigente)** |

---

## 2. Eje 1: Escala de Confianza y Seguridad (`N0 → N4`)

### `N0` — Cuenta creada *(oculto en directorio)*
- **Objetivo:** Registro liviano de mínima fricción (estilo MercadoLibre), sin pedir DNI ni documentación todavía.
- **Canales de alta (`role = 'provider'`):**
  1. **Google OAuth:** cuenta de Google + carga de celular + validación SMS/WhatsApp.
  2. **E-mail:** E-mail + Celular (`+54`) + Nombre y Apellido + Contraseña + consentimiento SMS/WhatsApp y Términos + validación SMS/WhatsApp.
- **Regla MVP:** el usuario se persiste en DB con `phone_verified = FALSE` (permitiendo validación mediante código OTP en modo `mock` o aprobación manual en 1 clic desde `Administración → Usuarios`).
- **Visibilidad:** **Oculto** en Landing y Portal Residente. Sin consultas ni Pases QR.

### `N1` — Perfil Básico *(visible en directorio · solo consultas)*
- **Requisitos obligatorios:**
  1. **N0** completado (`phone_verified = TRUE`).
  2. **Nro. de DNI** cargado + **DNI frente y dorso** (1 archivo PDF o 2 fotos: frente + dorso).
  3. **Validación de identidad aprobada** (`identity_verified = TRUE` — manual en MVP desde Administración; KYC con cámara + *liveness* + RENAPER en etapa de escala).
  4. Al menos **1 especialidad visible** en el directorio.
- **Visibilidad:** **Visible** en Landing y Portal Residente para consultas y presupuestos. **Sin Pase QR** en garita.

### `N2` — Cobertura cargada *(visible en directorio · solo consultas · `Seguro en revisión`)*
- **Requisitos obligatorios:**
  1. **N1** completado.
  2. Carga de cobertura vigente según modalidad de trabajo del prestador:
     - **Modalidad 1 — Independiente (trabaja solo): Seguro de Accidentes Personales (AP)**
       - Compañía aseguradora (`insurer_name`)
       - Nro. de póliza o certificado (`policy_number`)
       - Asegurado / CUIT (`holder_cuit`)
       - Vigencia (`valid_from` / `valid_to`)
       - Sumas aseguradas o alcances básicos (`coverage_summary`)
       - Comprobante PDF vigente (`document_url`)
     - **Modalidad 2 — Con ayudantes / cuadrilla: Póliza de ART**
       - Aseguradora / ART emisora (`insurer_name`)
       - Nro. de póliza o certificado de cobertura (`policy_number`)
       - Tomador / Afiliado CUIT (`holder_cuit`)
       - Vigencia (`valid_from` / `valid_to`)
       - Comprobante PDF vigente (`document_url`)
- **Estado:** Al cargar los datos completos y PDF vigente sube de inmediato a **N2** mostrando la etiqueta transparente **`Seguro en revisión`** hasta auditoría.
- **Visibilidad:** Visible solo para consultas. **Sin Pase QR** en garita.

### `N3` — Habilitado · Pase QR *(visible en directorio · Pases QR habilitados en garita)*
- **Requisitos obligatorios:**
  1. **N2** completado (DNI validado + Especialidad + Seguro AP o ART vigente).
  2. **Certificado de Antecedentes Penales** cargado con datos verificables:
     - **Fecha de emisión** (`issued_at`) — *base del cálculo automático de vigencia por barrio*
     - **Código de Solicitud / Trámite** (`request_code`)
     - **Código de Seguridad** (`security_code`)
     - **Comprobante PDF** (`document_url`)
  3. **Validación documental aprobada** por Operaciones / TrustLink (`complianceApproved = TRUE`) y documentación dentro de vigencia.
- **Motor de reglas de vigencia de Antecedentes por barrio (`countries.criminal_record_max_age_days`):**
  - El Certificado de Antecedentes Penales en Argentina tiene 5 días hábiles de validez oficial, por lo que cada comunidad configura en TrustLink su **ventana de antigüedad máxima aceptada** desde la `Fecha de emisión`: **`30`, `90`, `180` o `365` días** *(valor por defecto de red: **`180` días**)*.
  - El prestador carga su certificado **una sola vez** para toda la red.
  - Al consultar el directorio del residente o emitir/validar un Pase QR en garita, TrustLink evalúa dinámicamente `hoy <= fecha_emision + ventana_del_barrio`. Si excede la ventana local de un barrio más estricto, el Pase QR queda bloqueado **solo en ese barrio** hasta su renovación, manteniéndose vigente en los barrios que acepten esa ventana.
- **Habilitaciones:** Entra al filtro **`Solo Verificados (QR)`**, habilita emisión y escaneo de **Pases QR en garita**, y habilita el acceso al **Eje Comercial**.

### `N4` — Verificado TrustLink *(tilde oficial estilo X / Instagram)*
- **Requisitos obligatorios:**
  1. **N3** vigente y al día.
  2. **Validación automática/cruzada de PDFs (`auto_verified = TRUE`):** TrustLink corrobora que la información contenida en cada PDF cargado (DNI, Seguro AP/ART y Antecedentes Penales) coincida exactamente con los datos declarados por el prestador en la plataforma. *(En MVP operable desde `Administración → Prestadores` con marca de cotejo verificado; en etapa de escala automatizado mediante OCR/IA + verificación RNR/KYC).*
- **Habilitaciones:** Máximo sello oficial de confianza en toda la red (`Verificado 4/4 ✓`).

---

## 3. Eje 3: Visibilidad Comercial (`Destacado · Membresías · Publicidad`)

- **Desacoplado de `N1–N4`:** contratar una membresía **nunca** altera el nivel de seguridad ni permite saltarse requisitos documentales.
- **Requisito mínimo:** el prestador debe contar con **`N3` o `N4` vigente** (sin documentación vencida).
- **Beneficios comerciales:**
  - Etiqueta transparente **`Destacado`** junto a su insignia real (`N3 · Pase QR` o `N4 · Verificado`).
  - Prioridad de posicionamiento en el ordenamiento por defecto del directorio dentro de su rubro.
  - Base lista para futuras campañas de **banners**, **publicidad segmentada por barrio/temporada** y **paquetes con precio de referencia**.

---

## 4. Resumen Rápido de Migración Técnica

| Capa | Cambios principales |
| --- | --- |
| **PostgreSQL (`ensureEvolutionSchema.js`)** | `users`: `phone_verified`, `phone_verified_at`, `accepts_whatsapp_contact`, `auth_provider`, `dni_back_url`, `auto_verified`, `auto_verified_at`, `dni` nullable. `countries`: `criminal_record_max_age_days` (`30/90/180/365`, default `180`). `providers` / `provider_document_versions`: `metadata JSONB`, `insurance_metadata JSONB`, `criminal_record_metadata JSONB`, `criminal_record_issued_at DATE`. |
| **Motor de Confianza (`providerTrustLevel.js`)** | Nueva escala `0..4`, evaluación dinámica por `criminalRecordMaxAgeDays`, `can_issue_pass` desde `N3`, sello `N4` por `autoVerified`, y `is_featured_partner` desacoplado en Eje Comercial. |
| **API Auth / Providers / Passes / Countries** | Registro N0 sin DNI para `provider`, OTP mock + validación manual en Admin, formularios estructurados AP/ART y Antecedentes, política de ventana por barrio en directorio y garita, y toggle Admin de cotejo `N4`. |
| **Frontend (`trustlink-web`)** | Registro N0 estilo MeLi (Google / E-mail + SMS OTP), Portal Prestador `N1–N4` con selector AP vs ART y Antecedentes con fecha de emisión y códigos, Badges `N1–N4` + `Destacado`, y controles en Admin (Usuarios, Compliance y Comunidades). |
