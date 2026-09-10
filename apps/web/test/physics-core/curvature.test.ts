import { describe, it, expect } from 'vitest';
import { estimateCurveRadiusM, maxCorneringSpeedKmh } from '../../src/physics-core/curvature.js';
import { processRoute } from '../../src/physics-core/geo.js';

const EARTH_RADIUS_M = 6371000;

/** Genera punti su un rettilineo (bearing costante), passo ~2m, lunghezza totale `lengthM`. */
function straightLine(lengthM: number, stepM = 2): { lat: number; lon: number; ele: number }[] {
  const lat0 = 45;
  const points: { lat: number; lon: number; ele: number }[] = [];
  for (let d = 0; d <= lengthM; d += stepM) {
    const dLat = (d / EARTH_RADIUS_M) * (180 / Math.PI);
    points.push({ lat: lat0 + dLat, lon: 11, ele: 100 });
  }
  return points;
}

/** Genera punti su un arco di cerchio di raggio noto `radiusM` (approssimazione a terra
 * piatta, valida per gli archi corti usati nei test), passo angolare fine. */
function circularArc(radiusM: number, totalAngleDeg: number, stepDeg = 0.5): { lat: number; lon: number; ele: number }[] {
  const lat0 = 45;
  const lonScale = Math.cos((lat0 * Math.PI) / 180);
  const points: { lat: number; lon: number; ele: number }[] = [];
  for (let a = -totalAngleDeg / 2; a <= totalAngleDeg / 2; a += stepDeg) {
    const rad = (a * Math.PI) / 180;
    const xM = radiusM * Math.sin(rad); // est-ovest
    const yM = radiusM * (1 - Math.cos(rad)); // nord-sud, cerchio tangente al rettilineo iniziale
    const dLat = (yM / EARTH_RADIUS_M) * (180 / Math.PI);
    const dLon = (xM / (EARTH_RADIUS_M * lonScale)) * (180 / Math.PI);
    points.push({ lat: lat0 + dLat, lon: 11 + dLon, ele: 100 });
  }
  return points;
}

describe('estimateCurveRadiusM', () => {
  it('un rettilineo ha raggio infinito (nessuna curva)', () => {
    const route = processRoute(straightLine(200));
    const radius = estimateCurveRadiusM(route.points, 0.1); // a 100m dall'inizio
    expect(radius).toBe(Infinity);
  });

  it('quasi-collinearità numerica (rumore GPS su un rettilineo reale) resta Infinity, non un numero enorme', () => {
    // Bug reale trovato il 2026-08-31 su dati esportati: con punti quasi ma non esattamente
    // allineati, l'area del triangolo può essere minuscola-ma-non-zero e far "esplodere"
    // numericamente il raggio calcolato a valori come 3.4e11 metri — corretti in aritmetica
    // ma senza senso fisico e fuorvianti in un CSV. Simulo un rettilineo con un rumore
    // sub-millimetrico su un punto per riprodurre il caso.
    const pts = straightLine(60, 5);
    pts[6]!.lat += 1e-11; // rumore minuscolo, non un vero cambio di direzione
    const route = processRoute(pts);
    const radius = estimateCurveRadiusM(route.points, 0.03);
    expect(radius).toBe(Infinity);
  });

  it('un arco di cerchio di raggio noto viene stimato correttamente (entro il 15%)', () => {
    const radiusM = 25; // tornante stretto
    const route = processRoute(circularArc(radiusM, 90));
    const midDistKm = route.points[route.points.length - 1]!.dist / 2 / 1000;
    const estimated = estimateCurveRadiusM(route.points, midDistKm, 10);
    expect(estimated).toBeGreaterThan(radiusM * 0.85);
    expect(estimated).toBeLessThan(radiusM * 1.15);
  });

  it('una curva più larga dà un raggio stimato maggiore di una più stretta', () => {
    const tight = processRoute(circularArc(15, 90));
    const wide = processRoute(circularArc(80, 90));
    const tightMidKm = tight.points[tight.points.length - 1]!.dist / 2 / 1000;
    const wideMidKm = wide.points[wide.points.length - 1]!.dist / 2 / 1000;
    const rTight = estimateCurveRadiusM(tight.points, tightMidKm, 8);
    const rWide = estimateCurveRadiusM(wide.points, wideMidKm, 8);
    expect(rTight).toBeLessThan(rWide);
  });
});

describe('maxCorneringSpeedKmh', () => {
  it('un raggio molto ampio (rettilineo) non impone limite', () => {
    expect(maxCorneringSpeedKmh(Infinity)).toBe(Infinity);
    expect(maxCorneringSpeedKmh(1000)).toBe(Infinity);
  });

  it('un tornante stretto impone un limite basso e coerente con v=√(μgR)', () => {
    const v = maxCorneringSpeedKmh(10, 0.35);
    // √(0.35*9.80665*10) m/s ≈ 5.86 m/s ≈ 21.1 km/h
    expect(v).toBeGreaterThan(19);
    expect(v).toBeLessThan(23);
  });

  it('raddoppiando il raggio la velocità massima cresce (non linearmente, √R)', () => {
    const v10 = maxCorneringSpeedKmh(10);
    const v40 = maxCorneringSpeedKmh(40);
    // √40/√10 = 2 esatto
    expect(v40 / v10).toBeCloseTo(2, 1);
  });

  it('un grip factor più prudente abbassa la velocità massima', () => {
    expect(maxCorneringSpeedKmh(20, 0.2)).toBeLessThan(maxCorneringSpeedKmh(20, 0.5));
  });
});
