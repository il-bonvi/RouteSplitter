import { describe, it, expect } from 'vitest';
import { sectionsToCsv, planVsActualSectionsToCsv, planVsActualFineGridToCsv, energyBalanceToCsv } from '../../src/lib/exportCsv.js';
import { computeSections, processRoute, powerFromSpeed, type SectionBreakpoint, type PhysicsParams, type CdaSample } from '@physics-core';
import { computePlanVsActualSections, computePlanVsActualFineGrid } from '../../src/lib/planVsActual.js';
import { computeActivityEnergyBalance } from '../../src/lib/energyBalance.js';
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

function flatRoute(distanceKm: number, n = 200) {
  const raw = Array.from({ length: n }, (_, i) => ({
    lat: 45.0 + (i / (n - 1)) * (distanceKm / 111),
    lon: 11.0,
    ele: 100
  }));
  return processRoute(raw).points;
}

/** Stessa fixture sintetica di test/lib/planVsActual.test.ts: uscita a velocità costante con
 * potenza fisicamente coerente, per generare righe/bin con dati "reali" popolati. */
function syntheticActivity(distanceKm: number, speedKmh: number, n = 400): { points: ActivityDisplayPoint[]; samples: CdaSample[] } {
  const speedMS = speedKmh / 3.6;
  const powerW = powerFromSpeed(speedMS, 0, params);
  const points: ActivityDisplayPoint[] = [];
  const samples: CdaSample[] = [];
  for (let i = 0; i < n; i++) {
    const distKm = (i / (n - 1)) * distanceKm;
    const distM = distKm * 1000;
    const timeSec = distM / speedMS;
    points.push({ lat: 45.0 + distKm / 111, lon: 11.0, ele: 100, dist: distM, gradient: 0, powerW, speedKmh, timeSec });
    if (i > 0) samples.push({ speedMS, powerW, gradientPct: 0, distKm });
  }
  return { points, samples };
}

const pvaBreakpoints: SectionBreakpoint[] = [
  { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
  { id: 'mid', distKm: 10, fixed: false, sectionLabel: 'S1', speedKmh: 30, powerWatts: null },
  { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'S2', speedKmh: 30, powerWatts: null }
];

describe('sectionsToCsv', () => {
  it('produce una riga di header + una riga per sezione', () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({ lat: 45.0 + i * 0.001, lon: 11.0, ele: 100 }));
    const points = processRoute(raw).points;
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'mid', distKm: 1, fixed: false, sectionLabel: 'S1', speedKmh: 35, powerWatts: null },
      { id: 'finish', distKm: 2, fixed: 'finish', sectionLabel: 'S2', speedKmh: 40, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'speed');
    const csv = sectionsToCsv(sections);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1 + sections.length);
    expect(lines[0]).toContain('Distanza (km)');
  });

  it('mette tra virgolette i nomi sezione con la virgola', () => {
    const raw = Array.from({ length: 5 }, (_, i) => ({ lat: 45.0 + i * 0.001, lon: 11.0, ele: 100 }));
    const points = processRoute(raw).points;
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 0.4, fixed: 'finish', sectionLabel: 'Salita, tratto duro', speedKmh: 20, powerWatts: null }
    ];
    const sections = computeSections(breakpoints, points, params, 'speed');
    const csv = sectionsToCsv(sections);
    expect(csv).toContain('"Salita, tratto duro"');
  });
});

describe('planVsActualSectionsToCsv', () => {
  it('produce una riga di header + una riga per sezione, con valori reali/verificati popolati', () => {
    const points = flatRoute(20);
    const { points: activityPoints, samples } = syntheticActivity(20, 24); // più lento del piano (30)
    const rows = computePlanVsActualSections(pvaBreakpoints, points, params, 'speed', 250, undefined, null, activityPoints, samples);
    const csv = planVsActualSectionsToCsv(rows);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(1 + rows.length);
    expect(lines[0]).toContain('Vel. verificata - pot.reale (km/h)');
    // Riga dati: la velocità reale (~24) deve comparire, non solo quella pianificata (~30)
    expect(lines[1]).toContain('24.0');
  });

  it('mette tra virgolette i nomi sezione con la virgola', () => {
    const points = flatRoute(20);
    const { points: activityPoints, samples } = syntheticActivity(20, 30);
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: 'Salita, tratto duro', speedKmh: 30, powerWatts: null }
    ];
    const rows = computePlanVsActualSections(breakpoints, points, params, 'speed', 250, undefined, null, activityPoints, samples);
    const csv = planVsActualSectionsToCsv(rows);
    expect(csv).toContain('"Salita, tratto duro"');
  });

  it('lascia la cella vuota (non "null"/"undefined") quando manca il dato reale', () => {
    const points = flatRoute(20);
    const rows = computePlanVsActualSections(pvaBreakpoints, points, params, 'speed', 250, undefined, null, [], []);
    const csv = planVsActualSectionsToCsv(rows);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });
});

describe('planVsActualFineGridToCsv', () => {
  it('produce una riga di header + una riga per bin, con pendenza e quota incluse', () => {
    const points = flatRoute(20);
    const { points: activityPoints, samples } = syntheticActivity(20, 24);
    void activityPoints;
    const grid = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, undefined, 20, samples, 1);
    const csv = planVsActualFineGridToCsv(grid);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(1 + grid.length);
    expect(lines[0]).toContain('Pendenza (%)');
    expect(lines[0]).toContain('Quota (m)');
    expect(lines[0]).toContain('Vel. verificata - pot.reale (km/h)');
    // Con dati reali su un'uscita lunga, almeno un bin deve avere il valore verificato popolato
    // (non solo header vuoto) — prova che la colonna porta davvero un numero, non solo un'etichetta.
    expect(grid.some(p => p.verifiedSpeedKmh != null)).toBe(true);
  });

  it('lascia la cella vuota quando manca il dato reale nel bin', () => {
    const points = flatRoute(20);
    const grid = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, undefined, 20, [], 1);
    const csv = planVsActualFineGridToCsv(grid);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('segnala "SI" nella colonna Probabile frenata per un bin di frenata evidente', () => {
    const descPoints = processRoute(
      Array.from({ length: 200 }, (_, i) => ({ lat: 45.0 + (i / 199) * (20 / 111), lon: 11.0, ele: 300 - i * 1.2 }))
    ).points;
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: null, speedKmh: 30, powerWatts: null }
    ];
    // Attività sintetica lenta (24 km/h) ma con potenza alta su un percorso in discesa
    // ripida: la velocità "verificata" (dalla potenza reale) risulta molto più alta della
    // reale → il primo bin deve scattare come probabile frenata.
    const samples: CdaSample[] = Array.from({ length: 50 }, (_, i) => ({ speedMS: 24 / 3.6, powerW: 300, gradientPct: -8, distKm: (i / 49) * 2 }));
    const grid = computePlanVsActualFineGrid(breakpoints, descPoints, params, 'speed', 250, undefined, 20, samples, 1);
    const csv = planVsActualFineGridToCsv(grid);
    expect(csv).toContain('SI');
  });

  it('NON segnala come frenata un bin che segue una partenza da fermo', () => {
    const descPoints = processRoute(
      Array.from({ length: 200 }, (_, i) => ({ lat: 45.0 + (i / 199) * (20 / 111), lon: 11.0, ele: 300 - i * 1.2 }))
    ).points;
    const breakpoints: SectionBreakpoint[] = [
      { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
      { id: 'finish', distKm: 20, fixed: 'finish', sectionLabel: null, speedKmh: 30, powerWatts: null }
    ];
    // Primo bin: velocità reale ~0 (fermo al via). Secondo bin: stesso sintomo "reale molto
    // sotto verificata" del test sopra, ma stavolta è una partenza da fermo, non una frenata.
    const samples: CdaSample[] = [
      { speedMS: 0.3, powerW: 300, gradientPct: -8, distKm: 0.05 },
      { speedMS: 24 / 3.6, powerW: 300, gradientPct: -8, distKm: 0.15 }
    ];
    const grid = computePlanVsActualFineGrid(breakpoints, descPoints, params, 'speed', 250, undefined, 20, samples, 0.1);
    const csv = planVsActualFineGridToCsv(grid);
    const lines = csv.split('\n');
    // Il secondo bin (indice riga 2, dopo l'header) non deve avere "SI".
    expect(lines[2]).not.toContain(',SI');
  });
});

describe('energyBalanceToCsv', () => {
  it('produce una riga di header + una riga per intervallo', () => {
    const speedKmh = 30;
    const speedMS = speedKmh / 3.6;
    const powerW = powerFromSpeed(speedMS, 0, params);
    const points: ActivityDisplayPoint[] = Array.from({ length: 10 }, (_, i) => ({
      lat: 45,
      lon: 11,
      ele: 100,
      dist: i * speedMS,
      gradient: 0,
      powerW,
      speedKmh,
      timeSec: i
    }));
    const rows = computeActivityEnergyBalance(points, params, { smoothingSeconds: 0 });
    const csv = energyBalanceToCsv(rows);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1 + rows.length);
    expect(lines[0]).toContain('Residuo (J');
  });

  it('con nessuna riga produce solo l\'header', () => {
    const csv = energyBalanceToCsv([]);
    expect(csv.split('\n')).toHaveLength(1);
  });
});
