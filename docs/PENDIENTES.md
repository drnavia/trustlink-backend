# TrustLink — Pendientes Guardados (Backlog Diferido)

> Última actualización: 2026-11-24
> Estado base: **Fases 1–5.3 del Roadmap Técnico + 5 Mejoras Evolutivas + documentación completa de scripts + script SQL consolidado de Supabase completados y verificados.**

Estos ítems quedan registrados como **pendientes diferidos** (para retomar en la validación en la nube y al avanzar hacia el lanzamiento comercial / piloto con servicios externos):

---

## 1. Validación Operativa en la Nube (Smoke Test)
- [ ] Confirmar que los últimos commits en `main` (incluyendo **Fases 5 y 5.2**) estén redeployados correctamente en **Railway** (`trustlink-backend`) y **Vercel** (`trustlink-web`).
- [ ] *(Opcional si se desea dejar `schema_migrations` al día en una base Supabase ya existente)* Ejecutar `npm run migrate` contra Supabase según [DEPLOY_SUPABASE.md](./DEPLOY_SUPABASE.md) *(al arrancar Railway, `ensureEvolutionSchema()` ya asegura las columnas y tablas nuevas automáticamente)*.
- [ ] Recorrida E2E en vivo:
  - Landing actualizada, **buscador inteligente por síntomas** (*"pérdida de agua"*, *"salta la térmica"*) e instalación **PWA** desde celular (`manifest.webmanifest` + `sw.js`).
  - **Marketplace (Fases 5 y 5.2):** termómetro de reputación, *"servicios/ingresos en tu barrio"*, tiempo promedio de respuesta, filtros *Mis Favoritos*, *Disponible hoy*, *Urgencias 24h* y *Solo Socios Verificados*, sello *Hogar Protegido*, ficha comercial rápida, **Q&A público** (preguntar y responder), **Volver a contratar** en 1 clic, **micro-tags** y filtros en modal de reseñas.
  - **Portal Prestador:** Tablero *Mi Reputación*, editor de *Ficha Comercial / Urgencias 24h*, respuestas Q&A, visibilidad persistente de especialidades, resumen de ingresos netos (93%) y membresía **Socio Verificado**.
  - Bloqueo automático por documentación vencida (ART / antecedentes / cuadrilla) en garita.
  - **Licencia B2B** por comunidad (`Admin Barrio` y `Salud & APIs`) y exportaciones **CSV**.
  - **Conformidad final** (digital/efectivo), **Comprobante del Hogar** imprimible y **reclamos/garantía** en Ops.

---

## 2. Integraciones Externas Diferidas (Lanzamiento Comercial)
- [ ] **Mercado Pago Real en Railway (Sandbox → Producción):**
  - Configurar `PAYMENT_GATEWAY_MODE=mercadopago`, `MP_ACCESS_TOKEN`, `PAYMENT_WEBHOOK_SECRET`, `MP_PUBLIC_APP_URL` y `MP_WEBHOOK_URL`.
  - Probar un cobro real en Sandbox (`TEST-...`) y recepción de webhook firmado (`x-signature`).
  - *(Etapa posterior)* Cobro recurrente automatizado de Membresías **Socio Verificado** y **OAuth Marketplace Split** (liquidación directa 93% prestador / 7% TrustLink).
- [ ] **Subida Real de Documentos y Fotos (Supabase Storage):**
  - Reemplazar la carga de URLs manuales de DNI, Antecedentes Penales, Póliza ART, seguros vehiculares y cuadrilla por subida directa de PDF/fotos desde celular con enlaces firmados en **Supabase Storage**.
  - **Galería de trabajos ("Antes y después")** en la ficha pública del prestador *(único pendiente de la inspiración Marketplace/Mercado Libre)*.
- [ ] **Notificaciones Transaccionales Automáticas (Resend / SMTP):**
  - Envío automático por email para recuperación de contraseña, alertas proactivas de vencimiento documental (30 / 15 / 7 días) y avisos de visitas, preguntas públicas (Q&A) y reclamos.
