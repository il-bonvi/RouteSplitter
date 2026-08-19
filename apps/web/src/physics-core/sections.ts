import { speedFromPower, powerFromSpeed } from './physics.js';
import { computeGainLossBetween, getInterpolatedPoint, type ProcessedPoint } from './geo.js';
import { windAtDistKm, routeBearingAtDistKm, effectiveHeadwindKmh, type WindZoneBoundary } from './wind.js';
import type { PhysicsParams } from './types.js';

/**
 * Punto di sezione. Struttura compatibile con Breakpoint di shared-schema (stessi campi),
 * ma definita qui in modo indipendente: physics-core non dipende da shared-schema/Zod,
 * resta un pacchetto di sola matematica senza dipendenze — vedi stato_rs.md.
 */
export interface SectionBreakpoint {
  id: string;
  distKm: number;
  fixed: 'start' | 'finish' | false;
  sectionLabel: string | null;
  speedKmh: number | null;
  powerWatts: number | null;
}

export type CalcMode = 'speed' | 'power';

export interface SectionResult {
  index: number;
  from: SectionBreakpoint;
  to: SectionBreakpoint;
  distanceKm: number;
  gain: number;
  loss: number;
  gradient: number;
  speedKmh: number;
  powerWatts: number;
  timeHours: number;
  /** m/h di dislivello, può essere negativo in discesa */
  vam: number;
  cumDistKm: number;
  cumTimeHours: number;
  cumGain: number;
  cumLoss: number;
  cumAvgSpeedKmh: number;
  /** Potenza media cumulata, pesata sul TEMPO (non sulla distanza), in W. */
  cumAvgPowerWatts: number;
  /**
   * Componente di vento efficace lungo la direzione di marcia in questa sezione, km/h.
   * Positivo = in testa, negativo = in coda. 0 se non sono definite zone vento.
   */
  windHeadwindKmh: number;
}

/**
 * Deriva le statistiche di ogni sezione (tra due breakpoint consecutivi ordinati per
 * distanza) usando il bilancio di forze di physics-core. In modalità 'power' la velocità
 * è calcolata dalla potenza impostata (o da defaultPowerWatts se assente); in modalità
 * 'speed' è l'inverso. D+/D- usano sempre l'elevazione grezza di routePoints (mai
 * smussata — coerente con il resto dell'app).
 */
export function computeSections(
  breakpoints: SectionBreakpoint[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  calcMode: CalcMode,
  defaultPowerWatts = 250,
  windZones?: WindZoneBoundary[]
): SectionResult[] {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const results: SectionResult[] = [];
  let cumDist = 0;
  let cumTime = 0;
  let cumGain = 0;
  let cumLoss = 0;
  let cumWork = 0; // Wh (potenza * tempo)

  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]!;
    const to = sorted[i]!;
    const { gain, loss } = computeGainLossBetween(routePoints, from.distKm, to.distKm);
    const distanceKm = to.distKm - from.distKm;
    const eleFrom = getInterpolatedPoint(routePoints, from.distKm * 1000).ele;
    const eleTo = getInterpolatedPoint(routePoints, to.distKm * 1000).ele;
    const netElev = eleTo - eleFrom;
    const gradient = distanceKm > 0 ? (netElev / (distanceKm * 1000)) * 100 : 0;

    // Se sono definite zone vento, la componente efficace (in testa/in coda) rimpiazza il
    // parametro scalare params.windKmh per QUESTA sezione, confrontando la direzione del
    // vento con la rotta media del tracciato nel tratto — altrimenti si usa params.windKmh
    // così com'è (comportamento storico, usato anche dallo stimatore CdA).
    let windHeadwindKmh = params.windKmh;
    let effectiveParams = params;
    if (windZones && windZones.length >= 2) {
      const midKm = (from.distKm + to.distKm) / 2;
      const wind = windAtDistKm(windZones, midKm);
      if (wind) {
        const bearing = routeBearingAtDistKm(routePoints, midKm);
        windHeadwindKmh = effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing);
        effectiveParams = { ...params, windKmh: windHeadwindKmh };
      } else {
        windHeadwindKmh = 0;
        effectiveParams = { ...params, windKmh: 0 };
      }
    }

    let speedKmh: number;
    let powerWatts: number;
    let timeHours: number;
    if (calcMode === 'power') {
      powerWatts = to.powerWatts ?? defaultPowerWatts;
      speedKmh = speedFromPower(powerWatts, gradient, effectiveParams) * 3.6;
      timeHours = speedKmh > 0.1 ? distanceKm / speedKmh : 0;
    } else {
      speedKmh = to.speedKmh ?? 0;
      powerWatts = powerFromSpeed(speedKmh / 3.6, gradient, effectiveParams);
      timeHours = speedKmh > 0 ? distanceKm / speedKmh : 0;
    }

    const vam = timeHours > 0 ? netElev / timeHours : 0;
    cumDist += distanceKm;
    cumTime += timeHours;
    cumGain += gain;
    cumLoss += loss;
    cumWork += powerWatts * timeHours;
    const cumAvgSpeedKmh = cumTime > 0 ? cumDist / cumTime : 0;
    const cumAvgPowerWatts = cumTime > 0 ? cumWork / cumTime : 0;

    results.push({
      index: i,
      from,
      to,
      distanceKm,
      gain,
      loss,
      gradient,
      speedKmh,
      powerWatts,
      timeHours,
      vam,
      cumDistKm: cumDist,
      cumTimeHours: cumTime,
      cumGain,
      cumLoss,
      cumAvgSpeedKmh,
      cumAvgPowerWatts,
      windHeadwindKmh
    });
  }
  return results;
}
