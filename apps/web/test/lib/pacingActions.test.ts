import { describe, it, expect } from 'vitest';
import { breakpointsToSegments, buildFineGrid, mapFinePowersToBreakpoints } from '../../src/lib/pacingActions.js';
import { processRoute, type SectionBreakpoint } from '@physics-core';

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
