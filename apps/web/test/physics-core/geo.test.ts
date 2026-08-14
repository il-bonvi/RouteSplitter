import { describe, it, expect } from 'vitest';
import { haversine, processRoute, getInterpolatedPoint, computeGainLossBetween } from '../../src/physics-core/geo.js';

describe('haversine', () => {
  it('distanza nulla tra due punti identici', () => {
    expect(haversine(45.07, 11.12, 45.07, 11.12)).toBeCloseTo(0, 6);
  });

  it('ordine di grandezza corretto per ~1 grado di latitudine (~111 km)', () => {
    const d = haversine(45.0, 11.0, 46.0, 11.0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

describe('processRoute', () => {
  const flat = [
    { lat: 45.0, lon: 11.0, ele: 100 },
    { lat: 45.001, lon: 11.0, ele: 100 },
    { lat: 45.002, lon: 11.0, ele: 100 }
  ];

  it('lancia un errore con meno di 2 punti', () => {
    expect(() => processRoute([flat[0]!])).toThrow();
  });

  it('su un percorso piatto, D+ e D- sono entrambi ~0', () => {
    const route = processRoute(flat);
    expect(route.elevationGain).toBeCloseTo(0, 6);
    expect(route.elevationLoss).toBeCloseTo(0, 6);
  });

  it('un percorso in salita costante accumula solo D+ (mai D-)', () => {
    const climbing = [
      { lat: 45.0, lon: 11.0, ele: 100 },
      { lat: 45.001, lon: 11.0, ele: 110 },
      { lat: 45.002, lon: 11.0, ele: 125 }
    ];
    const route = processRoute(climbing);
    expect(route.elevationGain).toBeCloseTo(25, 6);
    expect(route.elevationLoss).toBeCloseTo(0, 6);
  });
});

describe('getInterpolatedPoint', () => {
  const climbing = processRoute([
    { lat: 45.0, lon: 11.0, ele: 100 },
    { lat: 45.001, lon: 11.0, ele: 200 }
  ]).points;

  it('a metà distanza interpola a metà quota', () => {
    const totalDist = climbing[climbing.length - 1]!.dist;
    const mid = getInterpolatedPoint(climbing, totalDist / 2);
    expect(mid.ele).toBeCloseTo(150, 0);
  });

  it('clampa a inizio/fine percorso fuori range', () => {
    expect(getInterpolatedPoint(climbing, -100).ele).toBeCloseTo(100, 6);
    expect(getInterpolatedPoint(climbing, 1e9).ele).toBeCloseTo(200, 6);
  });
});

describe('computeGainLossBetween — indipendente da qualunque smoothing grafico', () => {
  it('su un percorso a "V" (discesa poi salita), D+/D- riflettono entrambe le fasi anche su un sotto-range', () => {
    const points = processRoute([
      { lat: 45.0, lon: 11.0, ele: 200 },
      { lat: 45.001, lon: 11.0, ele: 100 }, // discesa
      { lat: 45.002, lon: 11.0, ele: 180 } // risalita
    ]).points;
    const totalKm = points[points.length - 1]!.dist / 1000;
    const { gain, loss } = computeGainLossBetween(points, 0, totalKm);
    expect(loss).toBeCloseTo(100, 0);
    expect(gain).toBeCloseTo(80, 0);
  });
});
