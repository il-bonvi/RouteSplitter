import { describe, it, expect } from 'vitest';
import { optimizePacing } from '../../src/physics-core/pacingOptimizer.js';
import type { OptimizableSegment, PhysicsParams } from '../../src/physics-core/types.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

describe('optimizePacing', () => {
  it('su un percorso completamente piatto, converge a potenza ~uniforme vicina al target', () => {
    const segments: OptimizableSegment[] = Array.from({ length: 10 }, () => ({ distanceKm: 2, gradient: 0 }));
    const result = optimizePacing(segments, { targetAvgPower: 220, minPower: 100, maxPower: 400 }, params);
    expect(result.timeWeightedAvgPower).toBeCloseTo(220, 0);
    const spread = Math.max(...result.powers) - Math.min(...result.powers);
    expect(spread).toBeLessThan(15); // in piano puro non c'è motivo di variare granché
  });

  it('assegna più potenza ai tratti in salita rispetto a quelli in piano, a parità di media', () => {
    const segments: OptimizableSegment[] = [
      { distanceKm: 5, gradient: 8 }, // salita ripida
      { distanceKm: 5, gradient: 0 } // piano
    ];
    const result = optimizePacing(segments, { targetAvgPower: 220, minPower: 100, maxPower: 400 }, params);
    const [climbPower, flatPower] = result.powers;
    expect(climbPower!).toBeGreaterThan(flatPower!);
  });

  it('rispetta i limiti minPower/maxPower anche quando il target li renderebbe necessari', () => {
    const segments: OptimizableSegment[] = [
      { distanceKm: 3, gradient: 12 },
      { distanceKm: 3, gradient: -8 }
    ];
    const result = optimizePacing(segments, { targetAvgPower: 250, minPower: 150, maxPower: 300 }, params);
    for (const p of result.powers) {
      expect(p).toBeGreaterThanOrEqual(150 - 1e-6);
      expect(p).toBeLessThanOrEqual(300 + 1e-6);
    }
  });

  it('con un target NP esplicito, la NP finale si avvicina al target entro tolleranza ragionevole', () => {
    const segments: OptimizableSegment[] = [
      { distanceKm: 3, gradient: 10 },
      { distanceKm: 3, gradient: -6 },
      { distanceKm: 4, gradient: 1 }
    ];
    const result = optimizePacing(
      segments,
      { targetAvgPower: 220, targetNormalizedPower: 245, minPower: 100, maxPower: 400 },
      params
    );
    expect(Math.abs(result.normalizedPower - 245)).toBeLessThan(5);
  });

  it('funziona identicamente su una griglia fine con molti segmenti brevi (stessa funzione, nessuna duplicazione)', () => {
    const segments: OptimizableSegment[] = Array.from({ length: 200 }, (_, i) => ({
      distanceKm: 0.1,
      gradient: Math.sin(i / 20) * 6
    }));
    const result = optimizePacing(segments, { targetAvgPower: 200, minPower: 100, maxPower: 400 }, params);
    expect(result.timeWeightedAvgPower).toBeCloseTo(200, 0);
    expect(result.powers).toHaveLength(200);
  });
});
