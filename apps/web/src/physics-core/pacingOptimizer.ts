import { speedFromPower } from './physics.js';
import { computeNormalizedPower, timeWeightedAvgPower } from './normalizedPower.js';
import type { OptimizableSegment, PhysicsParams, PowerSegment } from './types.js';

/** Params effettivi per un segmento con vento noto (vedi stesso pattern in normalizedPower.ts). */
function paramsForSegment(seg: OptimizableSegment, params: PhysicsParams): PhysicsParams {
  return seg.windKmh === undefined ? params : { ...params, windKmh: seg.windKmh };
}

/**
 * Proietta `powers` così che la media pesata sul TEMPO sia = targetAvg, rispettando i
 * limiti [minPower, maxPower]. Ad ogni iterazione: calcola la media attuale, e se è
 * lontana dal target distribuisce l'errore residuo sui soli segmenti non ancora saturi
 * (non già al limite nella direzione richiesta), poi ricalcola.
 *
 * Versione consolidata rispetto all'originale (che ricalcolava la stessa cosa 3 volte
 * per iterazione con logiche leggermente diverse, patchate empiricamente) — stessa idea,
 * un solo passaggio chiaro per iterazione.
 */
export function projectToTimeWeightedAverage(
  powers: number[],
  segments: OptimizableSegment[],
  targetAvg: number,
  minPower: number,
  maxPower: number,
  params: PhysicsParams,
  maxIterations = 25
): number[] {
  // I valori in ingresso possono arrivare già fuori range (es. dal blend euristico del
  // loop marginale, non ancora vincolato): clampare SUBITO evita che un valore invalido
  // venga scambiato per "già saturo al limite" e quindi escluso per sempre dagli
  // aggiustamenti successivi nella direzione mancante.
  const result = powers.map(p => Math.min(maxPower, Math.max(minPower, p)));
  for (let iter = 0; iter < maxIterations; iter++) {
    const times = result.map((p, i) => {
      const seg = segments[i]!;
      const v = speedFromPower(p, seg.gradient, paramsForSegment(seg, params)) * 3.6;
      return v > 0.1 ? seg.distanceKm / v : 1e-6;
    });
    const sumT = times.reduce((a, b) => a + b, 0);
    const sumPT = result.reduce((a, p, i) => a + p * times[i]!, 0);
    const avg = sumPT / (sumT || 1);
    if (Math.abs(avg - targetAvg) < 0.15) break;

    const err = targetAvg - avg;
    const freeIdx: number[] = [];
    for (let i = 0; i < result.length; i++) {
      const atMax = result[i]! >= maxPower - 0.5;
      const atMin = result[i]! <= minPower + 0.5;
      if ((err > 0 && !atMax) || (err < 0 && !atMin)) freeIdx.push(i);
    }
    if (freeIdx.length === 0) break; // tutti i segmenti sono saturi, non ci si può avvicinare di più

    const freeT = freeIdx.reduce((a, i) => a + times[i]!, 0) || 1;
    const delta = err * (sumT / freeT);
    for (const i of freeIdx) {
      result[i] = Math.min(maxPower, Math.max(minPower, result[i]! + delta));
    }
  }
  return result;
}

export interface PacingOptimizerOptions {
  /** Potenza media target, pesata sul tempo (W) */
  targetAvgPower: number;
  /** Normalized Power target (opzionale) */
  targetNormalizedPower?: number | null;
  minPower: number;
  maxPower: number;
  /** Iterazioni del loop principale di allocazione (default 50, come l'originale) */
  mainIterations?: number;
  /** Iterazioni del loop di aggiustamento NP (default 20) */
  npIterations?: number;
}

export interface PacingOptimizerResult {
  powers: number[];
  timeWeightedAvgPower: number;
  normalizedPower: number;
  totalTimeHours: number;
}

/**
 * Alloca potenza sui segmenti per minimizzare il tempo totale a parità di potenza media
 * (pesata sul tempo) target, ed eventualmente di NP target. Allocare più potenza dove il
 * beneficio marginale in tempo per watt è maggiore è coerente con la letteratura sul
 * pacing variabile (es. Swain, "Cycling uphill and downhill": a parità di media, un
 * profilo con più watt in salita è più veloce di uno costante, per la relazione quasi
 * cubica dell'aerodinamica in piano/discesa contro quella quasi lineare in salita).
 *
 * Funziona identicamente sia su poche sezioni "umane" sia su una griglia fine (es. ogni
 * 100-250m): unifica quelli che nel prototipo originale erano due funzioni quasi duplicate
 * (optimizePacing / optimizePacingFull).
 *
 * NOTA — limiti noti non affrontati qui (vedi roadmap): nessun modello di affaticamento
 * (CP/W'), nessun vincolo di rampa tra segmenti adiacenti, nessuna garanzia formale di
 * convergenza al vero ottimo (euristica, non un solver convesso).
 *
 * Vento: se i segmenti in ingresso portano `windKmh` (zone vento definite, vedi
 * `lib/pacingActions.ts`), l'ottimizzatore alloca la potenza tenendone conto — stesso
 * principio già visto per pendenza/piano: un tratto in forte testa parte da una velocità
 * più bassa (regime aerodinamico meno dominante, quasi-lineare), quindi un watt marginale lì
 * compra proporzionalmente più tempo risparmiato che su un tratto in coda, dove si è già
 * veloci e si è nel regime aerodinamico quasi-cubico a rendimenti marginali decrescenti.
 * Risultato: a parità di media, l'ottimizzatore spinge di più contro vento e tira il fiato
 * in coda — la stessa strategia di pacing raccomandata per il vento in letteratura.
 */
export function optimizePacing(
  segments: OptimizableSegment[],
  options: PacingOptimizerOptions,
  params: PhysicsParams
): PacingOptimizerResult {
  const { targetAvgPower, targetNormalizedPower, minPower, maxPower } = options;
  const mainIterations = options.mainIterations ?? 50;
  const npIterations = options.npIterations ?? 20;

  let powers = segments.map(() => targetAvgPower);

  for (let iter = 0; iter < mainIterations; iter++) {
    const marginal = segments.map((s, i) => {
      const segParams = paramsForSegment(s, params);
      const v0 = speedFromPower(powers[i]!, s.gradient, segParams) * 3.6;
      const t0 = v0 > 0.1 ? s.distanceKm / v0 : 999;
      const v1 = speedFromPower(powers[i]! + 5, s.gradient, segParams) * 3.6;
      const t1 = v1 > 0.1 ? s.distanceKm / v1 : 999;
      return Math.max(0, (t0 - t1) / 5); // secondi risparmiati per watt aggiuntivo
    });
    const sumMarg = marginal.reduce((a, b) => a + b, 0);
    if (sumMarg < 1e-12) break;

    const alpha = 0.65;
    const raw = marginal.map(m => Math.pow(m + 1e-9, alpha));
    const sumRaw = raw.reduce((a, b) => a + b, 0) || 1;
    const shaped = raw.map(r => targetAvgPower * (r / sumRaw) * segments.length);
    const blend = 0.4;
    powers = powers.map((p, i) => p * (1 - blend) + shaped[i]! * blend);
    powers = projectToTimeWeightedAverage(powers, segments, targetAvgPower, minPower, maxPower, params);
  }

  if (targetNormalizedPower && targetNormalizedPower > 50) {
    for (let adj = 0; adj < npIterations; adj++) {
      const segList: PowerSegment[] = segments.map((s, i) => ({
        distanceKm: s.distanceKm,
        gradient: s.gradient,
        power: powers[i]!,
        windKmh: s.windKmh
      }));
      const np = computeNormalizedPower(segList, params);
      if (Math.abs(np - targetNormalizedPower) < 0.8) break;
      const mean = timeWeightedAvgPower(segList, params);
      const factor = np > targetNormalizedPower ? 0.9 : 1.1;
      powers = powers.map(p => mean + (p - mean) * factor);
      powers = projectToTimeWeightedAverage(powers, segments, targetAvgPower, minPower, maxPower, params);
    }
  }

  let sumPT = 0;
  let sumT = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const v = speedFromPower(powers[i]!, seg.gradient, paramsForSegment(seg, params)) * 3.6;
    const t = v > 0.1 ? seg.distanceKm / v : 0;
    sumPT += powers[i]! * t;
    sumT += t;
  }
  const finalTimeWeightedAvg = sumT > 0 ? sumPT / sumT : targetAvgPower;
  const finalNp = computeNormalizedPower(
    segments.map((s, i) => ({ distanceKm: s.distanceKm, gradient: s.gradient, power: powers[i]!, windKmh: s.windKmh })),
    params
  );

  return {
    powers,
    timeWeightedAvgPower: finalTimeWeightedAvg,
    normalizedPower: finalNp,
    totalTimeHours: sumT
  };
}
