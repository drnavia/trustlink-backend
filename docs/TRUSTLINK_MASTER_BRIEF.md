# TrustLink — Documento Maestro de Negocio y Producto

> Plataforma inteligente de servicios verificados y control de accesos perimetrales para comunidades privadas (countries y barrios cerrados).

---

## 1. Visión y Propuesta de Valor (Océano Azul)

Las comunidades cerradas crecieron de forma sostenida, pero la contratación de servicios domésticos/técnicos y la logística de ingreso en garitas continúan operando de forma fragmentada e informal. Los softwares tradicionales de expensas o control de accesos funcionan como **jardines cerrados administrativos**: no curan la oferta de servicios ni conectan una red reutilizable entre barrios.

**TrustLink** fusiona dos pilares en una red transversal e independiente:

1. **Confianza y Compliance Centralizado:** TrustLink (Operaciones / Superadmin) audita una única vez identidad, antecedentes penales, póliza ART / Seguro de Accidentes Personales, flota vehicular y cuadrilla/ayudantes. Un prestador aprobado puede operar en cualquier comunidad de la red.
2. **Automatización Logística Perimetral:** Emisión de pases digitales con token QR único, sincronizables con la garita o sistemas externos de barrios mediante API autenticada por comunidad, con validación instantánea y auditoría de accesos.

### Independencia Operativa frente a los Barrios
El barrio **no audita** antecedentes ni administra la red de prestadores: consume la verificación de TrustLink vía Consola Garita o API externa (`x-api-key` por comunidad), manteniendo autonomía para aplicar **suspensiones operativas locales** si un prestador incumple normas internas de ese barrio.

---

## 2. Dolores que Resuelve por Actor

### Residente / Propietario
- **Fin del caos en grupos de WhatsApp:** Reemplaza recomendaciones anárquicas por un directorio verificado con búsqueda por rubro y reputación real.
- **Mitigación de riesgo patrimonial y legal:** Garantiza visibilidad sobre DNI, antecedentes penales, póliza ART/seguro vigente y ayudantes declarados antes de permitir el ingreso al domicilio.
- **Acceso sin fricción burocrática:** Elimina llamados a administración, planillas manuales y rechazos evitables en garita mediante pases QR con destino y franja horaria exacta.
- **Trazabilidad post-servicio:** Registra coordinación de visita, orden de servicio/contrato, pago (si se procesa in-app) y reseña verificada.

### Prestador / Profesional Independiente
- **Eliminación del "efecto portón":** Evita horas perdidas en controles perimetrales gracias a documentación centralizada, vehículos declarados y **cuadrilla/ayudantes** adjuntos directamente al pase QR.
- **Diferenciación frente a competencia informal:** Certifica idoneidad, cumplimiento documental y scoring real basado en trabajos efectivos.
- **Formalización y previsibilidad de cobro:** Permite acordar presupuesto *in situ*, emitir orden de pago y construir historial verificable.

### Administración / Seguridad del Barrio
- **Descompresión de garitas:** Validación en segundos de vigencia horaria, identidad, patente, cuadrilla y estado de compliance.
- **Reducción de exposición legal:** Trazabilidad auditable de cada intento de ingreso autorizado o denegado (`gate_access_logs`) y alertas proactivas sobre vencimientos documentales.
- **Control local sin sobrecarga administrativa:** Capacidad de suspender operativamente a un prestador dentro de su barrio sin asumir el costo de auditar a toda la red.

---

## 3. Dinámica Operativa y Retención (Anti-Leakage en Argentina)

En el mercado argentino el pago en efectivo es habitual en servicios residenciales por liquidez y estructura fiscal. Por eso TrustLink **no depende exclusivamente** de forzar el cobro digital para generar valor ni para monetizar:

- **Flujo In Situ + Circuito In-App:** El residente busca en el directorio, coordina visita con agenda/mensajería interna, emite el Pase QR (incluyendo vehículo y ayudantes), el prestador cotiza y ejecuta el trabajo, se registra conformidad/pago y ambos emiten **reseña cruzada** (residente ↔ prestador).
- **Mecanismos Anti-Leakage (contra la desintermediación):**
  1. **Conveniencia en garita ("efecto portón"):** Operar con Pase QR de TrustLink es más rápido y ordenado que autorizar por fuera.
  2. **Reputación acumulable y visible:** Solo los contratos gestionados dentro del flujo construyen scoring real y posicionamiento.
  3. **Historial del hogar y respaldo:** Deja registro auditable de quién ingresó, con qué seguro vigente y qué trabajo realizó.

---

## 4. Modelo de Monetización Híbrido (SaaS B2B2C)

Los ingresos se estructuran en tres capas complementarias, desacoplando la sostenibilidad del negocio del uso de efectivo:

| Capa | Actor | Mecanismo | Propuesta de Valor | Estado en Código |
| :--- | :--- | :--- | :--- | :--- |
| **1. Membresía "Socio Verificado"** | Prestadores (B2C) | Abono mensual/trimestral recurrente | Verificación activa, insignia distintiva, visibilidad prioritaria en directorio, pases QR y reputación acumulable (incluso si parte de los trabajos se cobran en efectivo). | **✅ Implementado (Fase 1)** — `provider_subscriptions`, `/api/v1/billing`, ranking prioritario y gestión Superadmin |
| **2. Licenciamiento B2B a Comunidades** | Barrios / Countries (B2B) | Abono mensual SaaS | Acceso a Consola Garita, API Universal (`x-api-key` por comunidad), auditoría de accesos y alertas de vencimiento sin auditar antecedentes por cuenta propia. | **✅ Implementado (Fase 2)** — Planes B2B en `countries`, cuota mensual QR, enforcement en API externa y vistas Admin/Superadmin |
| **3. Comisión por Transacción (Take Rate)** | Transacciones In-App | 6%–8% (referencia actual: **7%**) | Desglose transparente (7% plataforma / 93% prestador) para operaciones procesadas en plataforma con trazabilidad financiera. | **✅ Implementado en modo dual (Fase 3)** — Checkout Pro Mercado Pago + firma `x-signature` oficial + modo `mock` piloto |

---

## 5. Estado Real de la Plataforma (Alineado al Código Actual)

### Capacidades Ya Implementadas (Fases 1–5 + Mejoras Evolutivas Completadas)
- **Arquitectura, Seguridad y PWA:** Backend modular en Node.js/Express + PostgreSQL (Supabase/local) y Frontend en React + Vite + Tailwind CSS con **PWA instalable** (`manifest.webmanifest`, ícono dedicado y Service Worker `sw.js` sin caché de `/api/*`).
- **Identidad Dual y Cuentas:** Una misma persona puede operar como residente y/o prestador (`can_use_resident`, `can_use_provider`, `primary_portal`), con recuperación y cambio de contraseña autenticado, hardening HTTP y rate limiting.
- **Compliance Estricto con Bloqueo Automático (Fase 1.1):** Bloqueo automático de emisión de pases y acceso en garita (`CRIMINAL_RECORD_EXPIRED`, `INSURANCE_EXPIRED`, `CREW_INSURANCE_EXPIRED`) con auditoría en `gate_access_logs`.
- **Membresía "Socio Verificado" (Fase 1.2):** Planes mensual/trimestral/Pro, insignia distintiva, orden prioritario en directorio, autogestión en Portal Prestador y control en Operaciones.
- **Portal Prestador Completo:** Credenciales versionadas, **visibilidad persistente por especialidad** en directorio (`is_visible_in_directory`), **Tablero "Mi Reputación"** con termómetro de 5 niveles, **tiempo promedio de respuesta**, **Ficha Comercial rápida + Urgencias 24h**, **respuestas a Q&A público** y próximo hito anti-leakage, flota vehicular, cuadrilla/ayudantes, agenda online, visitas, pases QR, **resumen de ingresos netos (93%)**, comprobantes imprimibles y reseñas cruzadas.
- **Portal Residente, Marketplace y Pagos (Fases 3–5.2):** **Buscador inteligente por síntomas/sinónimos** en Landing y Directorio, directorio enriquecido con **termómetro de reputación**, **tiempo de respuesta**, **ficha comercial rápida** (presupuesto/facturación/pagos), **Q&A público comunitario**, prueba social hiper-local (*"X servicios/ingresos verificados en tu barrio"*), filtros *Mis Favoritos*, *Disponible hoy*, *Urgencias 24h* y *Solo Socios Verificados*, botón **Volver a contratar** en 1 clic, **micro-tags tocables y filtros de reseñas**, sello UX **Hogar Protegido**, pasarela dual `mock | mercadopago` (Checkout Pro + webhook `x-signature`), **conformidad final** (digital o efectivo) con liberación escrow, **Comprobante del Hogar** imprimible (`TLK-REC-...`) y canal de **reclamos/garantía**.
- **Gobernanza Central (Superadmin) y Admin Local (Fase 2):** Auditoría de compliance y mediación de reclamos, licenciamiento B2B por comunidad con consumo mensual de QR, rotación de API Keys, suspensiones locales, alertas proactivas y **exportación CSV** (comunidades B2B, auditoría de garita, transacciones, vencimientos y suspensiones locales).

### Backlog Diferido (Dependencias Externas para Salida a Producción Comercial)
Ver lista viva en [PENDIENTES.md](./PENDIENTES.md) y detalle técnico en [ROADMAP_TECNICO.md](./ROADMAP_TECNICO.md):
1. Activación de credenciales reales de **Mercado Pago** en Railway (Sandbox → Producción) y cobro automatizado de suscripciones.
2. **Subida directa de archivos** (PDF/fotos de ART y antecedentes) vía **Supabase Storage** con enlaces firmados.
3. **Notificaciones transaccionales reales** por email (**Resend** / SMTP) para recuperación de contraseña y vencimientos.
