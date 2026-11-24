# TrustLink — Pendientes Guardados (Backlog Diferido)

> Última actualización: 2026-11-24
> Estado base: **Fases 1–4 del Roadmap Técnico + 5 Mejoras Evolutivas + 3 ajustes finales (CSV/Efectivo/PWA) completados y verificados.**

Estos ítems quedan registrados como **pendientes diferidos** (no se implementan por ahora, para retomar cuando se avance hacia el lanzamiento comercial / piloto con servicios externos):

---

## 1. Validación Operativa en la Nube (Smoke Test)
- [ ] Confirmar que los últimos commits en `main` estén redeployados correctamente en **Railway** (`trustlink-backend`) y **Vercel** (`trustlink-web`).
- [ ] Recorrida E2E en vivo:
  - Landing actualizada y buscador rápido.
  - Instalación **PWA** desde celular (`manifest.webmanifest` + `sw.js`).
  - Visibilidad persistente de especialidades y resumen de ingresos del prestador.
  - Membresía **Socio Verificado** (insignia, orden prioritario, filtro en directorio y control Superadmin).
  - Bloqueo automático por documentación vencida (ART / antecedentes / cuadrilla) en garita.
  - **Licencia B2B** por comunidad (`Admin Barrio` y `Salud & APIs`) y exportaciones **CSV**.
  - **Conformidad final** (digital/efectivo), **Comprobante del Hogar** imprimible y **reclamos/garantía** en Ops.

---

## 2. Integraciones Externas Diferidas (Lanzamiento Comercial)
- [ ] **Mercado Pago Real en Railway (Sandbox → Producción):**
  - Configurar `PAYMENT_GATEWAY_MODE=mercadopago`, `MP_ACCESS_TOKEN`, `PAYMENT_WEBHOOK_SECRET`, `MP_PUBLIC_APP_URL` y `MP_WEBHOOK_URL`.
  - Probar un cobro real en Sandbox (`TEST-...`) y recepción de webhook firmado (`x-signature`).
  - *(Etapa posterior)* Cobro recurrente automatizado de Membresías **Socio Verificado** y **OAuth Marketplace Split** (liquidación directa 93% prestador / 7% TrustLink).
- [ ] **Subida Real de Documentos (Supabase Storage):**
  - Reemplazar la carga de URLs manuales de DNI, Antecedentes Penales, Póliza ART, seguros vehiculares y cuadrilla por subida directa de PDF/fotos desde celular con enlaces firmados en **Supabase Storage**.
- [ ] **Notificaciones Transaccionales Automáticas (Resend / SMTP):**
  - Envío automático por email para recuperación de contraseña, alertas proactivas de vencimiento documental (30 / 15 / 7 días) y avisos de visitas/reclamos.
