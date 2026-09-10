import { describe, it, expect } from 'vitest';
import {
  simulateDynamicPacing,
  aggregateDynamicSimulationBySection,
  totalDynamicSimTimeHours,
  computeDynamicSections,
  refinePacingWithDynamicSimulation,
  optimizePacingDynamic,
  normalizedPowerFromSteps,
  avgPowerFromSteps,
  computeWBalFromSteps,
  minWBalJ,
  type DynamicSimSegment,
  type DynamicSimStep
} from '../../src/physics-core/dynamicSimulation.js';
import { speedFromPower, processRoute, computeSections, makeUniformWindZones, type PhysicsParams, type SectionBreakpoint } from '../../src/physics-core/index.js';

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

/** Percorso con un tratto in salita al 6% fra 3km e 6km, piatto prima e dopo (10km totali) —
 * usato per i test di raffinamento dinamico: su un percorso interamente piatto l'equilibrio
 * classico è già ottimo ovunque, non c'è margine di miglioramento da mostrare. */
function hillyRoute() {
  const totalKm = 10;
  const n = 1000;
  const points = [];
  for (let i = 0; i < n; i++) {
    const km = (i / (n - 1)) * totalKm;
    let ele = 100;
    if (km > 3 && km <= 6) ele = 100 + (km - 3) * 1000 * 0.06;
    else if (km > 6) ele = 100 + 3 * 1000 * 0.06;
    points.push({ lat: 45.0, lon: 11.0 + km / 111, ele });
  }
  return processRoute(points).points;
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

  it('senza windZones si comporta come prima (vento scalare params.windKmh)', () => {
    const points = flatRoute(5);
    const windyParams: PhysicsParams = { ...params, windKmh: 15 };
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 5, targetPowerW: 250 }];
    const steps = simulateDynamicPacing(segments, points, windyParams, { dtSec: 1, initialSpeedMS: 8 });
    const expectedEquilibriumMS = speedFromPower(250, 0, windyParams);
    const avgLast = steps.slice(-20).reduce((a, s) => a + s.speedMS, 0) / 20;
    expect(avgLast).toBeCloseTo(expectedEquilibriumMS, 1);
  });

  it('con windZones configurate, converge alla velocità di equilibrio col vento in testa efficace, non a quella scalare', () => {
    // Percorso rettilineo verso nord (bearing ~0°): un vento che soffia da nord (directionDeg=0)
    // è puro vento in testa per l'intera rotta.
    const points = flatRoute(10);
    const windZones = makeUniformWindZones(10, 20, 0);
    const segments: DynamicSimSegment[] = [{ d0Km: 0, d1Km: 10, targetPowerW: 250 }];
    const steps = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 5, windZones });
    const expectedHeadwindMS = speedFromPower(250, 0, { ...params, windKmh: 20 });
    const avgLast = steps.slice(-20).reduce((a, s) => a + s.speedMS, 0) / 20;
    // Deve avvicinarsi all'equilibrio CON vento (più lento), non a quello senza vento
    // (params.windKmh resta 0 in questo test — se il vento a zona venisse ignorato la
    // convergenza sarebbe a una velocità più alta).
    expect(avgLast).toBeCloseTo(expectedHeadwindMS, 1);
    const noWindMS = speedFromPower(250, 0, params);
    expect(avgLast).toBeLessThan(noWindMS - 1);
  });
});

describe('computeDynamicSections', () => {
  const breakpoints: SectionBreakpoint[] = [
    { id: 'a', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
    { id: 'b', distKm: 5, fixed: false, sectionLabel: null, speedKmh: null, powerWatts: 200 },
    { id: 'c', distKm: 10, fixed: 'finish', sectionLabel: null, speedKmh: null, powerWatts: 280 }
  ];

  it('restituisce la stessa forma/geometria di computeSections (distanza, D+/D-, pendenza, CdA), diversi solo i campi tempo-dipendenti', () => {
    const points = flatRoute(10);
    const classic = computeSections(breakpoints, points, params, 'power', 250);
    const dynamic = computeDynamicSections(breakpoints, points, params, 'power', 250);
    expect(dynamic).toHaveLength(classic.length);
    for (let i = 0; i < classic.length; i++) {
      expect(dynamic[i]!.distanceKm).toBeCloseTo(classic[i]!.distanceKm, 6);
      expect(dynamic[i]!.gradient).toBeCloseTo(classic[i]!.gradient, 6);
      expect(dynamic[i]!.cdaUsed).toBeCloseTo(classic[i]!.cdaUsed, 6);
      expect(dynamic[i]!.powerWatts).toBeCloseTo(classic[i]!.powerWatts, 6);
    }
  });

  it('su un piano che parte da fermo, il tempo totale dinamico è sempre ≥ quello classico (l\'inerzia non può far risparmiare tempo rispetto a un ipotetico equilibrio istantaneo)', () => {
    const points = flatRoute(10);
    const classic = computeSections(breakpoints, points, params, 'power', 250);
    const dynamic = computeDynamicSections(breakpoints, points, params, 'power', 250);
    const classicTotal = classic[classic.length - 1]!.cumTimeHours;
    const dynamicTotal = dynamic[dynamic.length - 1]!.cumTimeHours;
    expect(dynamicTotal).toBeGreaterThanOrEqual(classicTotal);
  });

  it('i cumulati sono coerenti (distanza cumulata dell\'ultima sezione = distanza totale, tempo cumulato crescente)', () => {
    const points = flatRoute(10);
    const dynamic = computeDynamicSections(breakpoints, points, params, 'power', 250);
    expect(dynamic[dynamic.length - 1]!.cumDistKm).toBeCloseTo(10, 3);
    expect(dynamic[1]!.cumTimeHours).toBeGreaterThan(dynamic[0]!.cumTimeHours);
  });

  it('rispetta le zone vento (stesso test di convergenza sopra, ma passando per computeDynamicSections)', () => {
    const points = flatRoute(10);
    const windZones = makeUniformWindZones(10, 20, 0);
    const flatBreakpoints: SectionBreakpoint[] = [
      { id: 'a', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'b', distKm: 10, fixed: 'finish', sectionLabel: null, speedKmh: null, powerWatts: 250 }
    ];
    const withWind = computeDynamicSections(flatBreakpoints, points, params, 'power', 250, windZones);
    const withoutWind = computeDynamicSections(flatBreakpoints, points, params, 'power', 250);
    // Stesso piano, stessa potenza: con vento in testa configurato il tempo deve essere
    // maggiore — se le zone vento venissero ignorate i due risultati sarebbero identici.
    expect(withWind[0]!.timeHours).toBeGreaterThan(withoutWind[0]!.timeHours * 1.05);
  });

  it('con array di breakpoint vuoto/degenere restituisce array vuoto', () => {
    expect(computeDynamicSections([breakpoints[0]!], flatRoute(1), params, 'power', 250)).toEqual([]);
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

describe('refinePacingWithDynamicSimulation', () => {
  // 3 sezioni: piano (0-3km) / salita 6% (3-6km) / piano (6-10km). Partenza da un'allocazione
  // UNIFORME (stessa potenza ovunque, come farebbe una scelta ingenua) — c'è margine reale
  // per il raffinamento: spostare potenza dal piano/discesa verso la salita è quasi sempre
  // vantaggioso in tempo totale (letteratura sul pacing variabile), e QUI in più con partenza
  // da fermo, l'inerzia rende costoso ripartire più volte a potenza bassa dopo essere rallentati.
  const boundaries = [
    { d0Km: 0, d1Km: 3 },
    { d0Km: 3, d1Km: 6 },
    { d0Km: 6, d1Km: 10 }
  ];

  it('con un piano già ragionevole (potenza più alta in salita), non peggiora mai il tempo totale', () => {
    const points = hillyRoute();
    const initialPowers = [200, 280, 200]; // già "sensato": più watt in salita
    const result = refinePacingWithDynamicSimulation(boundaries, initialPowers, points, params, {
      minPower: 100,
      maxPower: 400,
      maxTrials: 150
    });
    expect(result.totalTimeHours).toBeLessThanOrEqual(result.startingTimeHours + 1e-9);
  });

  it('con un\'allocazione uniforme (ingenua), il raffinamento trova un tempo totale migliore', () => {
    const points = hillyRoute();
    const initialPowers = [227, 227, 227]; // stessa media (227) ma piatta, non sfrutta la salita
    const result = refinePacingWithDynamicSimulation(boundaries, initialPowers, points, params, {
      minPower: 100,
      maxPower: 400,
      maxTrials: 200
    });
    expect(result.totalTimeHours).toBeLessThan(result.startingTimeHours);
    expect(result.trialsAccepted).toBeGreaterThan(0);
  });

  it('preserva la potenza media (i trasferimenti fra sezioni non cambiano la somma)', () => {
    const points = hillyRoute();
    const initialPowers = [227, 227, 227];
    const result = refinePacingWithDynamicSimulation(boundaries, initialPowers, points, params, {
      minPower: 100,
      maxPower: 400,
      maxTrials: 200
    });
    const sumInitial = initialPowers.reduce((a, b) => a + b, 0);
    const sumFinal = result.powers.reduce((a, b) => a + b, 0);
    expect(sumFinal).toBe(sumInitial);
  });

  it('rispetta sempre i limiti [minPower, maxPower]', () => {
    const points = hillyRoute();
    const initialPowers = [150, 150, 150];
    const result = refinePacingWithDynamicSimulation(boundaries, initialPowers, points, params, {
      minPower: 100,
      maxPower: 200,
      maxTrials: 300
    });
    for (const p of result.powers) {
      expect(p).toBeGreaterThanOrEqual(100);
      expect(p).toBeLessThanOrEqual(200);
    }
  });

  it('è deterministico a parità di seed (stesso piano → stesso risultato, non rumore casuale)', () => {
    const points = hillyRoute();
    const initialPowers = [227, 227, 227];
    const r1 = refinePacingWithDynamicSimulation(boundaries, initialPowers, points, params, {
      minPower: 100,
      maxPower: 400,
      maxTrials: 150,
      seed: 42
    });
    const r2 = refinePacingWithDynamicSimulation(boundaries, initialPowers, points, params, {
      minPower: 100,
      maxPower: 400,
      maxTrials: 150,
      seed: 42
    });
    expect(r2.powers).toEqual(r1.powers);
    expect(r2.totalTimeHours).toBe(r1.totalTimeHours);
  });

  it('con un array di potenze vuoto o degenere non fa nulla e non crasha', () => {
    const points = hillyRoute();
    const result = refinePacingWithDynamicSimulation([], [], points, params, { minPower: 100, maxPower: 400 });
    expect(result.powers).toEqual([]);
    const single = refinePacingWithDynamicSimulation([{ d0Km: 0, d1Km: 10 }], [220], points, params, {
      minPower: 100,
      maxPower: 400
    });
    expect(single.powers).toEqual([220]);
    expect(single.trialsAccepted).toBe(0);
  });
});

describe('optimizePacingDynamic (rimpiazza l\'ottimizzatore classico "per microsezioni" — nessuna chiamata a speedFromPower/equilibrio, solo geometria + simulazione vera)', () => {
  // Stesso percorso piano/salita 6%/piano, ma qui a grana fine (3 tratti larghi, uno per
  // regione) — il seed geometrico deve già mettere più watt sulla salita senza bisogno di
  // nessun raffinamento, essendo `slopeSensitivity` esplicitamente basato sulla pendenza.
  const boundaries = [
    { d0Km: 0, d1Km: 3, gradient: 0 },
    { d0Km: 3, d1Km: 6, gradient: 6 },
    { d0Km: 6, d1Km: 10, gradient: 0 }
  ];

  it('mette più watt sul tratto in salita rispetto a quelli in piano, a parità di media', () => {
    const points = hillyRoute();
    const result = optimizePacingDynamic(boundaries, points, params, { targetAvgPower: 220, minPower: 100, maxPower: 400 });
    expect(result.powers).toHaveLength(3);
    expect(result.powers[1]!).toBeGreaterThan(result.powers[0]!);
    expect(result.powers[1]!).toBeGreaterThan(result.powers[2]!);
  });

  it('la potenza media riportata (calcolata dalla simulazione vera) è vicina al target richiesto', () => {
    const points = hillyRoute();
    const result = optimizePacingDynamic(boundaries, points, params, { targetAvgPower: 220, minPower: 100, maxPower: 400 });
    // `rescalePowersToTargetAvg` tratta il target come vincolo quasi-duro: la media VERA
    // (pesata sul tempo simulato, quella mostrata in UI) deve avvicinarsi al target entro
    // pochi watt, non solo restare "nello stesso ordine di grandezza" come prima del fix.
    expect(Math.abs(result.timeWeightedAvgPower - 220)).toBeLessThan(3);
  });

  it('BUG REGRESSION: con tratti di lunghezza DISUGUALE (il caso reale — i breakpoint di un piano non hanno quasi mai la stessa distanza), la media vera resta vicina al target anche dopo il raffinamento', () => {
    // Prima del fix (rescalePowersToTargetAvg): il seed geometrico centra solo la media
    // pesata sulla DISTANZA, non quella pesata sul TEMPO che l'utente vede; il raffinamento a
    // trasferimenti poi preserva la SOMMA aritmetica delle potenze, che coincide con la media
    // pesata-distanza solo se i tratti hanno tutti la stessa lunghezza (non è il caso qui, di
    // proposito) — risultato osservato in produzione: target 230W → media riportata 242W.
    const points = hillyRoute();
    const unequalBoundaries = [
      { d0Km: 0, d1Km: 3, gradient: 0 },
      { d0Km: 3, d1Km: 4, gradient: 3 },
      { d0Km: 4, d1Km: 6, gradient: 6 },
      { d0Km: 6, d1Km: 6.5, gradient: 0 },
      { d0Km: 6.5, d1Km: 10, gradient: 0 }
    ];
    const target = 230;
    const result = optimizePacingDynamic(unequalBoundaries, points, params, { targetAvgPower: target, minPower: 100, maxPower: 400 });
    expect(Math.abs(result.timeWeightedAvgPower - target)).toBeLessThan(3);
  });

  it('con un NP target, il risultato rispetta il LIMITE (non è un target simmetrico: stare sotto va benissimo)', () => {
    // Qui serve una griglia più fine (20 tratti) rispetto al test sopra: con solo 3 tratti e
    // un budget generoso di tentativi, il raffinamento esplora quasi tutto lo spazio libero e
    // finisce per convergere allo stesso ottimo-tempo indipendentemente dal seed, "cancellando"
    // l'effetto della scelta di slopeSensitivity — su una griglia più fine (più vicina all'uso
    // reale, "Ottimizza completo") lo spazio è troppo grande per essere coperto per intero dal
    // budget di tentativi, quindi la forma iniziale data dal seed pesa di più sul risultato.
    const points = hillyRoute();
    const fineBoundaries = Array.from({ length: 20 }, (_, i) => {
      const d0 = i * 0.5;
      const d1 = d0 + 0.5;
      const mid = (d0 + d1) / 2;
      const gradient = mid > 3 && mid <= 6 ? 6 : 0;
      return { d0Km: d0, d1Km: d1, gradient };
    });
    const withoutNpTarget = optimizePacingDynamic(fineBoundaries, points, params, { targetAvgPower: 220, minPower: 100, maxPower: 400 });
    // Il tempo-ottimo "libero" (senza vincolo NP) su un percorso con salita concentra già
    // parecchia potenza lì e poca altrove — un profilo naturalmente "a punte", quindi con NP
    // già piuttosto alta di suo. Un limite DELIBERATAMENTE più basso di quella NP libera è
    // un test più severo (e più corretto) di "il vincolo NP funziona davvero" rispetto a un
    // limite generico più alto, che sarebbe già rispettato per caso dall'ottimo libero.
    const npCeiling = withoutNpTarget.normalizedPower - 15;
    const withNpTarget = optimizePacingDynamic(fineBoundaries, points, params, {
      targetAvgPower: 220,
      targetNormalizedPower: npCeiling,
      minPower: 100,
      maxPower: 400
    });
    // NP target = LIMITE SUPERIORE, non valore da avvicinare simmetricamente: il risultato deve
    // restare vicino al limite o SOTTO, mai ben sopra come nel bug originale.
    expect(withNpTarget.normalizedPower).toBeLessThan(npCeiling + 5);
  });

  it('rispetta sempre i limiti [minPower, maxPower]', () => {
    const points = hillyRoute();
    const result = optimizePacingDynamic(boundaries, points, params, { targetAvgPower: 150, minPower: 100, maxPower: 200 });
    for (const p of result.powers) {
      expect(p).toBeGreaterThanOrEqual(100);
      expect(p).toBeLessThanOrEqual(200);
    }
  });

  it('BUG REGRESSION (D45): con un NP target impostato, la media resta un vincolo quasi-duro anche su una griglia fine (100 tratti) — non solo senza NP target', () => {
    // Prima del fix: la ricerca NP-aware (trasferimenti a coppia) poteva far derivare la media
    // lontano dal target durante l'esplorazione (i trasferimenti preservano la somma
    // aritmetica delle potenze, non la media vera pesata sul tempo), e l'unica correzione
    // finale finiva per disturbare pesantemente l'NP appena raggiunto. Ora la media viene
    // ricentrata ESATTAMENTE ad ogni fine-fase della ricerca, non solo una volta alla fine.
    const points = hillyRoute();
    const nSeg = 100;
    const fineBoundaries = Array.from({ length: nSeg }, (_, i) => {
      const d0 = (i / nSeg) * 10;
      const d1 = ((i + 1) / nSeg) * 10;
      const mid = (d0 + d1) / 2;
      const gradient = mid > 3 && mid <= 6 ? 6 : 0;
      return { d0Km: d0, d1Km: d1, gradient };
    });
    const target = 235;
    const result = optimizePacingDynamic(fineBoundaries, points, params, {
      targetAvgPower: target,
      targetNormalizedPower: 260,
      minPower: 100,
      maxPower: 400
    });
    expect(Math.abs(result.timeWeightedAvgPower - target)).toBeLessThan(3);
  });

  it('BUG REGRESSION (D46): NP target trattato come LIMITE SUPERIORE — su una griglia molto fine (~260 tratti, come "Ottimizza completo" su un piano reale) con salita marcata, l\'NP finale resta entro (o sotto) il limite, non ben oltre come nel bug segnalato dall\'utente (limite 250 → risultato 280)', () => {
    // Segnalato dall'utente con screenshot: media target 230W, NP LIMITE 250W → risultato Media
    // 231W (ok) ma NP ~280W (ben oltre il limite, non solo "vicino"). Causa radice: il motore
    // dinamico è puramente tempo-ottimo rispetto al vincolo di media — su un percorso con
    // salite/discese marcate la strategia tempo-ottima concentra molta più potenza in salita e
    // molto meno altrove (fisicamente corretto per il tempo, ma fisiologicamente insostenibile
    // — lo stesso meccanismo di fondo del bug "bang-bang" già noto, non ancora risolto con un
    // vero modello di fatica CP/W', in coda nella roadmap). Fix: quando l'NP simulata supera il
    // limite, una ricerca binaria trova il fattore di "appiattimento" verso la media più alto
    // (meno invasivo) che riporta l'NP entro il limite — un intervento GLOBALE sull'intero
    // percorso, non trasferimenti locali fra coppie di tratti (due tentativi precedenti in
    // questa sessione, entrambi insufficienti su percorsi senza una vera discesa dove "scaricare"
    // potenza a basso costo in tempo).
    const points = hillyRoute();
    const nSeg = 200;
    const fineBoundaries = Array.from({ length: nSeg }, (_, i) => {
      const d0 = (i / nSeg) * 10;
      const d1 = ((i + 1) / nSeg) * 10;
      const mid = (d0 + d1) / 2;
      const gradient = mid > 3 && mid <= 6 ? 6 : 0;
      return { d0Km: d0, d1Km: d1, gradient };
    });
    const target = 235;
    const npCeiling = 260;
    const result = optimizePacingDynamic(fineBoundaries, points, params, {
      targetAvgPower: target,
      targetNormalizedPower: npCeiling,
      minPower: 100,
      maxPower: 400
    });
    expect(Math.abs(result.timeWeightedAvgPower - target)).toBeLessThan(3);
    expect(result.normalizedPower).toBeLessThan(npCeiling + 5);
  });

  it('con un array di tratti vuoto non crasha', () => {
    const points = hillyRoute();
    const result = optimizePacingDynamic([], points, params, { targetAvgPower: 220, minPower: 100, maxPower: 400 });
    expect(result.powers).toEqual([]);
    expect(result.totalTimeHours).toBe(0);
  });
});

describe('normalizedPowerFromSteps / avgPowerFromSteps (metriche dalla simulazione vera, non stimate)', () => {
  it('con potenza costante, NP e media coincidono con quella costante', () => {
    const steps = Array.from({ length: 120 }, (_, i) => ({ timeSec: i, distKm: i * 0.01, speedMS: 8, gradientPct: 0, powerW: 250 }));
    expect(avgPowerFromSteps(steps)).toBeCloseTo(250, 6);
    expect(normalizedPowerFromSteps(steps)).toBeCloseTo(250, 6);
  });

  it('con potenza variabile, NP è sempre ≥ della media semplice (proprietà nota della formula Coggan)', () => {
    const steps = Array.from({ length: 300 }, (_, i) => ({
      timeSec: i,
      distKm: i * 0.01,
      speedMS: 8,
      gradientPct: 0,
      powerW: i % 60 < 30 ? 150 : 350
    }));
    expect(normalizedPowerFromSteps(steps)).toBeGreaterThanOrEqual(avgPowerFromSteps(steps));
  });

  it('con array vuoto restituisce 0 per entrambe', () => {
    expect(avgPowerFromSteps([])).toBe(0);
    expect(normalizedPowerFromSteps([])).toBe(0);
  });
});

describe('computeWBalFromSteps / minWBalJ (D48: modello di fatica Critical Power / W\', Skiba)', () => {
  const fatigue = { criticalPowerW: 250, wPrimeJ: 20000 };
  const fakeStep = (powerW: number, i: number): DynamicSimStep => ({ timeSec: i, distKm: i * 0.001, speedMS: 8, gradientPct: 0, powerW });

  it('a potenza costante ESATTAMENTE pari a CP, il W\'bal resta al pieno (nessuna scarica, nessuna ricarica)', () => {
    const steps = Array.from({ length: 300 }, (_, i) => fakeStep(fatigue.criticalPowerW, i));
    const wbal = computeWBalFromSteps(steps, fatigue);
    for (const w of wbal) expect(w).toBeCloseTo(fatigue.wPrimeJ, 6);
  });

  it('a potenza costante SOPRA CP, il W\'bal si scarica linearmente: dopo T secondi manca esattamente (P-CP)*T', () => {
    const overCp = 350;
    const durationS = 40;
    const steps = Array.from({ length: durationS }, (_, i) => fakeStep(overCp, i));
    const wbal = computeWBalFromSteps(steps, fatigue);
    const expected = fatigue.wPrimeJ - (overCp - fatigue.criticalPowerW) * durationS;
    expect(wbal[wbal.length - 1]).toBeCloseTo(expected, 1);
  });

  it('un periodo sopra CP seguito da un periodo sotto CP: il W\'bal scende poi risale, senza mai superare il pieno', () => {
    const above = Array.from({ length: 30 }, (_, i) => fakeStep(400, i));
    const below = Array.from({ length: 600 }, (_, i) => fakeStep(150, 30 + i));
    const steps = [...above, ...below];
    const wbal = computeWBalFromSteps(steps, fatigue);
    // minimo raggiunto alla fine della fase sopra-CP
    const minAtEndOfEffort = wbal[29]!;
    expect(minAtEndOfEffort).toBeLessThan(fatigue.wPrimeJ);
    // durante il recupero, il bilancio cresce monotonicamente...
    for (let i = 31; i < wbal.length; i++) expect(wbal[i]!).toBeGreaterThanOrEqual(wbal[i - 1]! - 1e-6);
    // ...ma non supera mai il pieno (il modello di Skiba è asintotico verso W', non lo supera)
    for (const w of wbal) expect(w).toBeLessThanOrEqual(fatigue.wPrimeJ + 1e-6);
  });

  it('minWBalJ trova correttamente il minimo, incluso il caso di array vuoto (0)', () => {
    expect(minWBalJ([])).toBe(0);
    expect(minWBalJ([100, -50, 200, 30])).toBe(-50);
  });
});

describe('optimizePacingDynamic — vincolo di fatica CP/W\' (D48, DURO)', () => {
  function hillySteepRoute() {
    const totalKm = 10;
    const n = 1500;
    const points = [];
    for (let i = 0; i < n; i++) {
      const km = (i / (n - 1)) * totalKm;
      let ele = 100;
      if (km > 2 && km <= 5) ele = 100 + (km - 2) * 1000 * 0.08;
      else if (km > 5) ele = 100 + 3 * 1000 * 0.08;
      points.push({ lat: 45.0, lon: 11.0 + km / 111, ele });
    }
    return processRoute(points).points;
  }
  function fineBoundaries(n: number, totalKm = 10) {
    return Array.from({ length: n }, (_, i) => {
      const d0 = (i / n) * totalKm;
      const d1 = ((i + 1) / n) * totalKm;
      const mid = (d0 + d1) / 2;
      const gradient = mid > 2 && mid <= 5 ? 8 : 0;
      return { d0Km: d0, d1Km: d1, gradient };
    });
  }

  it('senza vincolo di fatica, il piano tempo-ottimo su una salita ripida esaurirebbe abbondantemente il W\' reale (verifica che lo scenario di test sia genuinamente probante)', () => {
    const points = hillySteepRoute();
    const boundaries = fineBoundaries(150);
    const free = optimizePacingDynamic(boundaries, points, params, { targetAvgPower: 230, minPower: 100, maxPower: 400 });
    const steps = simulateDynamicPacing(boundaries.map((b, i) => ({ d0Km: b.d0Km, d1Km: b.d1Km, targetPowerW: free.powers[i]! })), points, params, { dtSec: 1 });
    const wbal = computeWBalFromSteps(steps, { criticalPowerW: 240, wPrimeJ: 20000 });
    expect(minWBalJ(wbal)).toBeLessThan(0);
  });

  it('CON vincolo di fatica, il W\'bal minimo del piano risultante non scende (apprezzabilmente) sotto zero', () => {
    const points = hillySteepRoute();
    const boundaries = fineBoundaries(150);
    const result = optimizePacingDynamic(boundaries, points, params, {
      targetAvgPower: 230,
      minPower: 100,
      maxPower: 400,
      fatigue: { criticalPowerW: 240, wPrimeJ: 20000 }
    });
    expect(result.fatigueInfeasible).toBe(false);
    expect(result.minWBalJ).not.toBeNull();
    expect(result.minWBalJ!).toBeGreaterThanOrEqual(-50);
  });

  it('CON vincolo di fatica, la media resta un vincolo quasi-duro (stessa tolleranza di D44) anche dopo l\'appiattimento per rispettare il W\'bal', () => {
    const points = hillySteepRoute();
    const boundaries = fineBoundaries(150);
    const target = 230;
    const result = optimizePacingDynamic(boundaries, points, params, {
      targetAvgPower: target,
      minPower: 100,
      maxPower: 400,
      fatigue: { criticalPowerW: 240, wPrimeJ: 20000 }
    });
    expect(Math.abs(result.timeWeightedAvgPower - target)).toBeLessThan(3);
  });

  it('quando la media richiesta supera CP per una durata che esaurirebbe comunque il W\' (anche a potenza costante), segnala fatigueInfeasible', () => {
    const points = hillySteepRoute();
    const boundaries = fineBoundaries(150);
    // media 300W, CP 200W, un W' piccolissimo: anche a potenza PERFETTAMENTE costante a 300W
    // (sempre 100W sopra CP) un W' di soli 5000J si esaurisce in appena 50 secondi — ben prima
    // della fine dei 10km del percorso di test.
    const result = optimizePacingDynamic(boundaries, points, params, {
      targetAvgPower: 300,
      minPower: 100,
      maxPower: 400,
      fatigue: { criticalPowerW: 200, wPrimeJ: 5000 }
    });
    expect(result.fatigueInfeasible).toBe(true);
  });

  it('senza `fatigue` nelle constraints, minWBalJ è null e fatigueInfeasible è false (nessun impatto sul comportamento esistente)', () => {
    const points = hillySteepRoute();
    const boundaries = fineBoundaries(150);
    const result = optimizePacingDynamic(boundaries, points, params, { targetAvgPower: 230, minPower: 100, maxPower: 400 });
    expect(result.minWBalJ).toBeNull();
    expect(result.fatigueInfeasible).toBe(false);
  });
});

describe('gradientSmoothingM (D43): finestra di smoothing pendenza configurabile', () => {
  it('con una finestra più larga, un cambio di pendenza netto e localizzato produce una transizione più graduale nella simulazione', () => {
    // Percorso con un gradino di pendenza netto a metà (0% poi improvvisamente 10%).
    const n = 2000;
    const totalKm = 4;
    const raw = Array.from({ length: n }, (_, i) => {
      const km = (i / (n - 1)) * totalKm;
      const ele = km < 2 ? 100 : 100 + (km - 2) * 1000 * 0.1;
      return { lat: 45.0, lon: 11.0 + km / 111, ele };
    });
    const points = processRoute(raw).points;
    const segments = [{ d0Km: 0, d1Km: 4, targetPowerW: 250 }];
    const stepsNarrow = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 8, gradientSmoothingM: 5 });
    const stepsWide = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 8, gradientSmoothingM: 100 });
    // Nella finestra larga, la pendenza "vista" appena PRIMA del gradino netto (a 1.99km,
    // 10m prima) è già parzialmente influenzata dal tratto in salita successivo (media
    // locale, la finestra da 100m arriva a scavalcare il gradino), mentre con una finestra
    // stretta (5m) resta a zero perché non lo raggiunge ancora.
    const idxNarrow = stepsNarrow.findIndex(s => s.distKm >= 1.99);
    const idxWide = stepsWide.findIndex(s => s.distKm >= 1.99);
    expect(idxNarrow).toBeGreaterThanOrEqual(0);
    expect(idxWide).toBeGreaterThanOrEqual(0);
    expect(stepsWide[idxWide]!.gradientPct).toBeGreaterThan(stepsNarrow[idxNarrow]!.gradientPct);
  });

  it('senza specificarla, usa il default storico (comportamento invariato)', () => {
    const points = hillyRoute();
    const segments = [{ d0Km: 0, d1Km: 10, targetPowerW: 250 }];
    const withDefault = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 0 });
    const withExplicitOld = simulateDynamicPacing(segments, points, params, { dtSec: 1, initialSpeedMS: 0, gradientSmoothingM: 10 });
    expect(withDefault.length).toBe(withExplicitOld.length);
    expect(withDefault[withDefault.length - 1]!.distKm).toBeCloseTo(withExplicitOld[withExplicitOld.length - 1]!.distKm, 6);
  });
});
