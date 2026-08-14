import { describe, it, expect } from 'vitest';
import { buildColorSegments } from '../../src/lib/buildColorSegments.js';
import { processRoute } from '@physics-core';

describe('buildColorSegments', () => {
  it('su un percorso a pendenza pressoché costante produce MOLTI meno segmenti dei punti totali', () => {
    // 200 punti su una salita dolce e costante: il prototipo originale avrebbe creato
    // 199 polyline separate. Qui ci aspettiamo un numero molto più piccolo.
    const raw = Array.from({ length: 200 }, (_, i) => ({
      lat: 45.0 + i * 0.0002,
      lon: 11.0,
      ele: 100 + i * 2 // pendenza costante
    }));
    const route = processRoute(raw);
    const segments = buildColorSegments(route.points, 50);
    expect(segments.length).toBeLessThan(20);
    expect(segments.length).toBeGreaterThan(0);
  });

  it('con meno di 2 punti ritorna un array vuoto', () => {
    expect(buildColorSegments([], 50)).toEqual([]);
  });

  it('ogni segmento ha almeno 2 posizioni (altrimenti non è una linea disegnabile)', () => {
    const raw = [
      { lat: 45.0, lon: 11.0, ele: 100 },
      { lat: 45.001, lon: 11.0, ele: 105 },
      { lat: 45.002, lon: 11.0, ele: 150 }, // salto di pendenza netto
      { lat: 45.003, lon: 11.0, ele: 152 }
    ];
    const route = processRoute(raw);
    const segments = buildColorSegments(route.points, 10);
    for (const seg of segments) {
      expect(seg.positions.length).toBeGreaterThanOrEqual(2);
    }
  });
});
