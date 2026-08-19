import { describe, it, expect } from 'vitest';
import { breakpointsToSegments, buildFineGrid, mapFinePowersToBreakpoints } from '../../src/lib/pacingActions.js';
import { processRoute, type SectionBreakpoint, type WindZoneBoundary } from '@physics-core';

function flatClimb(distanceKm: number, totalGain: number, n = 100) {
  const raw = Array.from({ length: n }, (_, i) => ({
    lat: 45.0 + (i / (n - 1)) * (distanceKm / 111),
    lon: 11.0,
    ele: 100 + (i / (n - 1)) * totalGain
  }));
  return processRoute(raw).points;
}

describe('breakpointsToSegments', () => {
  it('produce un segmento in meno rispetto al numero di breakpoint', () => {
    const points = flatClimb(20, 200);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'mid', distKm: 10, fixed: false, sectionLabel: 'S1', speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S2', speedKmh: null, powerWatts: null }
    ];
    const segs = breakpointsToSegments(breakpoints, points);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.distanceKm).toBeCloseTo(10, 1);
  });

  it('senza windZones, windKmh resta undefined su ogni segmento (nessun cambio di comportamento storico)', () => {
    const points = flatClimb(20, 200);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: null }
    ];
    const segs = breakpointsToSegments(breakpoints, points);
    expect(segs[0]!.windKmh).toBeUndefined();
  });

  it('con windZones, calcola il vento efficace al punto medio di ogni segmento (percorso rettilineo verso nord)', () => {
    const points = flatClimb(20, 0); // rotta sempre verso nord (lat crescente, lon fissa)
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'mid', distKm: 10, fixed: false, sectionLabel: 'S1', speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S2', speedKmh: null, powerWatts: null }
    ];
    // Vento costante 20 km/h da nord (direction 0°) su tutto il percorso -> in testa puro
    // marciando verso nord (bearing ~0°): effettivo = +20.
    const windZones: WindZoneBoundary[] = [
      { id: 'w-start', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
      { id: 'w-finish', distKm: 20, fixed: 'finish', speedKmh: 20, directionDeg: 0 }
    ];
    const segs = breakpointsToSegments(breakpoints, points, windZones);
    expect(segs[0]!.windKmh).toBeCloseTo(20, 0);
    expect(segs[1]!.windKmh).toBeCloseTo(20, 0);
  });
});

describe('buildFineGrid', () => {
  it("copre l'intera distanza senza buchi né sovrapposizioni", () => {
    const points = flatClimb(10, 100);
    const grid = buildFineGrid(10, 0.25, points);
    const totalDist = grid.reduce((a, s) => a + s.distanceKm, 0);
    expect(totalDist).toBeCloseTo(10, 6);
    expect(grid[0]!.d0Km).toBe(0);
    expect(grid[grid.length - 1]!.d1Km).toBeCloseTo(10, 6);
  });

  it('con windZones, ogni segmento fine porta il proprio windKmh coerente con la zona attiva', () => {
    const points = flatClimb(10, 0);
    // Prima metà vento in coda (-15), seconda metà in testa (+15): due zone, cambio a 5km.
    const windZones: WindZoneBoundary[] = [
      { id: 'w-start', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
      { id: 'w-mid', distKm: 5, fixed: false, speedKmh: 15, directionDeg: 180 }, // in coda marciando verso nord
      { id: 'w-finish', distKm: 10, fixed: 'finish', speedKmh: 15, directionDeg: 0 } // in testa
    ];
    const grid = buildFineGrid(10, 1, points, windZones);
    const early = grid.find(s => s.d1Km <= 5)!;
    const late = grid.find(s => s.d0Km >= 5)!;
    expect(early.windKmh!).toBeLessThan(0); // coda
    expect(late.windKmh!).toBeGreaterThan(0); // testa
  });
});

describe('mapFinePowersToBreakpoints', () => {
  it('assegna la stessa potenza a una sezione se la griglia fine è costante in quel tratto', () => {
    const points = flatClimb(10, 0);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 10, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: null }
    ];
    const fineSegs = buildFineGrid(10, 1, points);
    const finePowers = fineSegs.map(() => 250);
    const result = mapFinePowersToBreakpoints(breakpoints, fineSegs, finePowers);
    expect(result.get('finish')).toBe(250);
  });

  it('fa una media pesata sulla distanza quando la griglia fine ha potenze diverse nel tratto', () => {
    const points = flatClimb(10, 0);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 10, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: null }
    ];
    const fineSegs = buildFineGrid(10, 5, points); // 2 segmenti da 5km
    const finePowers = [200, 300];
    const result = mapFinePowersToBreakpoints(breakpoints, fineSegs, finePowers);
    expect(result.get('finish')).toBe(250); // media semplice, pesi uguali (5km e 5km)
  });
});
