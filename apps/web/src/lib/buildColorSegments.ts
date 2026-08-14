import { smoothByDistance, type ProcessedPoint } from '@physics-core';
import { getGradientColor } from './gradientColor.js';

export interface ColorSegment {
  color: string;
  positions: [number, number][];
}

/**
 * Quantizza il gradiente prima di colorare, in modo che tratti con pendenza quasi
 * costante producano davvero lo STESSO colore esatto (non solo visivamente simile) e
 * possano essere uniti in un unico segmento — altrimenti l'interpolazione continua dei
 * colori produrrebbe un colore leggermente diverso per ogni punto e non si guadagnerebbe
 * nulla in numero di layer Leaflet creati.
 */
function bucketGradient(gradient: number, stepPct = 0.5): number {
  return Math.round(gradient / stepPct) * stepPct;
}

/**
 * Costruisce pochi segmenti colorati (invece di uno per ogni coppia di punti GPX) per
 * disegnare la mappa colorata per pendenza senza creare migliaia di layer Leaflet.
 */
export function buildColorSegments(points: ProcessedPoint[], smoothingRadiusMeters: number): ColorSegment[] {
  if (points.length < 2) return [];
  const distances = points.map(p => p.dist);
  const gradients = points.map(p => p.gradient);
  const smoothed = smoothByDistance(gradients, distances, smoothingRadiusMeters);

  const segments: ColorSegment[] = [];
  let currentColor: string | null = null;
  let currentPositions: [number, number][] = [];

  for (let i = 1; i < points.length; i++) {
    const color = getGradientColor(bucketGradient(smoothed[i]!));
    if (color !== currentColor) {
      if (currentColor && currentPositions.length > 1) {
        segments.push({ color: currentColor, positions: currentPositions });
      }
      currentColor = color;
      const prev = points[i - 1]!;
      currentPositions = [[prev.lat, prev.lon]];
    }
    const curr = points[i]!;
    currentPositions.push([curr.lat, curr.lon]);
  }
  if (currentColor && currentPositions.length > 1) {
    segments.push({ color: currentColor, positions: currentPositions });
  }
  return segments;
}
