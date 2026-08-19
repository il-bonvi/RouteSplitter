import { speedFromPower } from './physics.js';
import type { PhysicsParams, PowerSegment } from './types.js';

export interface PowerSample {
  tSec: number;
  power: number;
}

/**
 * Params effettivi per un segmento: se il segmento porta la propria componente di vento
 * (zone vento definite, vedi pacingActions), sovrascrive params.windKmh SOLO per questo
 * segmento — altrimenti usa params così com'è (comportamento storico, vento scalare unico).
 */
function paramsForSegment(seg: PowerSegment, params: PhysicsParams): PhysicsParams {
  return seg.windKmh === undefined ? params : { ...params, windKmh: seg.windKmh };
}

/** Campiona una lista di segmenti a potenza costante in una serie a risoluzione ~1s. */
export function buildConstPowerSamples(segments: PowerSegment[], params: PhysicsParams): PowerSample[] {
  const samples: PowerSample[] = [];
  let tSec = 0;
  for (const s of segments) {
    if (!(s.distanceKm > 0)) continue;
    const v = speedFromPower(s.power, s.gradient, paramsForSegment(s, params)) * 3.6; // km/h
    const durSec = v > 0.1 ? (s.distanceKm / v) * 3600 : 0;
    if (durSec <= 0) continue;
    const n = Math.max(1, Math.round(durSec));
    const dt = durSec / n;
    for (let k = 0; k < n; k++) samples.push({ tSec: tSec + dt * (k + 0.5), power: s.power });
    tSec += durSec;
  }
  return samples;
}

/** Media mobile con finestra windowSec su una serie {tSec, power} ordinata per tSec. */
export function rollingAvgPower(samples: PowerSample[], windowSec: number): number[] {
  const out = new Array<number>(samples.length);
  let sum = 0;
  let left = 0;
  for (let right = 0; right < samples.length; right++) {
    sum += samples[right]!.power;
    while (left < right && samples[right]!.tSec - samples[left]!.tSec > windowSec) {
      sum -= samples[left]!.power;
      left++;
    }
    out[right] = sum / (right - left + 1);
  }
  return out;
}

/**
 * Normalized Power standard (Coggan/TrainingPeaks): campiona a ~1s, applica una media
 * mobile di 30s, poi calcola la radice quarta della media della quarta potenza.
 *
 * Sostituisce il calcolo precedente ("Math.pow(mean(p^4), 0.25)" applicato direttamente
 * ai valori di sezione), che pesava per NUMERO di segmenti/celle invece che per TEMPO e
 * non applicava alcuna finestra mobile — quindi non era comparabile con la NP che un vero
 * misuratore di potenza calcola su un'attività reale. Vedi review 2026-08, punto 2.
 */
export function computeNormalizedPower(segments: PowerSegment[], params: PhysicsParams): number {
  const samples = buildConstPowerSamples(segments, params);
  if (!samples.length) return 0;
  const roll = rollingAvgPower(samples, 30);
  const sum4 = roll.reduce((a, p) => a + Math.pow(p, 4), 0);
  return Math.pow(sum4 / roll.length, 0.25);
}

/** Media di potenza pesata sul TEMPO (non sul numero di segmenti). */
export function timeWeightedAvgPower(segments: PowerSegment[], params: PhysicsParams): number {
  let sumPT = 0;
  let sumT = 0;
  for (const s of segments) {
    if (!(s.distanceKm > 0)) continue;
    const v = speedFromPower(s.power, s.gradient, paramsForSegment(s, params)) * 3.6;
    const t = v > 0.1 ? s.distanceKm / v : 0;
    sumPT += s.power * t;
    sumT += t;
  }
  return sumT > 0 ? sumPT / sumT : 0;
}
