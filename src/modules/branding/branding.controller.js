/**
 * @file branding.controller.js
 * @description Controlador modular para gestionar la apariencia global de TrustLink:
 * fondos (plataforma, menú, sub-menú, tarjetas Zona 4 y cajas internas Zona 5),
 * tipografías (plataforma, menú, sub-menú), logo opcional (SVG, PNG, JPG) y modo oscuro/claro,
 * con persistencia en PostgreSQL.
 * @location /trustlink-backend/src/modules/branding/branding.controller.js
 */

const db = require('../../config/db');

// Configuración inicial por defecto de TrustLink (estética oscura y sobria)
const DEFAULT_BRANDING = {
  platform_bg_color: '#0F172A',
  menu_bg_color: '#020617',
  submenu_bg_color: '#090D16',
  card_bg_color: '#020617',
  inner_bg_color: '#0F172A',
  platform_text_color: '#F1F5F9',
  menu_text_color: '#E2E8F0',
  submenu_text_color: '#CBD5E1',
  logo_url: null,
  dark_mode: true,
};

// Validador estricto para colores hexadecimales #RRGGBB
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

// Tamaño máximo aproximado para logo embebido en base64
const MAX_LOGO_DATA_URL_LENGTH = 1500000;

/**
 * Normaliza y valida un color hexadecimal en formato #RRGGBB.
 * @param {unknown} value
 * @returns {string|null}
 */
const normalizeHexColor = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_REGEX.test(trimmed)) return null;
  return trimmed.toUpperCase();
};

/**
 * Normaliza un booleano de forma segura.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
const normalizeBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * Valida y normaliza logo_url (SVG, PNG, JPG o URL/ruta segura, o null para usar emblema por defecto).
 * @param {unknown} value
 * @returns {{ valid: boolean, value: string|null, error?: string }}
 */
const normalizeLogoUrl = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { valid: true, value: null };
  }

  if (typeof value !== 'string') {
    return { valid: false, value: null, error: 'El formato del logo no es válido.' };
  }

  const trimmed = value.trim();

  if (trimmed.length > MAX_LOGO_DATA_URL_LENGTH) {
    return {
      valid: false,
      value: null,
      error: 'La imagen del logo supera el tamaño máximo permitido.',
    };
  }

  const allowedDataPrefixRegex =
    /^data:image\/(png|jpeg|jpg|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;
  if (trimmed.startsWith('data:image/')) {
    if (!allowedDataPrefixRegex.test(trimmed)) {
      return {
        valid: false,
        value: null,
        error: 'Solo se admiten imágenes SVG, PNG o JPG válidas para el logo.',
      };
    }
    return { valid: true, value: trimmed };
  }

  const allowedUrlRegex =
    /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\.(svg|png|jpe?g)(\?[^\s"'<>]*)?$/i;
  if (allowedUrlRegex.test(trimmed)) {
    return { valid: true, value: trimmed };
  }

  return {
    valid: false,
    value: null,
    error: 'El logo debe ser una imagen SVG, PNG o JPG válida.',
  };
};

/**
 * Asegura la existencia de la tabla platform_branding y sus columnas de forma idempotente.
 */
const ensureBrandingSchema = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS platform_branding (
      id SERIAL PRIMARY KEY,
      platform_bg_color VARCHAR(7) NOT NULL DEFAULT '#0F172A',
      menu_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
      submenu_bg_color VARCHAR(7) NOT NULL DEFAULT '#090D16',
      card_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
      inner_bg_color VARCHAR(7) NOT NULL DEFAULT '#0F172A',
      platform_text_color VARCHAR(7) NOT NULL DEFAULT '#F1F5F9',
      menu_text_color VARCHAR(7) NOT NULL DEFAULT '#E2E8F0',
      submenu_text_color VARCHAR(7) NOT NULL DEFAULT '#CBD5E1',
      logo_url TEXT DEFAULT NULL,
      dark_mode BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE platform_branding
      ADD COLUMN IF NOT EXISTS platform_bg_color VARCHAR(7) NOT NULL DEFAULT '#0F172A',
      ADD COLUMN IF NOT EXISTS menu_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
      ADD COLUMN IF NOT EXISTS submenu_bg_color VARCHAR(7) NOT NULL DEFAULT '#090D16',
      ADD COLUMN IF NOT EXISTS card_bg_color VARCHAR(7) NOT NULL DEFAULT '#020617',
      ADD COLUMN IF NOT EXISTS inner_bg_color VARCHAR(7) NOT NULL DEFAULT '#0F172A',
      ADD COLUMN IF NOT EXISTS platform_text_color VARCHAR(7) NOT NULL DEFAULT '#F1F5F9',
      ADD COLUMN IF NOT EXISTS menu_text_color VARCHAR(7) NOT NULL DEFAULT '#E2E8F0',
      ADD COLUMN IF NOT EXISTS submenu_text_color VARCHAR(7) NOT NULL DEFAULT '#CBD5E1',
      ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS dark_mode BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW();
  `);

  const existing = await db.query(
    'SELECT id FROM platform_branding ORDER BY id ASC LIMIT 1'
  );

  if (existing.rows.length === 0) {
    await db.query(
      `INSERT INTO platform_branding (
        platform_bg_color,
        menu_bg_color,
        submenu_bg_color,
        card_bg_color,
        inner_bg_color,
        platform_text_color,
        menu_text_color,
        submenu_text_color,
        logo_url,
        dark_mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        DEFAULT_BRANDING.platform_bg_color,
        DEFAULT_BRANDING.menu_bg_color,
        DEFAULT_BRANDING.submenu_bg_color,
        DEFAULT_BRANDING.card_bg_color,
        DEFAULT_BRANDING.inner_bg_color,
        DEFAULT_BRANDING.platform_text_color,
        DEFAULT_BRANDING.menu_text_color,
        DEFAULT_BRANDING.submenu_text_color,
        DEFAULT_BRANDING.logo_url,
        DEFAULT_BRANDING.dark_mode,
      ]
    );
  }
};

/**
 * Formatea una fila de base de datos al objeto estándar de respuesta.
 * @param {Record<string, any>} row
 */
const formatBrandingRow = (row) => ({
  platform_bg_color: row.platform_bg_color || DEFAULT_BRANDING.platform_bg_color,
  menu_bg_color: row.menu_bg_color || DEFAULT_BRANDING.menu_bg_color,
  submenu_bg_color: row.submenu_bg_color || DEFAULT_BRANDING.submenu_bg_color,
  card_bg_color: row.card_bg_color || DEFAULT_BRANDING.card_bg_color,
  inner_bg_color: row.inner_bg_color || DEFAULT_BRANDING.inner_bg_color,
  platform_text_color: row.platform_text_color || DEFAULT_BRANDING.platform_text_color,
  menu_text_color: row.menu_text_color || DEFAULT_BRANDING.menu_text_color,
  submenu_text_color: row.submenu_text_color || DEFAULT_BRANDING.submenu_text_color,
  logo_url: row.logo_url || null,
  dark_mode: typeof row.dark_mode === 'boolean' ? row.dark_mode : DEFAULT_BRANDING.dark_mode,
  updated_at: row.updated_at || null,
});

/**
 * GET /api/v1/branding
 */
const getBranding = async (req, res) => {
  try {
    await ensureBrandingSchema();

    const result = await db.query(
      `SELECT
         id,
         platform_bg_color,
         menu_bg_color,
         submenu_bg_color,
         card_bg_color,
         inner_bg_color,
         platform_text_color,
         menu_text_color,
         submenu_text_color,
         logo_url,
         dark_mode,
         updated_at
       FROM platform_branding
       ORDER BY id ASC
       LIMIT 1`
    );

    const row = result.rows[0] || DEFAULT_BRANDING;

    return res.status(200).json({
      branding: formatBrandingRow(row),
      defaults: DEFAULT_BRANDING,
    });
  } catch (error) {
    console.error('[branding.controller] Error en getBranding:', error);
    return res.status(500).json({
      error: 'Error interno al obtener la configuración de apariencia de TrustLink.',
    });
  }
};

/**
 * PUT /api/v1/branding (exclusivo superadmin)
 */
const updateBranding = async (req, res) => {
  try {
    await ensureBrandingSchema();

    const currentResult = await db.query(
      `SELECT
         id,
         platform_bg_color,
         menu_bg_color,
         submenu_bg_color,
         card_bg_color,
         inner_bg_color,
         platform_text_color,
         menu_text_color,
         submenu_text_color,
         logo_url,
         dark_mode
       FROM platform_branding
       ORDER BY id ASC
       LIMIT 1`
    );

    const current = formatBrandingRow(currentResult.rows[0] || DEFAULT_BRANDING);
    const currentId = currentResult.rows[0]?.id;

    const pick = (snakeKey, camelKey, fallbackValue) => {
      if (req.body[snakeKey] !== undefined) return req.body[snakeKey];
      if (req.body[camelKey] !== undefined) return req.body[camelKey];
      return fallbackValue;
    };

    const platformBgColor = normalizeHexColor(
      pick('platform_bg_color', 'platformBgColor', current.platform_bg_color)
    );
    const menuBgColor = normalizeHexColor(
      pick('menu_bg_color', 'menuBgColor', current.menu_bg_color)
    );
    const submenuBgColor = normalizeHexColor(
      pick('submenu_bg_color', 'submenuBgColor', current.submenu_bg_color)
    );
    const cardBgColor = normalizeHexColor(
      pick('card_bg_color', 'cardBgColor', current.card_bg_color)
    );
    const innerBgColor = normalizeHexColor(
      pick('inner_bg_color', 'innerBgColor', current.inner_bg_color)
    );
    const platformTextColor = normalizeHexColor(
      pick('platform_text_color', 'platformTextColor', current.platform_text_color)
    );
    const menuTextColor = normalizeHexColor(
      pick('menu_text_color', 'menuTextColor', current.menu_text_color)
    );
    const submenuTextColor = normalizeHexColor(
      pick('submenu_text_color', 'submenuTextColor', current.submenu_text_color)
    );

    if (
      !platformBgColor ||
      !menuBgColor ||
      !submenuBgColor ||
      !cardBgColor ||
      !innerBgColor ||
      !platformTextColor ||
      !menuTextColor ||
      !submenuTextColor
    ) {
      return res.status(400).json({
        error:
          'Todos los colores de fondo y tipografía deben tener formato hexadecimal válido de 6 dígitos (#RRGGBB).',
      });
    }

    const rawLogo = pick('logo_url', 'logoUrl', current.logo_url);
    const logoCheck = normalizeLogoUrl(rawLogo);
    if (!logoCheck.valid) {
      return res.status(400).json({
        error: logoCheck.error || 'Logo inválido.',
      });
    }

    const rawDarkMode = pick('dark_mode', 'darkMode', current.dark_mode);
    const darkMode = normalizeBoolean(rawDarkMode, current.dark_mode);

    const updatedResult = await db.query(
      `UPDATE platform_branding
       SET platform_bg_color = $1,
           menu_bg_color = $2,
           submenu_bg_color = $3,
           card_bg_color = $4,
           inner_bg_color = $5,
           platform_text_color = $6,
           menu_text_color = $7,
           submenu_text_color = $8,
           logo_url = $9,
           dark_mode = $10,
           updated_at = NOW()
       WHERE id = $11
       RETURNING
         id,
         platform_bg_color,
         menu_bg_color,
         submenu_bg_color,
         card_bg_color,
         inner_bg_color,
         platform_text_color,
         menu_text_color,
         submenu_text_color,
         logo_url,
         dark_mode,
         updated_at`,
      [
        platformBgColor,
        menuBgColor,
        submenuBgColor,
        cardBgColor,
        innerBgColor,
        platformTextColor,
        menuTextColor,
        submenuTextColor,
        logoCheck.value,
        darkMode,
        currentId,
      ]
    );

    const updated = updatedResult.rows[0];

    return res.status(200).json({
      message: 'Configuración de apariencia de TrustLink guardada correctamente.',
      branding: formatBrandingRow(updated),
      defaults: DEFAULT_BRANDING,
    });
  } catch (error) {
    console.error('[branding.controller] Error en updateBranding:', error);
    return res.status(500).json({
      error: 'Error interno al guardar la configuración de apariencia de TrustLink.',
    });
  }
};

module.exports = {
  getBranding,
  updateBranding,
  DEFAULT_BRANDING,
};