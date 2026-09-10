import { describe, it, expect } from 'vitest';
import { buildSectionsExportPayload, parseSectionsImport } from '../../src/lib/exportImportSections.js';
import type { SectionPlan } from '@shared-schema';

const plan: SectionPlan = {
  id: 'sp1',
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  routeId: 'r1',
  name: 'Piano',
  calcMode: 'speed',
  defaultSpeedKmh: 40,
  defaultPowerWatts: 250,
  windZones: [],
  plannedStartTime: null,
  smoothingWindowMeters: 50,
  breakpoints: [
    { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
    { id: 'mid', distKm: 10, fixed: false, sectionLabel: 'S1', speedKmh: 35, powerWatts: null },
    { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S2', speedKmh: 42, powerWatts: null }
  ]
};

describe('buildSectionsExportPayload', () => {
  it('usa le chiavi "speed"/"power" (formato del prototipo originale)', () => {
    const payload = buildSectionsExportPayload('Il mio giro', 20, plan);
    expect(payload.type).toBe('routesplitter-sections');
    expect(payload.points[1]).toMatchObject({ speed: 35, distKm: 10 });
    expect(payload.points[1]).not.toHaveProperty('speedKmh');
  });
});

describe('parseSectionsImport', () => {
  it('round-trip: export poi import ricostruisce gli stessi breakpoint (per valore)', () => {
    const payload = buildSectionsExportPayload('Il mio giro', 20, plan);
    const parsed = parseSectionsImport(JSON.stringify(payload), 20, 40);
    expect(parsed.breakpoints).toHaveLength(3);
    expect(parsed.breakpoints[0]!.fixed).toBe('start');
    expect(parsed.breakpoints[0]!.distKm).toBe(0);
    expect(parsed.breakpoints[2]!.fixed).toBe('finish');
    expect(parsed.breakpoints[2]!.distKm).toBe(20);
    expect(parsed.breakpoints[1]!.speedKmh).toBe(35);
    expect(parsed.calcMode).toBe('speed');
    expect(parsed.smoothingWindowMeters).toBe(50);
  });

  it('un file senza smoothingWindowMeters non tocca il valore esistente (torna null)', () => {
    const legacyPayload = {
      type: 'routesplitter-sections',
      points: [
        { distKm: 0, fixed: 'start', sectionLabel: null, speed: null, power: null },
        { distKm: 20, fixed: 'finish', sectionLabel: 'S1', speed: 40, power: null }
      ]
    };
    const parsed = parseSectionsImport(JSON.stringify(legacyPayload), 20, 40);
    expect(parsed.smoothingWindowMeters).toBeNull();
  });

  it('rifiuta uno smoothingWindowMeters fuori dal range 0-100, tornando null (un valore interno non multiplo di 10 viene invece arrotondato)', () => {
    const tooHigh = { ...buildSectionsExportPayload('Test', 20, plan), smoothingWindowMeters: 250 };
    expect(parseSectionsImport(JSON.stringify(tooHigh), 20, 40).smoothingWindowMeters).toBeNull();
    const negative = { ...buildSectionsExportPayload('Test', 20, plan), smoothingWindowMeters: -10 };
    expect(parseSectionsImport(JSON.stringify(negative), 20, 40).smoothingWindowMeters).toBeNull();
    const notMultipleOf10 = { ...buildSectionsExportPayload('Test', 20, plan), smoothingWindowMeters: 33 };
    expect(parseSectionsImport(JSON.stringify(notMultipleOf10), 20, 40).smoothingWindowMeters).toBe(30);
  });

  it('aggiunge start/finish mancanti invece di fallire', () => {
    const payload = {
      type: 'routesplitter-sections',
      points: [{ distKm: 5, fixed: false, sectionLabel: 'S1', speed: 30, power: null }]
    };
    expect(() => parseSectionsImport(JSON.stringify(payload), 20, 40)).toThrow(); // < 2 punti
  });

  it('clampa i punti fuori range sul percorso corrente', () => {
    const payload = buildSectionsExportPayload('Test', 20, plan);
    // importato su un percorso più corto (15 km invece di 20)
    const parsed = parseSectionsImport(JSON.stringify(payload), 15, 40);
    expect(parsed.breakpoints[parsed.breakpoints.length - 1]!.distKm).toBe(15);
    for (const bp of parsed.breakpoints) {
      expect(bp.distKm).toBeLessThanOrEqual(15);
    }
  });

  it('rifiuta un JSON malformato con un messaggio chiaro', () => {
    expect(() => parseSectionsImport('{ non valido', 20, 40)).toThrow(/JSON leggibile/);
  });

  it('rifiuta una struttura senza il campo points', () => {
    expect(() => parseSectionsImport('{"foo":"bar"}', 20, 40)).toThrow(/struttura sezioni/);
  });
});

describe('parseSectionsImport — zone vento', () => {
  const windPlan: SectionPlan = {
    ...plan,
    windZones: [
      { id: 'w1', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null , timeSamples: [] },
      { id: 'w2', distKm: 10, fixed: false, speedKmh: 15, directionDeg: 90 , timeSamples: [] },
      { id: 'w3', distKm: 20, fixed: 'finish', speedKmh: 25, directionDeg: 270 , timeSamples: [] }
    ]
  };

  it('round-trip: le zone vento sopravvivono a export+import', () => {
    const payload = buildSectionsExportPayload('Con vento', 20, windPlan);
    const parsed = parseSectionsImport(JSON.stringify(payload), 20, 40);
    expect(parsed.windZones).toHaveLength(3);
    expect(parsed.windZones![1]).toMatchObject({ speedKmh: 15, directionDeg: 90, distKm: 10 });
    expect(parsed.windZones![2]).toMatchObject({ speedKmh: 25, directionDeg: 270 });
  });

  it('un file senza windZones non tocca il vento esistente (torna null, non [])', () => {
    const legacyPayload = {
      type: 'routesplitter-sections',
      points: [
        { distKm: 0, fixed: 'start', sectionLabel: null, speed: null, power: null },
        { distKm: 20, fixed: 'finish', sectionLabel: 'S1', speed: 40, power: null }
      ]
    };
    const parsed = parseSectionsImport(JSON.stringify(legacyPayload), 20, 40);
    expect(parsed.windZones).toBeNull();
  });
});
