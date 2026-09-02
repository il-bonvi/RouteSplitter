import { describe, it, expect } from 'vitest';
import { simulateDynamicPacing, aggregateDynamicSimulationBySection, totalDynamicSimTimeHours, type DynamicSimSegment } from '../../src/physics-core/dynamicSimulation.js';
import { speedFromPower, processRoute, type PhysicsParams, type SectionBreakpoint } from '../../src/physics-core/index.js';

const params: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

/** Percorso pianeggiante lungo `km` chilometri, punti ogni ~10m. */
function flatRoute(km: number) {
  const n = Math.max(50, Math.round((km * 1000) / 10));
  return processRoute(
    Array.from({ length: n }, (_, i) => ({ lat: 45.0 + (i / (n - 1)) * (km / 111), lon: 11.0, ele: 100 }))
  ).points;
}

describe('simulateDynamicPacing', () => {
  it('su un tratto lungo, piatto, a potenza costante converge alla velocità di equilibrio classica', () => {
    const points = flatRoute(10);
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 10, targetPowerW: 250 }];
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 8 });
    const expectedEquilibriumMS = speedFromPower(250, 0, params);
    // Dopo un tratto lungo la velocità simulata deve avvicinarsi molto all'equilibrio classico
    // (stesso risultato di speedFromPower) — il motore dinamico non è "un'altra fisica", è la
    // stessa fisica integrata nel tempo, deve convergere allo stesso punto fisso.
    const lastFew = steps.slice(-20).map(s => s.speedMS);
    const avgLast = lastFew.reduce((a, b) => a + b, 0) / lastFew.length;
    expect(avgLast).toBeCloseTo(expectedEquilibriumMS, 1);
  });

  it('con velocità iniziale già di equilibrio, resta stabile (nessuna oscillazione spuria)', () => {
    const points = flatRoute(5);
    const eqMS = speedFromPower(250, 0, params);
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 5, targetPowerW: 250 }];
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: eqMS });
    for (const s of steps) {
      expect(s.speedMS).toBeCloseTo(eqMS, 1);
    }
  });

  it('la partenza da fermo mostra un\'accelerazione graduale, non un salto istantaneo alla velocità di equilibrio', () => {
    const points = flatRoute(5);
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 5, targetPowerW: 250 }];
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 0 });
    const eqMS = speedFromPower(250, 0, params);
    expect(steps[0]!.speedMS).toBe(0);
    // Dopo 1 solo secondo NON deve essere già alla velocità di equilibrio: è la differenza
    // strutturale che motiva tutto questo lavoro (il modello a equilibrio ci "sarebbe" già).
    expect(steps[1]!.speedMS).toBeLessThan(eqMS * 0.5);
    // Ma dopo un tratto lungo a sufficienza, deve comunque arrivarci.
    const last = steps[steps.length - 1]!.speedMS;
    expect(last).toBeGreaterThan(eqMS * 0.9);
  });

  it('un cambio di pendenza (pianura poi salita ripida) rallenta gradualmente, non istantaneamente', () => {
    // Percorso piatto per 2km poi all'8% per 1km.
    const n1 = 200,
      n2 = 100;
    const flat = Array.from({ length: n1 }, (_, i) => ({ lat: 45.0 + (i / n1) * (2 / 111), lon: 11.0, ele: 100 }));
    const climbStart = 45.0 + 2 / 111;
    const climb = Array.from({ length: n2 }, (_, i) => ({ lat: climbStart + (i / n2) * (1 / 111), lon: 11.0, ele: 100 + (i / n2) * 1000 * 0.08 }));
    const points = processRoute([...flat, ...climb]).points;
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 3, targetPowerW: 250 }];
    const eqFlatMS = speedFromPower(250, 0, params);
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: eqFlatMS });

    // Appena dopo l'inizio della salita (poco oltre i 2km), la velocità deve essere ancora
    // vicina a quella di pianura (inerzia: non crolla di colpo al nuovo equilibrio in salita).
    const justAfterClimbStart = steps.find(s => s.distKm > 2.02);
    expect(justAfterClimbStart).toBeDefined();
    expect(justAfterClimbStart!.speedMS).toBeGreaterThan(eqFlatMS * 0.7);

    // Ma verso la fine del tratto in salita, deve essersi avvicinata al nuovo equilibrio (più
    // basso) — l'inerzia rallenta la transizione, non la annulla per sempre.
    const eqClimbMS = speedFromPower(250, 8, params);
    const nearEnd = steps[steps.length - 1]!;
    expect(nearEnd.speedMS).toBeLessThan(eqFlatMS);
    expect(nearEnd.speedMS).toBeCloseTo(eqClimbMS, 0);
  });

  it('con segmenti vuoti restituisce un array vuoto', () => {
    expect(simulateDynamicPacing([], flatRoute(1), params)).toEqual([]);
  });
});

describe('aggregateDynamicSimulationBySection', () => {
  it('produce un risultato per ogni tratto fra breakpoint, con distanza coerente', () => {
    const points = flatRoute(10);
    const segments: DynamicSimSegment[] = [
      { d0Km: 0, d1Km: 5, targetPowerW: 200 },
      { d0Km: 5, d1Km: 10, targetPowerW: 280 }
    ];
    const breakpoints: SectionBreakpoint[] = [
      { id: 'a', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'b', distKm: 5, fixed: false, sectionLabel: null, speedKmh: null, powerWatts: 200 },
      { id: 'c', distKm: 10, fixed: 'finish', sectionLabel: null, speedKmh: null, powerWatts: 280 }
    ];
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 8 });
    const bySection = aggregateDynamicSimulationBySection(steps, breakpoints, 1);
    expect(bySection).toHaveLength(2);
    expect(bySection[0]!.distanceKm).toBeCloseTo(5, 5);
    expect(bySection[1]!.distanceKm).toBeCloseTo(5, 5);
    // Il secondo tratto ha potenza target più alta → velocità media più alta (pianura in
    // entrambi i casi in questo test).
    expect(bySection[1]!.avgPowerWatts).toBeGreaterThan(bySection[0]!.avgPowerWatts);
  });
});

describe('totalDynamicSimTimeHours', () => {
  it('coincide con n_passi * dt', () => {
    const points = flatRoute(5);
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 5, targetPowerW: 250 }];
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 8 });
    expect(totalDynamicSimTimeHours(steps, 1)).toBeCloseTo((steps.length * 1) / 3600, 6);
  });

  it('con array vuoto restituisce 0', () => {
    expect(totalDynamicSimTimeHours([])).toBe(0);
  });
});
