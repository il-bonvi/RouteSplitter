import { describe, it, expect } from 'vitest';
import { sectionsToCsv } from '../../src/lib/exportCsv.js';
import { computeSections, processRoute, type SectionBreakpoint, type PhysicsParams } from '@physics-core';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

describe('sectionsToCsv', () => {
  it('produce una riga di header + una riga per sezione', () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({ lat: 45.0 + i * 0.001, lon: 11.0, ele: 100 }));
    const points = processRoute(raw).points;
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'mid', distKm: 1, fixed: false, sectionLabel: 'S1', speedKmh: 35, powerWatts: null },
      { id: 'finish', distKm: 2, fixed: 'finish', sectionLabel: 'S2', speedKmh: 40, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'speed');
    const csv = sectionsToCsv(sections);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1 + sections.length);
    expect(lines[0]).toContain('Distanza (km)');
  });

  it('mette tra virgolette i nomi sezione con la virgola', () => {
    const raw = Array.from({ length: 5 }, (_, i) => ({ lat: 45.0 + i * 0.001, lon: 11.0, ele: 100 }));
    const points = processRoute(raw).points;
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 0.4, fixed: 'finish', sectionLabel: 'Salita, tratto duro', speedKmh: 20, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'speed');
    const csv = sectionsToCsv(sections);
    expect(csv).toContain('"Salita, tratto duro"');
  });
});
