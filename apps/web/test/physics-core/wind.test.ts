import { describe, it, expect } from 'vitest';
import { bearingDeg, processRoute } from '../../src/physics-core/geo.js';
import {
  effectiveHeadwindKmh,
  routeBearingAtDistKm,
  windAtDistKm,
  makeUniformWindZones,
  type WindZoneBoundary
} from '../../src/physics-core/wind.js';

describe('bearingDeg', () => {
  it('rotta verso Nord è ~0°', () => {
    expect(bearingDeg(45.0, 11.0, 45.01, 11.0)).toBeCloseTo(0, 0);
  });
  it('rotta verso Est è ~90°', () => {
    expect(bearingDeg(45.0, 11.0, 45.0, 11.01)).toBeCloseTo(90, 0);
  });
  it('rotta verso Sud è ~180°', () => {
    expect(bearingDeg(45.0, 11.0, 44.99, 11.0)).toBeCloseTo(180, 0);
  });
});

describe('effectiveHeadwindKmh', () => {
  it('vento da Nord, ciclista che va verso Nord → vento in faccia (positivo)', () => {
    // Bussola: bearing 0 = si va verso Nord. Vento "da Nord" (directionDeg=0) soffia verso
    // Sud: colpisce in faccia chi sta andando a Nord.
    expect(effectiveHeadwindKmh(20, 0, 0)).toBeCloseTo(20, 6);
  });

  it('vento da Sud, ciclista che va verso Nord → vento in coda (negativo)', () => {
    expect(effectiveHeadwindKmh(20, 180, 0)).toBeCloseTo(-20, 6);
  });

  it('vento laterale (da Est, marcia verso Nord) → componente ~0', () => {
    expect(effectiveHeadwindKmh(20, 90, 0)).toBeCloseTo(0, 6);
  });

  it('vento nullo → componente nulla indipendentemente dalla direzione', () => {
    expect(effectiveHeadwindKmh(0, 123, 45)).toBeCloseTo(0, 6);
  });
});

describe('routeBearingAtDistKm', () => {
  it('su un rettilineo verso Nord la rotta è ~0° in qualsiasi punto interno', () => {
    const route = processRoute([
      { lat: 45.0, lon: 11.0, ele: 100 },
      { lat: 45.01, lon: 11.0, ele: 100 },
      { lat: 45.02, lon: 11.0, ele: 100 }
    ]);
    const mid = route.distanceKm / 2;
    expect(routeBearingAtDistKm(route.points, mid)).toBeCloseTo(0, -1);
  });
});

describe('windAtDistKm / makeUniformWindZones', () => {
  it('con una sola zona uniforme, il vento è lo stesso su tutto il percorso', () => {
    const zones = makeUniformWindZones(50, 15, 200);
    expect(windAtDistKm(zones, 0)).toEqual({ speedKmh: 15, directionDeg: 200 });
    expect(windAtDistKm(zones, 25)).toEqual({ speedKmh: 15, directionDeg: 200 });
    expect(windAtDistKm(zones, 50)).toEqual({ speedKmh: 15, directionDeg: 200 });
  });

  it('con più zone, restituisce il vento della zona corretta', () => {
    const zones: WindZoneBoundary[] = [
      { id: 'a', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
      { id: 'b', distKm: 20, fixed: false, speedKmh: 10, directionDeg: 90 },
      { id: 'c', distKm: 50, fixed: 'finish', speedKmh: 25, directionDeg: 270 }
    ];
    expect(windAtDistKm(zones, 5)).toEqual({ speedKmh: 10, directionDeg: 90 });
    expect(windAtDistKm(zones, 19.9)).toEqual({ speedKmh: 10, directionDeg: 90 });
    expect(windAtDistKm(zones, 20)).toEqual({ speedKmh: 10, directionDeg: 90 });
    expect(windAtDistKm(zones, 35)).toEqual({ speedKmh: 25, directionDeg: 270 });
  });

  it('con meno di 2 confini restituisce null', () => {
    expect(windAtDistKm([], 10)).toBeNull();
  });
});
