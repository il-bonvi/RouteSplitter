import { describe, it, expect } from 'vitest';
import { computePlanVsActualSections, computePlanVsActualFineGrid, padSeriesToRouteEdges } from '../../src/lib/planVsActual.js';
import { processRoute, powerFromSpeed, type SectionBreakpoint, type PhysicsParams, type CdaSample } from '@physics-core';
import { DEFAULT_PHYSICS_PARAMS } from '@shared-schema';
import type { ActivityDisplayPoint } from '../../src/activity/buildActivityDisplay.js';

const params: PhysicsParams = { ...DEFAULT_PHYSICS_PARAMS, windKmh: 0 };

function flatRoute(distanceKm: number, n = 200) {
  const raw = Array.from({ length: n }, (_, i) => ({
    lat: 45.0 + (i / (n - 1)) * (distanceKm / 111),
    lon: 11.0,
    ele: 100
  }));
  return processRoute(raw).points;
}

const breakpoints: SectionBreakpoint[] = [
  { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
  { id: 'mid', distKm: 10, fixed: false, sectionLabel: 'S1', speedKmh: 30, powerWatts: null },
  { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S2', speedKmh: 30, powerWatts: null }
];

/** Genera un'attività sintetica che percorre `distanceKm` a `speedKmh` costante, con potenza
 * fisicamente coerente (nessun vento, pianura) — cioè un'uscita "perfetta" rispetto al piano
 * (se speedKmh coincide col piano) o sistematicamente più lenta/veloce (altrimenti). */
function syntheticActivity(distanceKm: number, speedKmh: number, n = 400): { points: ActivityDisplayPoint[]; samples: CdaSample[] } {
  const speedMS = speedKmh / 3.6;
  const powerW = powerFromSpeed(speedMS, 0, params);
  const points: ActivityDisplayPoint[] = [];
  const samples: CdaSample[] = [];
  for (let i = 0; i < n; i++) {
    const distKm = (i / (n - 1)) * distanceKm;
    const distM = distKm * 1000;
    const timeSec = distM / speedMS;
    points.push({ lat: 45.0 + (distKm / 111), lon: 11.0, ele: 100, dist: distM, gradient: 0, powerW, speedKmh, timeSec });
    if (i > 0) samples.push({ speedMS, powerW, gradientPct: 0, distKm });
  }
  return { points, samples };
}

describe('computePlanVsActualSections', () => {
  it('con un\'uscita che replica esattamente il piano, i delta sono ~0', () => {
    const points = flatRoute(20);
    const { points: activityPoints, samples } = syntheticActivity(20, 30);
    const rows = computePlanVsActualSections(breakpoints, points, params, 'speed', 250, undefined, null, activityPoints, samples);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actualSpeedKmh).not.toBeNull();
      expect(row.deltaSpeedPct).not.toBeNull();
      expect(Math.abs(row.deltaSpeedPct!)).toBeLessThan(1);
      expect(Math.abs(row.deltaTimeHours!)).toBeLessThan(0.02);
    }
  });

  it('con un\'uscita sistematicamente più lenta, i delta sono negativi (velocità) e positivi (tempo)', () => {
    const points = flatRoute(20);
    const { points: activityPoints, samples } = syntheticActivity(20, 24); // 30 pianificati, 24 reali
    const rows = computePlanVsActualSections(breakpoints, points, params, 'speed', 250, undefined, null, activityPoints, samples);

    for (const row of rows) {
      expect(row.deltaSpeedPct).not.toBeNull();
      expect(row.deltaSpeedPct!).toBeLessThan(-15); // ~ -20%
      expect(row.deltaTimeHours!).toBeGreaterThan(0);
    }
  });

  it('senza dati reali per una sezione (nessun campione), i campi actual restano null', () => {
    const points = flatRoute(20);
    // Attività che copre solo i primi 5 km del percorso di 20 km.
    const { points: activityPoints, samples } = syntheticActivity(5, 30);
    const rows = computePlanVsActualSections(breakpoints, points, params, 'speed', 250, undefined, null, activityPoints, samples);

    expect(rows[0]!.actualSpeedKmh).not.toBeNull();
    expect(rows[1]!.actualSpeedKmh).toBeNull();
    expect(rows[1]!.deltaSpeedPct).toBeNull();
  });

  it('stima il vento implicito reale quando lo trova, e calcola il delta vento vs pianificato', () => {
    const points = flatRoute(20);
    // Piano senza vento (0), uscita reale con 15 km/h di vento in testa incorporato nella potenza.
    const windyParams: PhysicsParams = { ...params, windKmh: 15 };
    const speedMS = 30 / 3.6;
    const powerW = powerFromSpeed(speedMS, 0, windyParams);
    const n = 400;
    const activityPoints: ActivityDisplayPoint[] = [];
    const samples: CdaSample[] = [];
    for (let i = 0; i < n; i++) {
      const distKm = (i / (n - 1)) * 20;
      const distM = distKm * 1000;
      activityPoints.push({ lat: 45.0 + distKm / 111, lon: 11.0, ele: 100, dist: distM, gradient: 0, powerW, speedKmh: 30, timeSec: distM / speedMS });
      if (i > 0) samples.push({ speedMS, powerW, gradientPct: 0, distKm });
    }
    const rows = computePlanVsActualSections(breakpoints, points, params, 'speed', 250, undefined, null, activityPoints, samples);
    for (const row of rows) {
      expect(row.actualWindHeadwindKmh).not.toBeNull();
      expect(row.actualWindHeadwindKmh!).toBeCloseTo(15, 0);
      expect(row.plannedWindHeadwindKmh).toBe(0);
      expect(row.deltaWindKmh!).toBeCloseTo(15, 0);
    }
  });
});

describe('computePlanVsActualFineGrid', () => {
  it('produce un punto per bin con elevazione ed entrambe le velocità pianificata/reale', () => {
    const points = flatRoute(20);
    const { samples } = syntheticActivity(20, 30);
    const grid = computePlanVsActualFineGrid(breakpoints, points, params, 'speed', 250, undefined, 20, samples, 1);

    expect(grid.length).toBeGreaterThan(15);
    for (const p of grid) {
      expect(p.plannedSpeedKmh).toBeCloseTo(30, 0);
      expect(Number.isFinite(p.ele)).toBe(true);
    }
    expect(grid.some(p => p.actualSpeedKmh != null)).toBe(true);
  });

  it('rispetta il passo richiesto (stepKm) — bin equispaziati, non un numero fisso di bin', () => {
    const points = flatRoute(6.42, 400);
    const { samples } = syntheticActivity(6.42, 30, 800);
    const bp: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 6.42, fixed: 'finish', sectionLabel: null, speedKmh: 30, powerWatts: null }
    ];

    const grid100m = computePlanVsActualFineGrid(bp, points, params, 'speed', 250, undefined, 6.42, samples, 0.1);
    const grid250m = computePlanVsActualFineGrid(bp, points, params, 'speed', 250, undefined, 6.42, samples, 0.25);

    // ~64 bin da 100m contro ~26 da 250m sugli stessi 6.42 km — non lo stesso conteggio.
    expect(grid100m.length).toBeGreaterThan(grid250m.length * 2);

    // Spaziatura fra i centri dei bin consecutivi (bin pieni, non l'ultimo eventualmente
    // parziale) coerente col passo richiesto, per ENTRAMBI i passi.
    for (let i = 1; i < grid100m.length - 1; i++) {
      expect(grid100m[i]!.distKm - grid100m[i - 1]!.distKm).toBeCloseTo(0.1, 6);
    }
    for (let i = 1; i < grid250m.length - 1; i++) {
      expect(grid250m[i]!.distKm - grid250m[i - 1]!.distKm).toBeCloseTo(0.25, 6);
    }

    // fromKm/toKm coprono esattamente il bin, distKm ne è il centro.
    expect(grid100m[0]!.fromKm).toBeCloseTo(0, 6);
    expect(grid100m[0]!.toKm).toBeCloseTo(0.1, 6);
    expect(grid100m[0]!.distKm).toBeCloseTo(0.05, 6);
  });
});

describe('padSeriesToRouteEdges', () => {
  it('duplica il primo/ultimo punto fino ai bordi 0/totalDistanceKm', () => {
    const series = [
      { distKm: 0.125, powerWatts: 200 },
      { distKm: 0.375, powerWatts: 210 },
      { distKm: 0.625, powerWatts: 190 }
    ];
    const padded = padSeriesToRouteEdges(series, 0.75);
    expect(padded[0]).toEqual({ distKm: 0, powerWatts: 200 });
    expect(padded[padded.length - 1]).toEqual({ distKm: 0.75, powerWatts: 190 });
    expect(padded).toHaveLength(5);
  });

  it('non duplica se il primo/ultimo punto è già ai bordi', () => {
    const series = [
      { distKm: 0, powerWatts: 200 },
      { distKm: 0.5, powerWatts: 190 }
    ];
    const padded = padSeriesToRouteEdges(series, 0.5);
    expect(padded).toHaveLength(2);
  });

  it('array vuoto resta vuoto', () => {
    expect(padSeriesToRouteEdges([], 10)).toEqual([]);
  });
});
