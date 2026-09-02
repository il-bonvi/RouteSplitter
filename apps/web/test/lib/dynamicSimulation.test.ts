import { describe, it, expect } from 'vitest';
import { buildDynamicSegmentsFromSections, computeDynamicVsClassicComparison } from '../../src/lib/dynamicSimulation.js';
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

function flatRoute(km: number) {
  const n = Math.max(50, Math.round((km * 1000) / 10));
  return processRoute(Array.from({ length: n }, (_, i) => ({ lat: 45.0 + (i / (n - 1)) * (km / 111), lon: 11.0, ele: 100 }))).points;
}

describe('buildDynamicSegmentsFromSections', () => {
  it('un segmento per sezione, con i confini di distanza e la potenza della sezione', () => {
    const points = flatRoute(10);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'a', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'b', distKm: 5, fixed: false, sectionLabel: null, speedKmh: null, powerWatts: 220 },
      { id: 'c', distKm: 10, fixed: 'finish', sectionLabel: null, speedKmh: null, powerWatts: 280 }
    ];
    const sections = computeSections(breakpoints, points, params, 'power', 250);
    const segments = buildDynamicSegmentsFromSections(sections);
    expect(segments).toEqual([
      { d0Km: 0, d1Km: 5, targetPowerW: 220 },
      { d0Km: 5, d1Km: 10, targetPowerW: 280 }
    ]);
  });
});

describe('computeDynamicVsClassicComparison', () => {
  it('su un percorso lungo e piatto il tempo dinamico è molto vicino al classico (poca inerzia da smaltire su una distanza lunga)', () => {
    const points = flatRoute(30);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'a', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'b', distKm: 30, fixed: 'finish', sectionLabel: null, speedKmh: null, powerWatts: 250 }
    ];
    const { classicTotalHours, dynamicTotalHours } = computeDynamicVsClassicComparison(breakpoints, points, params, 'power', 250);
    expect(classicTotalHours).toBeGreaterThan(0);
    // Il dinamico deve essere SEMPRE >= al classico (si parte da fermo: il transitorio
    // iniziale costa sempre un po' di tempo in più, mai di meno, a parità di potenza target).
    expect(dynamicTotalHours).toBeGreaterThanOrEqual(classicTotalHours);
    // Ma su 30km la differenza (pochi secondi di transitorio iniziale) deve essere una
    // frazione minima del totale (>1h): non più dell'1%.
    expect((dynamicTotalHours - classicTotalHours) / classicTotalHours).toBeLessThan(0.01);
  });

  it('su un percorso breve la differenza (peso del transitorio iniziale) è relativamente più marcata', () => {
    const points = flatRoute(1);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'a', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'b', distKm: 1, fixed: 'finish', sectionLabel: null, speedKmh: null, powerWatts: 250 }
    ];
    const { classicTotalHours, dynamicTotalHours } = computeDynamicVsClassicComparison(breakpoints, points, params, 'power', 250);
    const pctExtra = (dynamicTotalHours - classicTotalHours) / classicTotalHours;
    // Su 1km la partenza da fermo pesa in proporzione molto di più che su 30km.
    expect(pctExtra).toBeGreaterThan(0.005);
  });
});
