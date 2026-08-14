import { describe, it, expect } from 'vitest';
import { computeNormalizedPower, timeWeightedAvgPower } from '../../src/physics-core/normalizedPower.js';
import type { PhysicsParams, PowerSegment } from '../../src/physics-core/types.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

describe('computeNormalizedPower', () => {
  it('con potenza costante su tutto il percorso, NP == potenza costante (nessuna variabilità)', () => {
    const segments: PowerSegment[] = [
      { distanceKm: 5, gradient: 0, power: 220 },
      { distanceKm: 5, gradient: 2, power: 220 },
      { distanceKm: 5, gradient: -1, power: 220 }
    ];
    const np = computeNormalizedPower(segments, params);
    expect(np).toBeCloseTo(220, 0);
  });

  it('con potenza variabile, NP è sempre >= media aritmetica (convessità di x^4)', () => {
    const segments: PowerSegment[] = [
      { distanceKm: 2, gradient: 8, power: 400 },
      { distanceKm: 8, gradient: -2, power: 120 }
    ];
    const np = computeNormalizedPower(segments, params);
    const arithmeticMean = (400 + 120) / 2;
    expect(np).toBeGreaterThanOrEqual(arithmeticMean);
  });

  it('è sensibile alla durata reale dei segmenti (pesata sul tempo), non al loro numero', () => {
    // Un segmento breve e intenso pesa poco sulla NP se la sua durata è breve rispetto al resto
    const fewLongSegments: PowerSegment[] = [
      { distanceKm: 20, gradient: 0, power: 200 },
      { distanceKm: 0.1, gradient: 0, power: 500 } // brevissimo, dura pochi secondi
    ];
    const np = computeNormalizedPower(fewLongSegments, params);
    // Il vecchio calcolo "media(p^4) per numero di segmenti" avrebbe dato un peso
    // sproporzionato al segmento breve (50% dei "segmenti", ~0% del tempo reale).
    // Con la pesatura sul tempo corretta, NP deve restare vicina a 200, non salire verso 500.
    expect(np).toBeLessThan(250);
  });
});

describe('timeWeightedAvgPower', () => {
  it('pesa sul tempo, non sul numero di segmenti', () => {
    const segments: PowerSegment[] = [
      { distanceKm: 20, gradient: 0, power: 200 }, // molto tempo a 200W
      { distanceKm: 0.05, gradient: 0, power: 600 } // pochissimo tempo a 600W
    ];
    const avg = timeWeightedAvgPower(segments, params);
    // La media aritmetica semplice sarebbe 400; quella pesata sul tempo deve restare vicina a 200
    expect(avg).toBeLessThan(220);
  });
});
