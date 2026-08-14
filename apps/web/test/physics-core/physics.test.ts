import { describe, it, expect } from 'vitest';
import { wheelPowerAtSpeed, speedFromPower, powerFromSpeed, estimateCda, GRAVITY } from '../../src/physics-core/physics.js';
import type { PhysicsParams } from '../../src/physics-core/types.js';

const baseParams: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

describe('wheelPowerAtSpeed — caso di riferimento verificabile a mano', () => {
  it('in piano, senza vento, corrisponde alla somma di aero + rolling', () => {
    const speedMS = 10; // 36 km/h
    const m = baseParams.riderMassKg + baseParams.bikeMassKg;
    const expectedAero = 0.5 * baseParams.airDensity * baseParams.cda * speedMS * speedMS;
    const expectedRoll = baseParams.crr * m * GRAVITY;
    const expectedWheelPower = (expectedAero + expectedRoll) * speedMS;
    expect(wheelPowerAtSpeed(speedMS, 0, baseParams)).toBeCloseTo(expectedWheelPower, 3);
  });

  it('la potenza richiesta cresce con la pendenza', () => {
    const p0 = wheelPowerAtSpeed(10, 0, baseParams);
    const p5 = wheelPowerAtSpeed(10, 5, baseParams);
    const pMinus5 = wheelPowerAtSpeed(10, -5, baseParams);
    expect(p5).toBeGreaterThan(p0);
    expect(pMinus5).toBeLessThan(p0);
  });
});

describe('fix segno drag aerodinamico (rel*|rel| invece di rel*rel)', () => {
  it('con vento in coda più forte della velocità di marcia, il termine aerodinamico assiste (è negativo)', () => {
    // ciclista a 2 m/s (7.2 km/h, salita ripida e lenta), vento in coda fortissimo: windKmh negativo, |vento| > velocità
    const params: PhysicsParams = { ...baseParams, windKmh: -30, crr: 0, cda: 0.3, riderMassKg: 0, bikeMassKg: 0 };
    // annullo rolling e gravità (massa 0, pendenza 0) per isolare il solo termine aerodinamico
    const wheelPower = wheelPowerAtSpeed(2, 0, params);
    // rel = 2 + (-30/3.6) = 2 - 8.33 = -6.33 → l'aria dovrebbe spingere, quindi wheelPower (tutto aero qui) deve essere negativo
    expect(wheelPower).toBeLessThan(0);
  });

  it('senza vento, il comportamento non cambia rispetto alla versione non firmata (rel sempre positivo)', () => {
    const noWind: PhysicsParams = { ...baseParams, windKmh: 0 };
    const speedMS = 12;
    const power = wheelPowerAtSpeed(speedMS, 0, noWind);
    // rel = speedMS puro (positivo): rel*|rel| == rel*rel in questo caso, nessuna differenza attesa
    const expectedAero = 0.5 * noWind.airDensity * noWind.cda * speedMS * speedMS;
    const m = noWind.riderMassKg + noWind.bikeMassKg;
    const expectedRoll = noWind.crr * m * GRAVITY;
    expect(power).toBeCloseTo((expectedAero + expectedRoll) * speedMS, 3);
  });
});

describe('speedFromPower <-> powerFromSpeed — round trip', () => {
  it('la potenza richiesta per la velocità ottenuta da una data potenza torna al valore di partenza', () => {
    for (const grade of [-8, -2, 0, 3, 8, 12]) {
      for (const power of [100, 180, 250, 320]) {
        const v = speedFromPower(power, grade, baseParams);
        const backPower = powerFromSpeed(v, grade, baseParams);
        expect(backPower).toBeCloseTo(power, 0); // tolleranza 0.5W circa
      }
    }
  });

  it('converge alla velocità di equilibrio "a ruota libera" in discesa ripida con potenza 0', () => {
    const v = speedFromPower(0, -8, baseParams);
    expect(v).toBeGreaterThan(0);
    // a quella velocità la potenza richiesta calcolata da powerFromSpeed deve essere ~0
    expect(powerFromSpeed(v, -8, baseParams)).toBeCloseTo(0, 0);
  });
});

describe('estimateCda — inversione coerente con wheelPowerAtSpeed', () => {
  it('recupera il CdA noto da un campione sintetico generato con lo stesso modello', () => {
    const trueCda = 0.31;
    const params: PhysicsParams = { ...baseParams, cda: trueCda };
    const speedMS = 11; // ~40 km/h
    const grade = 1.5;
    const power = powerFromSpeed(speedMS, grade, params);
    const estimated = estimateCda(speedMS, power, grade, params);
    expect(estimated).not.toBeNull();
    expect(estimated!).toBeCloseTo(trueCda, 2);
  });

  it('ritorna null se la forza aerodinamica implicita è negativa o nulla (dati non validi)', () => {
    // potenza bassissima su una salita ripida: non è fisicamente coerente stimare CdA da qui
    const estimated = estimateCda(8, 15, 15, baseParams);
    expect(estimated).toBeNull();
  });
});
