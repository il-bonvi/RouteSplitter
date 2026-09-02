import { GRAVITY, effectiveCda } from './physics.js';
import { getInterpolatedPoint, type ProcessedPoint } from './geo.js';
import type { PhysicsParams } from './types.js';
import type { SectionBreakpoint } from './sections.js';

/** Finestra (metri) usata per calcolare la pendenza locale a una distanza esatta —
 * `getInterpolatedPoint` interpola solo lat/lon/quota, non un campo "pendenza" (che nei punti
 * del percorso è definito fra coppie consecutive, non a una distanza arbitraria): la
 * pendenza qui si ricava dalla differenza di quota fra `distM-window/2` e `distM+window/2`,
 * più stabile della pendenza punto-a-punto grezza se i punti del GPX sono irregolarmente
 * spaziati (non dipende dalla densità dei punti originali). */
const LOCAL_GRADIENT_WINDOW_M = 10;

function localGradientPct(routePoints: ProcessedPoint[], distM: number, windowM = LOCAL_GRADIENT_WINDOW_M): number {
  const half = windowM / 2;
  const before = getInterpolatedPoint(routePoints, Math.max(0, distM - half));
  const after = getInterpolatedPoint(routePoints, distM + half);
  const span = after.dist - before.dist;
  return span > 0 ? ((after.ele - before.ele) / span) * 100 : 0;
}

/**
 * Un tratto a potenza-target costante — l'unità su cui lavora la simulazione dinamica.
 * Coincide con l'intervallo fra due breakpoint consecutivi del piano (stessa granularità
 * che l'utente controlla in Tab 1/2): quello che il ciclista sceglie è UNA potenza per
 * tratto, non un profilo continuo — è la fisica (pendenza reale, inerzia) a determinare
 * come la velocità si sviluppa dentro il tratto, non più un equilibrio ricalcolato di colpo.
 */
export interface DynamicSimSegment {
  d0Km: number;
  d1Km: number;
  targetPowerW: number;
}

/** Un passo della simulazione, a cadenza `dtSec` fissa. */
export interface DynamicSimStep {
  timeSec: number;
  distKm: number;
  speedMS: number;
  gradientPct: number;
  powerW: number;
}

export interface DynamicSimOptions {
  /** Passo di integrazione, secondi. Più piccolo = più preciso ma più lento da calcolare;
   * 1s è già più che sufficiente per le scale temporali dell'inerzia in bici (il transitorio
   * dopo un cambio di potenza/pendenza dura tipicamente diversi secondi, non frazioni di
   * secondo) — vedi bilancio energetico (F3.12), costruito anch'esso a cadenza ~1s. */
  dtSec?: number;
  /** Velocità di partenza, m/s. 0 = partenza da fermo (default: la maggior parte dei piani
   * comincia realisticamente da fermi al via). */
  initialSpeedMS?: number;
  /** Numero massimo di passi, come guardia contro un loop che non termina (es. potenza
   * insufficiente a vincere la pendenza per l'intero tratto, velocità che resta ~0
   * indefinitamente) — con `dtSec=1` corrisponde a poco più di 16h di simulazione. */
  maxSteps?: number;
}

/**
 * Integra la velocità nel tempo, tratto per tratto, invece di risolvere un equilibrio
 * stazionario per ciascuno. Ad ogni passo: l'energia cinetica guadagnata/persa è
 * `(potenza_effettiva - dissipazione_aero_rotolamento - potenza_gravità) · dt` — la STESSA
 * identità usata (in direzione opposta, dati osservati anziché da prevedere) in
 * `computeEnergyBalance` (F3.12): lì si verificava se il bilancio tornava sui dati reali, qui
 * lo si usa per PREVEDERE come si sviluppa la velocità dato un piano di potenza. Non è fisica
 * nuova, è l'inverso di uno strumento già validato sui dati reali di F3.12/F3.14.
 *
 * La pendenza usata ad ogni passo è quella REALE del percorso in quel punto (da
 * `routePoints`, risoluzione nativa) — non la pendenza media del tratto — così un cambio di
 * pendenza dentro un tratto a potenza costante si ripercuote sulla velocità nel momento giusto
 * (esattamente il meccanismo che manca al modello a equilibrio-per-sezione).
 *
 * Il vento è preso da `params.windKmh` (scalare) — le zone vento per-segmento non sono
 * ancora supportate qui, limite noto da colmare se questa modalità va oltre la fase
 * sperimentale.
 */
export function simulateDynamicPacing(
  segments: DynamicSimSegment[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  options: DynamicSimOptions = {}
): DynamicSimStep[] {
  const dtSec = options.dtSec ?? 1;
  const maxSteps = options.maxSteps ?? 60000;
  const sorted = [...segments].sort((a, b) => a.d0Km - b.d0Km);
  if (sorted.length === 0) return [];

  const m = params.riderMassKg + params.bikeMassKg;
  const windMS = params.windKmh / 3.6;
  const driveEff = 1 - params.drivetrainLossPct / 100;
  const endKm = sorted[sorted.length - 1]!.d1Km;

  let v = Math.max(0, options.initialSpeedMS ?? 0);
  let distKm = sorted[0]!.d0Km;
  let timeSec = 0;
  let segIdx = 0;

  const steps: DynamicSimStep[] = [];

  for (let i = 0; i < maxSteps && distKm < endKm; i++) {
    while (segIdx < sorted.length - 1 && distKm >= sorted[segIdx]!.d1Km) segIdx++;
    const seg = sorted[segIdx]!;
    const targetPowerW = seg.targetPowerW;

    const gradientPct = localGradientPct(routePoints, distKm * 1000);
    const slopeRad = Math.atan(gradientPct / 100);
    const rel = v + windMS;
    const aeroN = 0.5 * params.airDensity * effectiveCda(params, gradientPct) * rel * Math.abs(rel);
    const rollN = params.crr * m * GRAVITY * Math.cos(slopeRad);
    const gravN = m * GRAVITY * Math.sin(slopeRad);

    const dissipativePowerW = (aeroN + rollN) * v;
    const gravPowerW = gravN * v;
    const effectivePowerW = targetPowerW * driveEff;

    const deltaKeJ = (effectivePowerW - dissipativePowerW - gravPowerW) * dtSec;
    const vNext = Math.sqrt(Math.max(0, v * v + (2 * deltaKeJ) / m));

    // Distanza percorsa nel passo: media fra v iniziale e finale (trapezoidale), più accurata
    // di v·dt puro quando la velocità cambia molto in un passo (es. partenza da fermo).
    const distKmNext = distKm + ((v + vNext) / 2 / 1000) * dtSec;

    steps.push({ timeSec, distKm, speedMS: v, gradientPct, powerW: targetPowerW });

    v = vNext;
    distKm = distKmNext;
    timeSec += dtSec;
  }

  return steps;
}

/** Risultato per tratto — stessa granularità di `SectionBreakpoint`, per confronto diretto
 * con `SectionResult` (il risultato del modello a equilibrio) nella UI/export. */
export interface DynamicSectionResult {
  index: number;
  from: SectionBreakpoint;
  to: SectionBreakpoint;
  distanceKm: number;
  timeHours: number;
  avgSpeedKmh: number;
  avgPowerWatts: number;
}

/**
 * Aggrega i passi della simulazione per tratto fra breakpoint (non per passo temporale) —
 * per confrontare il totale con `computeSections`/`SectionResult` senza dover cambiare tutto
 * il resto della UI che già sa presentare risultati "per sezione". `dtSec` deve coincidere
 * con quello passato a `simulateDynamicPacing` (stesso default 1s).
 */
export function aggregateDynamicSimulationBySection(steps: DynamicSimStep[], breakpoints: SectionBreakpoint[], dtSec = 1): DynamicSectionResult[] {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const results: DynamicSectionResult[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]!;
    const to = sorted[i]!;
    const inRange = steps.filter(s => s.distKm >= from.distKm && s.distKm < to.distKm);
    const distanceKm = to.distKm - from.distKm;
    if (inRange.length === 0) {
      results.push({ index: i, from, to, distanceKm, timeHours: 0, avgSpeedKmh: 0, avgPowerWatts: 0 });
      continue;
    }
    const timeHours = (inRange.length * dtSec) / 3600;
    const avgSpeedKmh = (inRange.reduce((s, p) => s + p.speedMS, 0) / inRange.length) * 3.6;
    const avgPowerWatts = inRange.reduce((s, p) => s + p.powerW, 0) / inRange.length;
    results.push({ index: i, from, to, distanceKm, timeHours, avgSpeedKmh, avgPowerWatts });
  }
  return results;
}

/** Tempo totale simulato (ore) — durata dell'intera simulazione dall'inizio all'ultimo passo. */
export function totalDynamicSimTimeHours(steps: DynamicSimStep[], dtSec = 1): number {
  return steps.length === 0 ? 0 : (steps.length * dtSec) / 3600;
}
