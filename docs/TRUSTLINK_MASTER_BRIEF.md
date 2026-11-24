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
| **1. Membresía "Socio Verificado"** | Prestadores (B2C) | Abono mensual recurrente | Verificación activa, insignia distintiva, visibilidad prioritaria en directorio, pases QR y reputación acumulable (incluso si parte de los trabajos se cobran en efectivo). | *Pendiente (Roadmap Fase 1)* |
| **2. Licenciamiento B2B a Comunidades** | Barrios / Countries (B2B) | Abono mensual SaaS | Acceso a Consola Garita, API Universal (`x-api-key` por comunidad), auditoría de accesos y alertas de vencimiento sin auditar antecedentes por cuenta propia. | *Infraestructura base lista; falta capa comercial/planes (Roadmap Fase 2)* |
| **3. Comisión por Transacción (Take Rate)** | Transacciones In-App | 6%–8% (referencia actual: **7%**) | Desglose transparente (7% plataforma / 93% prestador) para operaciones procesadas en plataforma con trazabilidad financiera. | *Cálculo 7%/93% y webhook HMAC listos; pasarela real pendiente (Roadmap Fase 3)* |

---

## 5. Estado Real de la Plataforma (Alineado al Código Actual)

### Capacidades Ya Implementadas
- **Arquitectura y Despliegue:** Backend modular en Node.js/Express + PostgreSQL (Supabase/local) y Frontend en React + Vite + Tailwind CSS.
- **Identidad Dual y Cuentas:** Una misma persona puede operar como residente y/o prestador (`can_use_resident`, `can_use_provider`, `primary_portal`), con recuperación y cambio de contraseña autenticado, hardening HTTP y rate limiting.
- **Portal Prestador Completo:**
  - Gestión de credenciales/especialidades con historial de versiones documentales (`provider_document_versions`) sin sobrescribir registros previos.
  - Flota vehicular con póliza y vigencia.
  - CRUD de ayudantes/cuadrilla (`provider_employees`) con DNI y seguro, adjuntables al pase QR.
  - Agenda online con bloqueos horarios, coordinación de visitas con mensajería interna y vista de Pases QR asignados.
- **Portal Residente:** Buscador rápido y chips de rubros, directorio de prestadores verificados con flota, solicitudes de visita, emisión/edición/cancelación de pases QR con selección de cuadrilla, atajos de WhatsApp y panel de contratos/pagos/reseñas.
- **Gobernanza Central (Superadmin / Master Mode) y Admin Local:**
  - Auditoría centralizada de compliance (`providers`) con pendientes priorizados.
  - Gestión de comunidades (`countries`), generación/rotación/revocación de API Keys por comunidad (`country_integrations`) y auditoría de accesos (`gate_access_logs`).
  - Suspensiones operativas locales por comunidad (`provider_local_suspensions`) y alertas proactivas de vencimientos (`/api/v1/providers/expiry-alerts`).
  - Consola Garita con escáner QR en vivo y validación perimetral con consumo atómico de ingreso único.
  - Marca blanca configurable por zonas (`branding`).

### Próximos Hitos Estratégicos
Ver el desglose técnico detallado en [ROADMAP_TECNICO.md](./ROADMAP_TECNICO.md):
1. **Membresía "Socio Verificado"** para prestadores (planes, vigencia, insignia y prioridad en directorio).
2. **Licenciamiento B2B** por comunidad (planes, estado comercial y enforcement en API externa).
3. **Integración real de Mercado Pago** (Checkout Pro / Marketplace Split sobre el webhook HMAC ya existente).
4. **Bloqueo automático por vencimiento documental** en validación QR y **flujo de conformidad/reclamos post-servicio**.
