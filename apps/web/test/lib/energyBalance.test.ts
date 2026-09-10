import { describe, it, expect } from 'vitest';
import { buildEnergyBalanceInputs, computeActivityEnergyBalance } from '../../src/lib/energyBalance.js';
import { powerFromSpeed, type PhysicsParams } from '@physics-core';
import type { ActivityDisplayPoint } from '../../src/activity/buildActivityDisplay.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

/** ActivityDisplayPoint sintetico a velocità costante (1 punto/secondo), gradiente piatto. */
function flatConstantSpeedActivity(speedKmh: number, n = 20): ActivityDisplayPoint[] {
  const speedMS = speedKmh / 3.6;
  const powerW = powerFromSpeed(speedMS, 0, params);
  const points: ActivityDisplayPoint[] = [];
  for (let i = 0; i < n; i++) {
    points.push({ lat: 45, lon: 11, ele: 100, dist: i * speedMS, gradient: 0, powerW, speedKmh, timeSec: i });
  }
  return points;
}

describe('buildEnergyBalanceInputs', () => {
  it('scarta i punti sotto la soglia di velocità minima', () => {
    const points = flatConstantSpeedActivity(30, 10);
    points[3]!.speedKmh = 1; // sotto soglia (default 3 km/h)
    const inputs = buildEnergyBalanceInputs(points, { smoothingSeconds: 0 });
    expect(inputs.some(i => i.speedMS < 1)).toBe(false);
  });

  it('scarta i punti senza potenza valida', () => {
    const points = flatConstantSpeedActivity(30, 10);
    points[5]!.powerW = null;
    const inputs = buildEnergyBalanceInputs(points, { smoothingSeconds: 0 });
    expect(inputs).toHaveLength(9);
  });

  it('con meno di 3 punti utili restituisce array vuoto', () => {
    expect(buildEnergyBalanceInputs(flatConstantSpeedActivity(30, 2))).toHaveLength(0);
  });
});

describe('computeActivityEnergyBalance', () => {
  it('su un\'uscita sintetica a velocità costante e potenza fisicamente coerente, il residuo mediano è vicino a 0', () => {
    const points = flatConstantSpeedActivity(30, 30);
    const rows = computeActivityEnergyBalance(points, params, { smoothingSeconds: 0 });
    expect(rows.length).toBeGreaterThan(0);
    const sorted = [...rows].map(r => Math.abs(r.residualPowerW)).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(median).toBeLessThan(5);
  });
});
