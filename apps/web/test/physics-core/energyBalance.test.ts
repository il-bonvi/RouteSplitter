import { describe, it, expect } from 'vitest';
import { computeEnergyBalance, speedFromPower, powerFromSpeed, wheelPowerAtSpeed, type EnergyBalanceInput, type PhysicsParams } from '../../src/physics-core/index.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

describe('computeEnergyBalance', () => {
  it('a velocità realmente costante il residuo è ~0 (potenza esattamente quella di equilibrio)', () => {
    const speedMS = 10;
    const powerW = powerFromSpeed(speedMS, 0, params);
    const inputs: EnergyBalanceInput[] = Array.from({ length: 5 }, (_, i) => ({
      timeSec: i,
      distKm: (i * speedMS) / 1000,
      speedMS,
      gradientPct: 0,
      powerW
    }));
    const rows = computeEnergyBalance(inputs, params);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.observedDeltaKeJ).toBeCloseTo(0, 6);
      expect(Math.abs(r.residualJ)).toBeLessThan(0.5);
    }
  });

  it('identità esatta: dato un salto di velocità arbitrario, la potenza che lo produce esattamente porta il residuo a 0', () => {
    const m = params.riderMassKg + params.bikeMassKg;
    const gradientPct = 2;
    const v0 = 8;
    const v1 = 9.5; // accelerazione
    const dt = 4;
    const vAvg = (v0 + v1) / 2;
    // Potenza alla ruota necessaria per mantenere vAvg costante (dissipazioni + gravità)...
    const wheelPowerAtAvg = wheelPowerAtSpeed(vAvg, gradientPct, params);
    // ...più il termine di accelerazione: m*vAvg*(v1-v0)/dt (potenza per variare l'EC).
    const accelPowerW = (m * vAvg * (v1 - v0)) / dt;
    const wheelPowerW = wheelPowerAtAvg + accelPowerW;
    const powerW = wheelPowerW / (1 - params.drivetrainLossPct / 100);

    const inputs: EnergyBalanceInput[] = [
      { timeSec: 0, distKm: 0, speedMS: v0, gradientPct, powerW },
      { timeSec: dt, distKm: (v0 * dt) / 1000, speedMS: v1, gradientPct, powerW }
    ];
    const rows = computeEnergyBalance(inputs, params);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.residualJ).toBeCloseTo(0, 3);
    expect(rows[0]!.observedDeltaKeJ).toBeGreaterThan(0); // sta accelerando, EC aumenta
  });

  it('una frenata (velocità crolla, potenza non negativa) produce un residuo fortemente negativo', () => {
    // In discesa ripida, potenza pedalata modesta ma velocità che crolla: nessuna delle
    // forze note (aero+rotolamento+gravità, tutte "in aiuto" o comunque non abbastanza forti
    // da spiegare un crollo così repentino) può spiegarlo — deve essere frenata.
    const inputs: EnergyBalanceInput[] = [
      { timeSec: 0, distKm: 0, speedMS: 20, gradientPct: -8, powerW: 100 },
      { timeSec: 2, distKm: 0.02, speedMS: 9, gradientPct: -8, powerW: 100 }
    ];
    const rows = computeEnergyBalance(inputs, params);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observedDeltaKeJ).toBeLessThan(0);
    // Il residuo deve essere negativo e di grandezza sostanziale (energia "sparita" che la
    // sola fisica nota non giustifica): non un valore preciso, ma un ordine di grandezza.
    expect(rows[0]!.residualJ).toBeLessThan(-500);
  });

  it('salta intervalli con timestamp non crescente (dtSec<=0)', () => {
    const inputs: EnergyBalanceInput[] = [
      { timeSec: 0, distKm: 0, speedMS: 10, gradientPct: 0, powerW: 200 },
      { timeSec: 0, distKm: 0, speedMS: 10, gradientPct: 0, powerW: 200 }, // timestamp duplicato
      { timeSec: 1, distKm: 0.01, speedMS: 10, gradientPct: 0, powerW: 200 }
    ];
    const rows = computeEnergyBalance(inputs, params);
    expect(rows).toHaveLength(1);
  });

  it('con un solo campione non produce righe', () => {
    expect(computeEnergyBalance([{ timeSec: 0, distKm: 0, speedMS: 10, gradientPct: 0, powerW: 200 }], params)).toHaveLength(0);
  });

  it('la gravità contribuisce positivamente in salita, negativamente in discesa (a parità di velocità)', () => {
    const speedMS = 8;
    const uphill = computeEnergyBalance(
      [
        { timeSec: 0, distKm: 0, speedMS, gradientPct: 6, powerW: 250 },
        { timeSec: 1, distKm: 0.008, speedMS, gradientPct: 6, powerW: 250 }
      ],
      params
    );
    const downhill = computeEnergyBalance(
      [
        { timeSec: 0, distKm: 0, speedMS, gradientPct: -6, powerW: 250 },
        { timeSec: 1, distKm: 0.008, speedMS, gradientPct: -6, powerW: 250 }
      ],
      params
    );
    expect(uphill[0]!.gravPowerW).toBeGreaterThan(0);
    expect(downhill[0]!.gravPowerW).toBeLessThan(0);
    // speedFromPower usato solo per assicurarsi che l'import non sia inutilizzato/rotto.
    expect(speedFromPower(250, 0, params)).toBeGreaterThan(0);
  });
});
