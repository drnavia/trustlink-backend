/**
 * @file scheduleAvailability.test.js
 * @description Pruebas unitarias del motor de disponibilidad y calendario vivo cada 30 min
 * (`src/utils/scheduleAvailability.js`, Fase 5.4): valida normalización de jornada semanal,
 * generación de franjas cada 30/60 min en zona horaria Argentina (UTC-3), cruce con trabajos
 * externos y pases TrustLink, y privacidad de la proyección pública para residentes.
 * @location /trustlink-backend/test/scheduleAvailability.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WEEKLY_RULES,
  normalizeWeeklyRulesInput,
  mergeWithDefaultRules,
  buildScheduleSummaryText,
  buildDaySlots,
  buildMultiDayAvailability,
} = require('../src/utils/scheduleAvailability');

describe('scheduleAvailability helper (Fase 5.4)', () => {
  // Caso 1: Normalización y validación de reglas semanales
  it('valida días y rangos horarios rechazando fin <= inicio en días laborables', () => {
    const invalid = normalizeWeeklyRulesInput([
      { day_of_week: 1, is_working: true, start_time: '18:00', end_time: '08:00', slot_minutes: 30 },
    ]);
    assert.ok(invalid.error, 'Debe rechazar rango horario invertido');

    const valid = normalizeWeeklyRulesInput([
      { day_of_week: 1, is_working: true, start_time: '09:00', end_time: '17:00', slot_minutes: 30 },
      { day_of_week: 6, is_working: false, start_time: '09:00', end_time: '13:00', slot_minutes: 30 },
    ]);
    assert.equal(valid.error, null);
    assert.equal(valid.rules.length, 7);
    const mon = valid.rules.find((r) => r.day_of_week === 1);
    const sat = valid.rules.find((r) => r.day_of_week === 6);
    assert.equal(mon.start_time, '09:00');
    assert.equal(mon.end_time, '17:00');
    assert.equal(sat.is_working, false);
  });

  // Caso 2: Generación de franjas cada 30 min en UTC-3 con cruce de trabajo externo y privacidad residente
  it('genera franjas de 30 min en UTC-3, marca bloques ocupados y oculta títulos privados al residente', () => {
    // 2026-11-25 es Miércoles (day_of_week = 3). En DEFAULT_WEEKLY_RULES trabaja 08:00..18:00 (20 franjas de 30 min)
    // Bloque externo de 10:00 a 11:00 hora Argentina (UTC-3) = 13:00Z a 14:00Z
    const blocks = [
      {
        id: 77,
        block_type: 'external_visit',
        title: 'Obra privada Sr. Gómez',
        start_at: '2026-11-25T13:00:00Z',
        end_at: '2026-11-25T14:00:00Z',
        source_ref: null,
      },
    ];
    const nowMs = Date.parse('2026-11-25T11:30:00Z'); // 08:30 Argentina

    const providerView = buildDaySlots({
      dateStr: '2026-11-25',
      rules: DEFAULT_WEEKLY_RULES,
      blocks,
      tzOffsetMinutes: 180,
      nowMs,
      includeBlockDetails: true,
    });

    assert.equal(providerView.is_working, true);
    assert.equal(providerView.slots.length, 20);
    assert.equal(providerView.slots[0].time, '08:00');
    assert.equal(providerView.slots[0].status, 'past'); // 08:00..08:30 ya terminó a las 08:30
    assert.equal(providerView.slots[1].time, '08:30');
    assert.equal(providerView.slots[1].status, 'available');

    const slot1000 = providerView.slots.find((s) => s.time === '10:00');
    const slot1030 = providerView.slots.find((s) => s.time === '10:30');
    const slot1100 = providerView.slots.find((s) => s.time === '11:00');
    assert.equal(slot1000.status, 'busy');
    assert.equal(slot1030.status, 'busy');
    assert.equal(slot1000.block.title, 'Obra privada Sr. Gómez');
    assert.equal(slot1100.status, 'available');

    // Vista pública para residente: misma disponibilidad pero SIN `block` ni títulos privados
    const residentView = buildDaySlots({
      dateStr: '2026-11-25',
      rules: DEFAULT_WEEKLY_RULES,
      blocks,
      tzOffsetMinutes: 180,
      nowMs,
      includeBlockDetails: false,
    });
    const resSlot1000 = residentView.slots.find((s) => s.time === '10:00');
    assert.equal(resSlot1000.status, 'busy');
    assert.equal(resSlot1000.block, undefined);
  });

  // Caso 3: Proyección multi-día (7 días) respeta días no laborables y genera resumen legible
  it('proyecta 7 días respetando días no laborables y genera resumen semanal legible', () => {
    const rules = mergeWithDefaultRules([]);
    const summary = buildScheduleSummaryText(rules);
    assert.ok(summary.includes('Lun'));
    assert.ok(summary.includes('08:00–18:00'));

    const multi = buildMultiDayAvailability({
      startDateStr: '2026-11-25',
      days: 7,
      rules,
      blocks: [],
      tzOffsetMinutes: 180,
      nowMs: Date.parse('2026-11-25T10:00:00Z'),
    });
    assert.equal(multi.days.length, 7);
    const sunday = multi.days.find((d) => d.day_of_week === 0);
    assert.ok(sunday);
    assert.equal(sunday.is_working, false);
    assert.equal(sunday.slots.length, 0);
  });
});
