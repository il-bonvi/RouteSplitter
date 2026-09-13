import { describe, it, expect } from 'vitest';
import { buildEnergyBalanceInputs, computeActivityEnergyBalance, summarizeEnergyBalanceComparison } from '../../src/lib/energyBalance.js';
import { powerFromSpeed, type PhysicsParams, type EnergyBalanceRow } from '@physics-core';
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

function fakeRow(residualPowerW: number): EnergyBalanceRow {
  return {
    timeSec: 0,
    distKm: 0,
    dtSec: 1,
    gradientPct: 0,
    speedKmh: 30,
    powerW: 200,
    dissipativePowerW: 190,
    gravPowerW: 0,
    observedDeltaKeJ: 0,
    predictedDeltaKeJ: 0,
    residualJ: residualPowerW,
    residualPowerW
  };
}

describe('summarizeEnergyBalanceComparison', () => {
  it('null se uno dei due bilanci è vuoto', () => {
    expect(summarizeEnergyBalanceComparison([], [fakeRow(10)])).toBeNull();
  });

  it('usa il residuo ASSOLUTO: un segno che si inverte non conta come miglioramento se la magnitudine è uguale', () => {
    const baseline = [fakeRow(40), fakeRow(-40)];
    const withWeather = [fakeRow(-40), fakeRow(40)]; // stessa magnitudine, segno invertito
    const summary = summarizeEnergyBalanceComparison(baseline, withWeather)!;
    expect(summary.medianAbsResidualBaselineW).toBeCloseTo(40, 5);
    expect(summary.medianAbsResidualWithWeatherW).toBeCloseTo(40, 5);
    expect(summary.improvedCount).toBe(0);
  });

  it('conta correttamente gli intervalli che migliorano (|residuo| più basso)', () => {
    const baseline = [fakeRow(50), fakeRow(50), fakeRow(50)];
    const withWeather = [fakeRow(10), fakeRow(60), fakeRow(50)]; // migliora, peggiora, invariato
    const summary = summarizeEnergyBalanceComparison(baseline, withWeather)!;
    expect(summary.improvedCount).toBe(1);
    expect(summary.n).toBe(3);
  });

  it('calcola anche la media (non solo la mediana) del residuo assoluto', () => {
    const baseline = [fakeRow(10), fakeRow(20), fakeRow(30)];
    const withWeather = [fakeRow(5), fakeRow(10), fakeRow(15)];
    const summary = summarizeEnergyBalanceComparison(baseline, withWeather)!;
    expect(summary.meanAbsResidualBaselineW).toBeCloseTo(20, 5); // (10+20+30)/3
    expect(summary.meanAbsResidualWithWeatherW).toBeCloseTo(10, 5); // (5+10+15)/3
  });
});
