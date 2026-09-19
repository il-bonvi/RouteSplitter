import { describe, it, expect } from 'vitest';
import {
  estimateTheoreticalPower,
  powerFromSpeed,
  wheelPowerAtSpeed,
  type MotionSample,
  type PhysicsParams
} from '../../src/physics-core/index.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

describe('estimateTheoreticalPower', () => {
  it('a velocità costante coincide con powerFromSpeed (nessun termine cinetico)', () => {
    const speedMS = 10;
    const gradientPct = 3;
    const samples: MotionSample[] = Array.from({ length: 5 }, (_, i) => ({
      timeSec: i,
      distKm: (i * speedMS) / 1000,
      speedMS,
      gradientPct
    }));
    const rows = estimateTheoreticalPower(samples, params);
    expect(rows).toHaveLength(4);
    const expected = powerFromSpeed(speedMS, gradientPct, params);
    for (const r of rows) {
      expect(r.theoreticalPowerW).toBeCloseTo(expected, 3);
    }
  });

  it('identità esatta: dato un salto di velocità arbitrario, ricava la potenza che lo produce (inverso di computeEnergyBalance)', () => {
    const m = params.riderMassKg + params.bikeMassKg;
    const gradientPct = 2;
    const v0 = 8;
    const v1 = 9.5; // accelerazione
    const dt = 4;
    const vAvg = (v0 + v1) / 2;
    const wheelPowerAtAvg = wheelPowerAtSpeed(vAvg, gradientPct, params);
    const accelPowerW = (m * vAvg * (v1 - v0)) / dt;
    const wheelPowerW = wheelPowerAtAvg + accelPowerW;
    const expectedPowerW = wheelPowerW / (1 - params.drivetrainLossPct / 100);

    const samples: MotionSample[] = [
      { timeSec: 0, distKm: 0, speedMS: v0, gradientPct },
      { timeSec: dt, distKm: (v0 * dt) / 1000, speedMS: v1, gradientPct }
    ];
    const rows = estimateTheoreticalPower(samples, params);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.theoreticalPowerW).toBeCloseTo(expectedPowerW, 3);
  });

  it('accelerando serve più potenza teorica che a velocità media costante', () => {
    const gradientPct = 0;
    const v0 = 8;
    const v1 = 10;
    const vAvg = (v0 + v1) / 2;
    const samples: MotionSample[] = [
      { timeSec: 0, distKm: 0, speedMS: v0, gradientPct },
      { timeSec: 2, distKm: 0.016, speedMS: v1, gradientPct }
    ];
    const rows = estimateTheoreticalPower(samples, params);
    const steadyPower = powerFromSpeed(vAvg, gradientPct, params);
    expect(rows[0]!.theoreticalPowerW).toBeGreaterThan(steadyPower);
  });

  it('una frenata (decelerazione più forte di quanto le resistenze spieghino) viene clampata a 0, non a un valore negativo', () => {
    const gradientPct = -8;
    const samples: MotionSample[] = [
      { timeSec: 0, distKm: 0, speedMS: 15, gradientPct },
      { timeSec: 1, distKm: 0.01, speedMS: 4, gradientPct } // crollo di velocità impossibile senza frenata
    ];
    const rows = estimateTheoreticalPower(samples, params);
    expect(rows[0]!.theoreticalPowerW).toBe(0);
  });

  it('rispetta il vento per-campione quando fornito, altrimenti ricade su params.windKmh', () => {
    const speedMS = 10;
    const gradientPct = 0;
    const withHeadwind: MotionSample[] = [
      { timeSec: 0, distKm: 0, speedMS, gradientPct, windKmh: 20 },
      { timeSec: 1, distKm: 0.01, speedMS, gradientPct, windKmh: 20 }
    ];
    const noWind: MotionSample[] = [
      { timeSec: 0, distKm: 0, speedMS, gradientPct },
      { timeSec: 1, distKm: 0.01, speedMS, gradientPct }
    ];
    const rowsHeadwind = estimateTheoreticalPower(withHeadwind, params);
    const rowsNoWind = estimateTheoreticalPower(noWind, params);
    expect(rowsHeadwind[0]!.theoreticalPowerW).toBeGreaterThan(rowsNoWind[0]!.theoreticalPowerW);
  });

  it('salta intervalli con dtSec <= 0 (timestamp duplicati/fuori ordine)', () => {
    const samples: MotionSample[] = [
      { timeSec: 0, distKm: 0, speedMS: 8, gradientPct: 0 },
      { timeSec: 0, distKm: 0, speedMS: 8.2, gradientPct: 0 }, // stesso timeSec
      { timeSec: 1, distKm: 0.008, speedMS: 8.5, gradientPct: 0 }
    ];
    const rows = estimateTheoreticalPower(samples, params);
    expect(rows).toHaveLength(1);
  });
});
