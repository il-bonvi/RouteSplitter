import { smoothByTime, computeEnergyBalance, type EnergyBalanceInput, type EnergyBalanceRow, type PhysicsParams } from '@physics-core';
import type { ActivityDisplayPoint } from '../activity/buildActivityDisplay.js';

export interface BuildEnergyBalanceOptions {
  /** Finestra di smoothing temporale (secondi) applicata a potenza/velocità/pendenza prima
   * del bilancio — attenua il rumore di misura (GPS, power meter) SENZA cancellare
   * l'inerzia vera, che si manifesta su scale di qualche secondo. Troppo piccola (0-1s) e il
   * residuo è dominato da rumore di misura; troppo grande (>10s) e si torna al problema del
   * confronto a bin (si nasconde l'inerzia che si vuole invece misurare). Default 3s: stesso
   * ordine di grandezza già scelto per `smoothByTime` nel resto dell'app. */
  smoothingSeconds?: number;
  /** Sotto questa velocità (km/h) un punto è fermo/quasi fermo (semafori, soste, tornanti):
   * scartato, stesso principio già usato in `buildCdaSamples`. Default 3 km/h. */
  minSpeedKmh?: number;
}

/**
 * Converte i punti dell'attività reale (già costruiti da `buildActivityDisplay`, con
 * pendenza/distanza/tempo/potenza per punto alla cadenza nativa del device) negli input del
 * bilancio energetico (`computeEnergyBalance`, physics-core). Applica uno smoothing
 * temporale leggero — non quello a 60m di `buildCdaSamples` (pensato per una regressione
 * CdA su un'uscita intera, qui servirebbe a mascherare l'inerzia, non a isolarla).
 */
export function buildEnergyBalanceInputs(points: ActivityDisplayPoint[], options: BuildEnergyBalanceOptions = {}): EnergyBalanceInput[] {
  const smoothingSeconds = options.smoothingSeconds ?? 3;
  const minSpeedMS = (options.minSpeedKmh ?? 3) / 3.6;

  const valid = points.filter(p => p.powerW != null && Number.isFinite(p.powerW) && Number.isFinite(p.timeSec));
  if (valid.length < 3) return [];

  const timesSec = valid.map(p => p.timeSec);
  const rawSpeedMS = valid.map(p => (p.speedKmh ?? 0) / 3.6);
  const rawGradient = valid.map(p => p.gradient);
  const rawPower = valid.map(p => p.powerW!);

  const smSpeedMS = smoothByTime(rawSpeedMS, timesSec, smoothingSeconds);
  const smGradient = smoothByTime(rawGradient, timesSec, smoothingSeconds);
  const smPower = smoothByTime(rawPower, timesSec, smoothingSeconds);

  const inputs: EnergyBalanceInput[] = [];
  for (let i = 0; i < valid.length; i++) {
    const speedMS = smSpeedMS[i]!;
    if (speedMS < minSpeedMS) continue;
    inputs.push({
      timeSec: timesSec[i]!,
      distKm: valid[i]!.dist / 1000,
      speedMS,
      gradientPct: smGradient[i]!,
      powerW: smPower[i]!
    });
  }
  return inputs;
}

/** Scorciatoia: costruisce gli input e calcola il bilancio in un solo passo. */
export function computeActivityEnergyBalance(
  points: ActivityDisplayPoint[],
  params: PhysicsParams,
  options: BuildEnergyBalanceOptions = {}
): EnergyBalanceRow[] {
  return computeEnergyBalance(buildEnergyBalanceInputs(points, options), params);
}

export interface EnergyBalanceComparisonSummary {
  n: number;
  medianAbsResidualBaselineW: number;
  medianAbsResidualWithWeatherW: number;
  meanAbsResidualBaselineW: number;
  meanAbsResidualWithWeatherW: number;
  /** Su quanti intervalli il residuo ASSOLUTO è più basso con la densità dell'aria "meteo". */
  improvedCount: number;
}

/**
 * Confronta due bilanci energetici calcolati sugli STESSI intervalli (stessa attività, stesso
 * smoothing — solo `physicsParams.airDensity`/`windKmh` cambiano fra i due) — tipicamente
 * "quelli di partenza" vs "quelli impliciti dal meteo storico" (D57/D58/D59, Tab 3: "serve
 * poter esportare i dati e le differenze tra di essi per api on/off, per capire se funziona
 * oppure no"). Usa il residuo ASSOLUTO, non quello con segno: un residuo che passa da +40W a
 * -40W NON è un miglioramento anche se la mediana con segno scendesse — il modello sarebbe
 * comunque distante dai dati osservati, solo dall'altra parte. Mediana E media entrambe
 * riportate: la mediana è robusta a poche frenate estreme, la media è più sensibile — se le
 * due raccontano storie diverse (es. mediana migliora ma media peggiora) è un segnale che il
 * meteo aiuta "in media" ma peggiora vistosamente in alcuni tratti specifici.
 */
export function summarizeEnergyBalanceComparison(
  baseline: EnergyBalanceRow[],
  withWeather: EnergyBalanceRow[]
): EnergyBalanceComparisonSummary | null {
  const n = Math.min(baseline.length, withWeather.length);
  if (n === 0) return null;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const absBaseline = baseline.slice(0, n).map(r => Math.abs(r.residualPowerW));
  const absWeather = withWeather.slice(0, n).map(r => Math.abs(r.residualPowerW));
  let improvedCount = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(withWeather[i]!.residualPowerW) < Math.abs(baseline[i]!.residualPowerW)) improvedCount++;
  }
  return {
    n,
    medianAbsResidualBaselineW: median(absBaseline),
    medianAbsResidualWithWeatherW: median(absWeather),
    meanAbsResidualBaselineW: mean(absBaseline),
    meanAbsResidualWithWeatherW: mean(absWeather),
    improvedCount
  };
}
