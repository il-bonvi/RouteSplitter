import { describe, it, expect } from 'vitest';
import { haversine, processRoute, getInterpolatedPoint, computeGainLossBetween, distanceWeightedMeanBearingDeg, cropRoutePoints } from '../../src/physics-core/geo.js';

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

describe('distanceWeightedMeanBearingDeg', () => {
  it('un percorso rettilineo verso est ha bearing ~90°', () => {
    const points = [
      { lat: 45, lon: 11 },
      { lat: 45, lon: 11.01 },
      { lat: 45, lon: 11.02 }
    ];
    expect(distanceWeightedMeanBearingDeg(points)!).toBeCloseTo(90, 0);
  });

  it('pesa per distanza: un tratto lungo verso nord domina su uno breve verso est', () => {
    const points = [
      { lat: 45, lon: 11 },
      { lat: 45, lon: 11.001 }, // segmento breve verso est
      { lat: 45.1, lon: 11.001 } // segmento lungo (~11km) verso nord
    ];
    const bearing = distanceWeightedMeanBearingDeg(points)!;
    expect(bearing).toBeLessThan(20); // vicino a nord (0°), non a est (90°)
  });

  it('null con meno di 2 punti', () => {
    expect(distanceWeightedMeanBearingDeg([{ lat: 45, lon: 11 }])).toBeNull();
  });

  it('null se tutti i punti coincidono (nessun segmento con distanza > 0)', () => {
    expect(distanceWeightedMeanBearingDeg([{ lat: 45, lon: 11 }, { lat: 45, lon: 11 }])).toBeNull();
  });
});

describe('cropRoutePoints', () => {
  // Punto lungo un meridiano (lon fissa): con lat = distM/metersPerDegree usando lo STESSO
  // raggio terrestre di `haversine` (6 371 000 m, non i 111 320 m/grado dell'ellissoide
  // WGS84 usati altrove nei test con tolleranze larghe), la distanza haversine ricalcolata
  // da `processRoute` coincide con distM a meno di rumore in virgola mobile — necessario
  // qui perché verifichiamo l'interpolazione dell'elevazione a pochi millimetri.
  const METERS_PER_DEGREE = (Math.PI / 180) * 6371000;
  function routePoint(distM: number, ele: number) {
    return { lat: distM / METERS_PER_DEGREE, lon: 11, ele };
  }

  it('ritaglia al km esatto, interpolando gli estremi (non tronca al punto GPX più vicino)', () => {
    const raw = [routePoint(0, 100), routePoint(1000, 150), routePoint(2000, 100), routePoint(3000, 200)];
    const processed = processRoute(raw);
    const cropped = cropRoutePoints(processed.points, 0.5, 2.5);
    const croppedProcessed = processRoute(cropped);
    expect(croppedProcessed.distanceKm).toBeCloseTo(2, 6);
    // Quota interpolata a 500 m (metà tra 100 e 150) e a 2500 m (metà tra 100 e 200).
    expect(cropped[0]!.ele).toBeCloseTo(125, 3);
    expect(cropped[cropped.length - 1]!.ele).toBeCloseTo(150, 3);
  });

  it('ritagliare l\'intero percorso restituisce (in sostanza) lo stesso percorso', () => {
    const raw = [routePoint(0, 100), routePoint(1000, 150), routePoint(2000, 100)];
    const processed = processRoute(raw);
    const cropped = cropRoutePoints(processed.points, 0, processed.distanceKm);
    expect(cropped).toHaveLength(raw.length);
    expect(processRoute(cropped).distanceKm).toBeCloseTo(processed.distanceKm, 6);
  });

  it('clampa fromKm/toKm fuori dai limiti del percorso', () => {
    const raw = [routePoint(0, 100), routePoint(1000, 150), routePoint(2000, 100)];
    const processed = processRoute(raw);
    const cropped = cropRoutePoints(processed.points, -5, 999);
    expect(processRoute(cropped).distanceKm).toBeCloseTo(processed.distanceKm, 6);
  });

  it('intervallo degenere o invertito (toKm <= fromKm) ritorna array vuoto — non normalizza scambiando gli estremi', () => {
    const raw = [routePoint(0, 100), routePoint(1000, 150), routePoint(2000, 100)];
    const processed = processRoute(raw);
    expect(cropRoutePoints(processed.points, 1, 1)).toHaveLength(0);
    expect(cropRoutePoints(processed.points, 1.5, 1)).toHaveLength(0);
  });

  it('meno di 2 punti in ingresso ritorna array vuoto', () => {
    expect(cropRoutePoints([], 0, 1)).toHaveLength(0);
  });
});
