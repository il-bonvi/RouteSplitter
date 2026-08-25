import type { PhysicsParams } from './types.js';
import { GRAVITY } from './physics.js';

/** Un campione istantaneo (o mediato su una finestra breve) di un'attività reale. */
export interface CdaSample {
  speedMS: number;
  powerW: number;
  gradientPct: number;
  /** Vento efficace (km/h, +testa) durante questo campione, se noto punto per punto.
   * Se assente, la regressione usa `params.windKmh` (costante) per tutti i campioni —
   * stessa semplificazione già accettata da `estimateCda` per la stima a campione singolo. */
  windKmh?: number;
  /** Distanza cumulata dal via, km — usata solo per raggruppare i campioni per tratto
   * (vedi `bucketSamplesByDistance`), non entra nella fisica della regressione. */
  distKm?: number;
}

export interface CdaRegressionResult {
  cda: number;
  /** Campioni effettivamente usati nella regressione, dopo i filtri di validità. */
  usedSamples: number;
  /** Campioni totali passati in ingresso (prima dei filtri). */
  totalSamples: number;
  /** Deviazione standard delle stime CdA punto-per-punto usate — indicazione di quanto
   * rumoroso è il segnale (non un errore standard formale della pendenza di regressione). */
  stdDev: number;
}

const MIN_VALID_SAMPLES = 20;
const MIN_PLAUSIBLE_CDA = 0.05;
const MAX_PLAUSIBLE_CDA = 1.0;

/**
 * Stima CdA per regressione lineare (minimi quadrati, retta passante per l'origine) su
 * MOLTI campioni istantanei di un'attività reale (velocità/potenza/pendenza), invece che
 * da un singolo campione medio come `estimateCda`.
 *
 * Risolve il bias segnalato in review (§4, punto 4 — disuguaglianza di Jensen): mediare
 * velocità/potenza PRIMA di invertire l'equazione introduce un errore sistematico su
 * tratti a pendenza/velocità non uniformi, perché l'equazione di potenza non è lineare in
 * v. Qui invece si sfrutta che, per pendenza e vento noti punto per punto, l'equazione è
 * LINEARE nel solo CdA:
 *
 *   effectivePower/v - roll - grav = 0.5·ρ·CdA·rel·|rel|
 *
 * quindi CdA è la pendenza (nel senso di regressione, non di percorso) della retta tra
 * x = 0.5·ρ·rel·|rel| e y = effectivePower/v - roll - grav, su tutti i campioni validi:
 *
 *   CdA = Σ(x·y) / Σ(x²)
 *
 * — minimi quadrati pesati implicitamente da x² (i campioni con poco segnale
 * aerodinamico, es. in salita a bassa velocità, pesano naturalmente meno nella stima
 * invece di introdurre comunque un bias come farebbe una media preliminare di tutto il
 * tratto).
 */
export function estimateCdaFromSamples(samples: CdaSample[], params: PhysicsParams): CdaRegressionResult | null {
  const m = params.riderMassKg + params.bikeMassKg;
  let sumXY = 0;
  let sumXX = 0;
  const perPointCda: number[] = [];

  for (const s of samples) {
    if (s.speedMS < 0.5 || s.powerW < 10) continue;
    const windKmh = s.windKmh ?? params.windKmh;
    const windMS = windKmh / 3.6;
    const rel = s.speedMS + windMS;
    if (Math.abs(rel) < 0.3) continue;
    const slopeRad = Math.atan(s.gradientPct / 100);
    const roll = params.crr * m * GRAVITY * Math.cos(slopeRad);
    const grav = m * GRAVITY * Math.sin(slopeRad);
    const effectivePower = s.powerW * (1 - params.drivetrainLossPct / 100);
    const y = effectivePower / s.speedMS - roll - grav;
    const x = 0.5 * params.airDensity * rel * Math.abs(rel);
    if (Math.abs(x) < 1e-6) continue;
    const pointCda = y / x;
    // Scarta campioni con CdA implicito palesemente fuori range fisico (rumore GPS/potenza,
    // fermate non filtrate a monte, transitori troppo bruschi) — stessi limiti di `estimateCda`.
    if (pointCda <= MIN_PLAUSIBLE_CDA || pointCda >= MAX_PLAUSIBLE_CDA) continue;
    sumXY += x * y;
    sumXX += x * x;
    perPointCda.push(pointCda);
  }

  if (perPointCda.length < MIN_VALID_SAMPLES || sumXX <= 0) return null;

  const cda = sumXY / sumXX;
  if (!(cda > MIN_PLAUSIBLE_CDA && cda < MAX_PLAUSIBLE_CDA)) return null;

  const mean = perPointCda.reduce((a, b) => a + b, 0) / perPointCda.length;
  const variance = perPointCda.reduce((a, b) => a + (b - mean) ** 2, 0) / perPointCda.length;

  return {
    cda,
    usedSamples: perPointCda.length,
    totalSamples: samples.length,
    stdDev: Math.sqrt(variance)
  };
}

/** Un gruppo di campioni assegnato a un CdA target (base o una soglia di `cdaTiers`). */
export interface CdaTierBucket {
  /** 'base' = params.cda; un numero = indice in params.cdaTiers da sovrascrivere. */
  target: 'base' | number;
  /** Soglia di pendenza del target, per etichettare l'interfaccia (null per 'base'). */
  thresholdPct: number | null;
  samples: CdaSample[];
}

/**
 * Divide i campioni di un'attività per soglia di pendenza, con la STESSA logica di
 * `effectiveCda` (la soglia più alta fra quelle raggiunte dalla pendenza del campione;
 * sotto la più bassa, 'base'). Permette di calibrare in un colpo solo, da una singola
 * uscita, sia il CdA base sia ciascuna soglia configurata — invece di dover ripetere la
 * stima una volta per soglia con giri separati.
 *
 * Senza soglie configurate, restituisce un solo bucket 'base' con tutti i campioni
 * (comportamento equivalente a chiamare `estimateCdaFromSamples` direttamente).
 */
export function bucketSamplesByTier(samples: CdaSample[], params: PhysicsParams): CdaTierBucket[] {
  const tiers = params.cdaTiers ?? [];
  if (tiers.length === 0) {
    return [{ target: 'base', thresholdPct: null, samples }];
  }

  const buckets: CdaTierBucket[] = [{ target: 'base', thresholdPct: null, samples: [] }];
  tiers.forEach((tier, i) => buckets.push({ target: i, thresholdPct: tier.thresholdPct, samples: [] }));

  for (const sample of samples) {
    let bestBucketIdx = 0; // 'base'
    let bestThreshold = -Infinity;
    tiers.forEach((tier, i) => {
      if (sample.gradientPct >= tier.thresholdPct && tier.thresholdPct > bestThreshold) {
        bestThreshold = tier.thresholdPct;
        bestBucketIdx = i + 1; // +1: buckets[0] è 'base'
      }
    });
    buckets[bestBucketIdx]!.samples.push(sample);
  }

  return buckets;
}

/** Un gruppo di campioni assegnato a un tratto di distanza fissa (es. km 0-5, 5-10, ...). */
export interface CdaDistanceBucket {
  fromKm: number;
  toKm: number;
  samples: CdaSample[];
}

/**
 * Divide i campioni in tratti di lunghezza fissa `sectionKm` (0–N, N–2N, ...), a scopo
 * puramente diagnostico: vedere se il CdA stimato resta stabile lungo il percorso o varia
 * (posizione diversa in bici, presa del manubrio, stanchezza, vento reale diverso da
 * quello impostato...) è un modo semplice per farsi un'idea di quanto fidarsi della stima
 * complessiva, anche senza voler applicare un CdA diverso per ogni tratto (per quello
 * restano le soglie di pendenza di `bucketSamplesByTier`).
 *
 * Richiede `distKm` valorizzato sui campioni (lo imposta `buildCdaSamples`); campioni
 * senza `distKm` vengono ignorati.
 */
export function bucketSamplesByDistance(samples: CdaSample[], sectionKm: number): CdaDistanceBucket[] {
  const withDist = samples.filter((s): s is CdaSample & { distKm: number } => s.distKm != null);
  if (!(sectionKm > 0) || withDist.length === 0) return [];

  const maxDistKm = Math.max(...withDist.map(s => s.distKm));
  const bucketCount = Math.max(1, Math.floor(maxDistKm / sectionKm) + 1);
  const buckets: CdaDistanceBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    fromKm: i * sectionKm,
    toKm: (i + 1) * sectionKm,
    samples: []
  }));

  for (const s of withDist) {
    const idx = Math.min(bucketCount - 1, Math.floor(s.distKm / sectionKm));
    buckets[idx]!.samples.push(s);
  }

  return buckets;
}

/**
 * Come `bucketSamplesByDistance`, ma con confini di sezione scelti dall'utente invece che a
 * intervalli fissi — stesso motore di split usato per le sezioni del percorso pianificato
 * (breakpoint aggiunti cliccando sul grafico), applicato qui ai campioni di un'attività
 * reale invece che al profilo di un percorso da pianificare.
 */
export function bucketSamplesByBreakpoints(samples: CdaSample[], breakpointsKm: number[]): CdaDistanceBucket[] {
  const withDist = samples.filter((s): s is CdaSample & { distKm: number } => s.distKm != null);
  if (withDist.length === 0) return [];

  const sortedBp = [...new Set(breakpointsKm)].sort((a, b) => a - b);
  const boundaries = [0, ...sortedBp, Infinity];
  const buckets: CdaDistanceBucket[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    buckets.push({ fromKm: boundaries[i]!, toKm: boundaries[i + 1]!, samples: [] });
  }

  for (const s of withDist) {
    let idx = buckets.length - 1;
    for (let i = 0; i < boundaries.length - 1; i++) {
      if (s.distKm >= boundaries[i]! && s.distKm < boundaries[i + 1]!) {
        idx = i;
        break;
      }
    }
    buckets[idx]!.samples.push(s);
  }

  return buckets;
}
