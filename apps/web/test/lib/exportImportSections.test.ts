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
