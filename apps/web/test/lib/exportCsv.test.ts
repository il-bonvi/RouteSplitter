import { describe, it, expect } from 'vitest';
import { sectionsToCsv, planVsActualSectionsToCsv, planVsActualFineGridToCsv, planVsActualFineGridComparisonToCsv, energyBalanceToCsv, energyBalanceComparisonToCsv } from '../../src/lib/exportCsv.js';
import { computeSections, processRoute, powerFromSpeed, type SectionBreakpoint, type PhysicsParams, type CdaSample, type EnergyBalanceRow } from '@physics-core';
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
  it('produce un blocco di metadata (parametri + zone vento) + header + una riga per bin', () => {
    const points = flatRoute(20);
    const { points: activityPoints, samples } = syntheticActivity(20, 24);
    void activityPoints;
    const grid = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, undefined, 20, samples, 1);
    const csv = planVsActualFineGridToCsv(grid, params, undefined);
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));

    expect(lines).toHaveLength(metadataLines.length + 1 + grid.length);
    expect(csv).toContain(`CdA (m²): ${params.cda}`);
    expect(csv).toContain('nessuna zona impostata (vento 0 km/h su tutto il percorso)');
    const headerLine = lines[metadataLines.length]!;
    expect(headerLine).toContain('Pendenza (%)');
    expect(headerLine).toContain('Quota (m)');
    expect(headerLine).toContain('Vel. verificata - pot.reale (km/h)');
    // Con dati reali su un'uscita lunga, almeno un bin deve avere il valore verificato popolato
    // (non solo header vuoto) — prova che la colonna porta davvero un numero, non solo un'etichetta.
    expect(grid.some(p => p.verifiedSpeedKmh != null)).toBe(true);
  });

  it('elenca ogni confine di zona vento con il suo valore numerico, non un\'etichetta generica', () => {
    const points = flatRoute(20);
    const grid = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, undefined, 20, [], 1);
    const windZones = [
      { id: 'a', distKm: 0, fixed: 'start' as const, speedKmh: 12, directionDeg: 90, timeSamples: [], timeSamplesEnabled: true },
      { id: 'b', distKm: 20, fixed: 'finish' as const, speedKmh: 5, directionDeg: 270, timeSamples: [], timeSamplesEnabled: true }
    ];
    const csv = planVsActualFineGridToCsv(grid, params, windZones);
    expect(csv).toContain('confine a 0.00 km: 12 km/h da 90°');
    expect(csv).toContain('confine a 20.00 km: 5 km/h da 270°');
  });

  it('lascia la cella vuota quando manca il dato reale nel bin', () => {
    const points = flatRoute(20);
    const grid = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, undefined, 20, [], 1);
    const csv = planVsActualFineGridToCsv(grid, params, undefined);
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
    const csv = planVsActualFineGridToCsv(grid, params, undefined);
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
    const csv = planVsActualFineGridToCsv(grid, params, undefined);
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));
    // Il secondo bin dati (dopo metadata+header) non deve avere "SI".
    expect(lines[metadataLines.length + 2]).not.toContain(',SI');
  });
});

describe('planVsActualFineGridComparisonToCsv (D71/D72)', () => {
  it('produce metadata (parametri + zone vento reali per entrambi i rami) + header + una riga per bin', () => {
    const points = flatRoute(20);
    const { samples } = syntheticActivity(20, 24);
    const baselineWindZones = [
      { id: 'a', distKm: 0, fixed: 'start' as const, speedKmh: 0, directionDeg: 0, timeSamples: [], timeSamplesEnabled: true }
    ];
    const baseline = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, baselineWindZones, 20, samples, 1);
    const weatherWindZones = [
      { id: 'a', distKm: 0, fixed: 'start' as const, speedKmh: 10, directionDeg: 0, timeSamples: [], timeSamplesEnabled: true },
      { id: 'b', distKm: 20, fixed: 'finish' as const, speedKmh: 10, directionDeg: 0, timeSamples: [], timeSamplesEnabled: true }
    ];
    const withWeather = computePlanVsActualFineGrid(pvaBreakpoints, points, { ...params, airDensity: 1.15 }, 'speed', 250, weatherWindZones, 20, samples, 1);
    const csv = planVsActualFineGridComparisonToCsv(
      baseline,
      withWeather,
      params.airDensity,
      { airDensity: 1.15, windKmh: 10, windDirectionDeg: 0 },
      params,
      baselineWindZones
    );
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));

    expect(lines).toHaveLength(metadataLines.length + 1 + baseline.length);
    // Zone vento REALI del piano (non solo un'etichetta): D72.
    expect(csv).toContain('confine a 0.00 km: 0 km/h da 0°');
    expect(csv).toContain('10 km/h da 0°');
    expect(csv).toContain('1.150');
    expect(csv).toContain(params.airDensity.toFixed(3));
    const headerLine = lines[metadataLines.length]!;
    expect(headerLine).toContain('SENZA meteo');
    expect(headerLine).toContain('CON meteo');
    // Colonne indipendenti dal vento (pendenza, quota, reale) compaiono una sola volta, non
    // una per colonna. Contate su una riga DATI, non sull'header (l'header ha virgole dentro
    // celle tra virgolette come "densità X kg/m³, vento..." che una split naive romperebbe).
    expect(lines[metadataLines.length + 1]!.split(',').length).toBe(17);
  });

  it('tronca alla lunghezza più corta se i due array non sono allineati', () => {
    const points = flatRoute(20);
    const { samples } = syntheticActivity(20, 24);
    const baseline = computePlanVsActualFineGrid(pvaBreakpoints, points, params, 'speed', 250, undefined, 20, samples, 1);
    const withWeatherShort = baseline.slice(0, 3);
    const csv = planVsActualFineGridComparisonToCsv(
      baseline,
      withWeatherShort,
      params.airDensity,
      { airDensity: 1.15, windKmh: 10, windDirectionDeg: 0 },
      params,
      undefined
    );
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));
    expect(lines).toHaveLength(metadataLines.length + 1 + 3);
  });
});

describe('energyBalanceToCsv', () => {
  it('produce un blocco di metadata (parametri fisici) + header + una riga per intervallo', () => {
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
    const csv = energyBalanceToCsv(rows, params);
    const lines = csv.split('\n');
    // Le righe di metadata iniziano tutte con "#" — così un `pd.read_csv(path, comment='#')` le
    // salta da sole; senza, vanno saltate a mano (skiprows). Contale invece di assumerne il numero
    // esatto, per non dover riaggiornare questo test a ogni campo aggiunto ai metadata.
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));
    expect(metadataLines.length).toBeGreaterThan(0);
    expect(lines).toHaveLength(metadataLines.length + 1 + rows.length);
    expect(csv).toContain(`CdA (m²): ${params.cda}`);
    expect(csv).toContain(`Peso attrezzatura (kg): ${params.bikeMassKg}`);
    const headerLine = lines[metadataLines.length]!;
    expect(headerLine).toContain('Residuo (J');
  });

  it('con nessuna riga produce solo metadata + header', () => {
    const csv = energyBalanceToCsv([], params);
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));
    expect(lines).toHaveLength(metadataLines.length + 1);
  });
});

describe('energyBalanceComparisonToCsv', () => {
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

  it('produce metadata condivisi + header con densità e vento per colonna + una riga per intervallo', () => {
    const baseline = [fakeRow(40), fakeRow(-10)];
    const withWeather = [fakeRow(20), fakeRow(-5)];
    const csv = energyBalanceComparisonToCsv(baseline, withWeather, { airDensity: 1.2, windKmh: 0 }, { airDensity: 1.18, windKmh: 8.5 }, params);
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));
    expect(lines).toHaveLength(metadataLines.length + 1 + baseline.length);
    expect(csv).toContain(`CdA (m²): ${params.cda}`); // stesso CdA per entrambe le colonne, non duplicato per riga
    const headerLine = lines[metadataLines.length]!;
    expect(headerLine).toContain('1.200');
    expect(headerLine).toContain('1.180');
    expect(headerLine).toContain('8.5');
  });

  it('la colonna delta è la differenza fra i residui ASSOLUTI, non quelli con segno', () => {
    const baseline = [fakeRow(40)];
    const withWeather = [fakeRow(-10)]; // magnitudine più bassa, segno invertito
    const csv = energyBalanceComparisonToCsv(baseline, withWeather, { airDensity: 1.2, windKmh: 0 }, { airDensity: 1.18, windKmh: 0 }, params);
    const dataLine = csv.split('\n').at(-1)!;
    const cells = dataLine.split(',');
    // |−10| − |40| = -30 ⇒ un miglioramento, non un peggioramento
    expect(cells[cells.length - 1]).toBe('-30');
  });

  it('tronca alla lunghezza più corta se i due array non sono allineati', () => {
    const csv = energyBalanceComparisonToCsv([fakeRow(1), fakeRow(2)], [fakeRow(1)], { airDensity: 1.2, windKmh: 0 }, { airDensity: 1.18, windKmh: 0 }, params);
    const lines = csv.split('\n');
    const metadataLines = lines.filter(l => l === '#' || l.startsWith('# '));
    expect(lines).toHaveLength(metadataLines.length + 1 + 1); // metadata + header + 1 riga
  });
});
