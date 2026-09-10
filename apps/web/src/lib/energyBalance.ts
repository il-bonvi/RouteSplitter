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
