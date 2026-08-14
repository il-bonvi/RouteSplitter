import { describe, it, expect } from 'vitest';
import { computeSections, type SectionBreakpoint } from '../../src/physics-core/sections.js';
import { processRoute } from '../../src/physics-core/geo.js';
import type { PhysicsParams } from '../../src/physics-core/types.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

function flatRoute(distanceKm: number, n = 50) {
  const raw = Array.from({ length: n }, (_, i) => ({
    lat: 45.0 + (i / (n - 1)) * (distanceKm / 111),
    lon: 11.0,
    ele: 100
  }));
  return processRoute(raw).points;
}

describe('computeSections', () => {
  it('con un solo tratto (start->finish), la distanza totale coincide col percorso', () => {
    const points = flatRoute(20);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S1', speedKmh: 35, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'speed');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.distanceKm).toBeCloseTo(20, 1);
    expect(sections[0]!.cumDistKm).toBeCloseTo(20, 1);
  });

  it('in modalità power, converte la potenza impostata in una velocità coerente col modello fisico', () => {
    const points = flatRoute(10);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 10, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: 250 }
    ];
    const sections = computeSections(breakpoints, points, params, 'power');
    expect(sections[0]!.powerWatts).toBe(250);
    expect(sections[0]!.speedKmh).toBeGreaterThan(0);
    expect(sections[0]!.timeHours).toBeCloseTo(10 / sections[0]!.speedKmh, 5);
  });

  it('con più sezioni, i cumulativi si accumulano correttamente', () => {
    const points = flatRoute(30);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'bp1', distKm: 10, fixed: false, sectionLabel: 'S1', speedKmh: 30, powerWatts: null },
      { id: 'bp2', distKm: 20, fixed: false, sectionLabel: 'S2', speedKmh: 40, powerWatts: null },
      { id: 'finish', distKm: 30, fixed: 'finish', sectionLabel: 'S3', speedKmh: 35, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'speed');
    expect(sections).toHaveLength(3);
    expect(sections[2]!.cumDistKm).toBeCloseTo(30, 1);
    // il tempo cumulato dell'ultima sezione deve essere la somma dei tempi delle 3
    const sumTime = sections.reduce((a, s) => a + s.timeHours, 0);
    expect(sections[2]!.cumTimeHours).toBeCloseTo(sumTime, 6);
  });

  it('usa defaultPowerWatts quando una sezione non ha potenza impostata', () => {
    const points = flatRoute(5);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 5, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'power', 300);
    expect(sections[0]!.powerWatts).toBe(300);
  });
});
