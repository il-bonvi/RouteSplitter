import { haversine, smoothByDistance, type CdaSample, type MotionSample } from '@physics-core';
import type { ActivityTrackPoint } from './parseActivityFile.js';

/** Distanza cumulata, velocità e pendenza grezze (pre-smoothing) da punti attività validi
 * (lat/lon/tempo finiti) — fattorizzato da `buildCdaSamples`/`buildMotionSamples`, che
 * differiscono solo nel filtro di validità a monte (richiede potenza o no) e nel tipo di
 * campione prodotto in uscita. */
function computeDistanceSpeedGradient(valid: ActivityTrackPoint[]): { dist: number[]; rawSpeed: number[]; rawGradient: number[] } {
  const hasDeviceDist = valid.every(p => p.distM != null && Number.isFinite(p.distM));
  const dist: number[] = [0];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1]!;
    const curr = valid[i]!;
    if (hasDeviceDist) {
      dist.push(Math.max(dist[i - 1]!, curr.distM!));
    } else {
      dist.push(dist[i - 1]! + haversine(prev.lat, prev.lon, curr.lat, curr.lon));
    }
  }

  const rawSpeed: number[] = [0];
  const rawGradient: number[] = [0];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1]!;
    const curr = valid[i]!;
    const dt = curr.timeSec - prev.timeSec;
    const dd = dist[i]! - dist[i - 1]!;
    rawSpeed.push(dt > 0 ? dd / dt : 0);
    const ele0 = prev.ele ?? 0;
    const ele1 = curr.ele ?? 0;
    rawGradient.push(dd > 0 ? ((ele1 - ele0) / dd) * 100 : 0);
  }

  return { dist, rawSpeed, rawGradient };
}

export interface BuildCdaSamplesOptions {
  /** Raggio (metri) della media mobile per distanza fisica applicata a velocità/potenza/
   * pendenza prima della regressione. Serve a due cose insieme: attenuare il rumore
   * GPS/potenza istantaneo e approssimare la condizione di velocità costante assunta dal
   * modello fisico (`wheelPowerAtSpeed`), che non include un termine di accelerazione —
   * un'attività reale non è mai a velocità realmente costante punto per punto. Stessa
   * tecnica già usata altrove nell'app per lo smoothing del profilo altimetrico
   * (`smoothByDistance`, physics-core), qui riusata per un motivo diverso (stabilità della
   * stima invece che resa grafica). Default 60 m: abbastanza per smussare i transitori di
   * pedalata senza cancellare le variazioni di pendenza reali del percorso. */
  smoothingRadiusMeters?: number;
  /** Sotto questa velocità (km/h) un punto è considerato fermo/quasi fermo (semafori,
   * tornanti strettissimi, soste) e viene scartato — a queste velocità il termine
   * aerodinamico è trascurabile e il rumore relativo esplode. Default 3 km/h. */
  minSpeedKmh?: number;
}

export interface BuildCdaSamplesResult {
  samples: CdaSample[];
  /** Punti totali nel file sorgente (prima di qualunque filtro). */
  totalPoints: number;
  /** Punti con lat/lon/tempo/potenza validi, prima del filtro di velocità minima. */
  pointsWithPower: number;
}

/**
 * Trasforma i punti grezzi di un'attività (lat/lon/quota/tempo/potenza, da
 * `parseActivityFile.ts`) nei campioni {velocità, potenza, pendenza} richiesti da
 * `estimateCdaFromSamples` (physics-core). Funzione pura, riusa solo `haversine` e
 * `smoothByDistance` da physics-core — nessuna dipendenza da DOM/React, testabile con
 * semplici array sintetici.
 */
export function buildCdaSamples(
  points: ActivityTrackPoint[],
  options: BuildCdaSamplesOptions = {}
): BuildCdaSamplesResult {
  const smoothingRadiusMeters = options.smoothingRadiusMeters ?? 60;
  const minSpeedMS = (options.minSpeedKmh ?? 3) / 3.6;

  const valid = points.filter(
    p =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      Number.isFinite(p.timeSec) &&
      p.powerW != null &&
      Number.isFinite(p.powerW)
  );

  if (valid.length < 5) {
    return { samples: [], totalPoints: points.length, pointsWithPower: valid.length };
  }

  // Distanza cumulata: si preferisce quella dichiarata dal device (più stabile della
  // sola triangolazione GPS punto-punto, specie a bassa velocità) quando è presente su
  // OGNI punto valido ed è monotona non-decrescente; altrimenti si ricade su haversine,
  // stessa tecnica già usata per la distanza del percorso in `geo.ts`.
  const { dist, rawSpeed, rawGradient } = computeDistanceSpeedGradient(valid);
  const rawPower = valid.map(p => p.powerW!);

  const smSpeed = smoothByDistance(rawSpeed, dist, smoothingRadiusMeters);
  const smGradient = smoothByDistance(rawGradient, dist, smoothingRadiusMeters);
  const smPower = smoothByDistance(rawPower, dist, smoothingRadiusMeters);

  const samples: CdaSample[] = [];
  for (let i = 1; i < valid.length; i++) {
    const speedMS = smSpeed[i]!;
    if (speedMS < minSpeedMS) continue;
    samples.push({ speedMS, powerW: smPower[i]!, gradientPct: smGradient[i]!, distKm: dist[i]! / 1000 });
  }

  return { samples, totalPoints: points.length, pointsWithPower: valid.length };
}

export interface BuildMotionSamplesOptions {
  /** Stesso significato di `BuildCdaSamplesOptions.smoothingRadiusMeters` (default 60 m):
   * qui serve anche a `estimateTheoreticalPower`, che assume l'ipotesi di quasi-equilibrio
   * per intervallo e altrimenti amplificherebbe il rumore GPS (v² nel termine aero). */
  smoothingRadiusMeters?: number;
  /** Stesso significato di `BuildCdaSamplesOptions.minSpeedKmh` (default 3 km/h). */
  minSpeedKmh?: number;
}

export interface BuildMotionSamplesResult {
  samples: MotionSample[];
  totalPoints: number;
}

/**
 * Come `buildCdaSamples`, ma SENZA richiedere potenza — a differenza di `CdaSample`,
 * `MotionSample` (physics-core/theoreticalPower.ts) non ha un campo potenza perché è
 * esattamente l'incognita da ricavare con `estimateTheoreticalPower`. Unica differenza
 * strutturale: `MotionSample` porta `timeSec` (serve per il termine cinetico ΔEC/dt), che
 * `CdaSample` non ha perché non ne ha bisogno.
 *
 * Usabile su QUALSIASI attività (con o senza canale potenza) — è il percorso per la
 * "potenza teorica" su un'uscita senza misuratore, o per confrontare potenza teorica vs
 * reale quando il misuratore c'è.
 */
export function buildMotionSamples(points: ActivityTrackPoint[], options: BuildMotionSamplesOptions = {}): BuildMotionSamplesResult {
  const smoothingRadiusMeters = options.smoothingRadiusMeters ?? 60;
  const minSpeedMS = (options.minSpeedKmh ?? 3) / 3.6;

  const valid = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timeSec));
  if (valid.length < 5) {
    return { samples: [], totalPoints: points.length };
  }

  const { dist, rawSpeed, rawGradient } = computeDistanceSpeedGradient(valid);
  const smSpeed = smoothByDistance(rawSpeed, dist, smoothingRadiusMeters);
  const smGradient = smoothByDistance(rawGradient, dist, smoothingRadiusMeters);

  const samples: MotionSample[] = [];
  for (let i = 1; i < valid.length; i++) {
    const speedMS = smSpeed[i]!;
    if (speedMS < minSpeedMS) continue;
    samples.push({
      timeSec: valid[i]!.timeSec,
      distKm: dist[i]! / 1000,
      speedMS,
      gradientPct: smGradient[i]!
    });
  }

  return { samples, totalPoints: points.length };
}

export interface CropActivityResult {
  points: ActivityTrackPoint[];
  /** Secondi tra l'inizio originale del file e il primo punto ritagliato — serve al
   * chiamante per ricalcolare `activityDate` della nuova attività salvata (il ritaglio
   * NON è più iniziato all'ora di partenza originale). */
  timeOffsetSec: number;
}

/**
 * Ritaglia un'attività REGISTRATA su `[fromKm, toKm]`, ribasando `timeSec` e (se presente)
 * `distM` a partire da 0 al nuovo inizio — così l'attività ritagliata, salvata come nuova
 * attività indipendente, ha una durata/distanza coerenti con se stessa invece di ereditare
 * gli offset dell'originale (rilevante: `buildCdaSamples`/`buildMotionSamples` assumono
 * `dist` cumulata a partire da 0 sul primo punto).
 *
 * A differenza di `cropRoutePoints` (percorso PIANIFICATO, physics-core/geo.ts) qui NON si
 * interpola: potenza/quota/tempo sono misure puntuali REGISTRATE, interpolarle al confine
 * esatto inventerebbe un valore mai misurato dal device. Si include quindi il punto valido
 * più vicino dentro l'intervallo richiesto (lieve scarto di qualche metro dal confine
 * esatto — accettabile per un dato osservato, a differenza che per un percorso pianificato
 * dove la distanza dev'essere esatta per il pacing).
 */
export function cropActivityPoints(points: ActivityTrackPoint[], fromKm: number, toKm: number): CropActivityResult {
  const valid = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timeSec));
  if (valid.length < 2) return { points: [], timeOffsetSec: 0 };

  const { dist } = computeDistanceSpeedGradient(valid);
  const lastDistM = dist[dist.length - 1]!;
  const fromM = Math.max(0, Math.min(fromKm * 1000, lastDistM));
  const toM = Math.max(0, Math.min(toKm * 1000, lastDistM));
  if (!(toM > fromM)) return { points: [], timeOffsetSec: 0 };

  const indices: number[] = [];
  for (let i = 0; i < valid.length; i++) {
    if (dist[i]! >= fromM && dist[i]! <= toM) indices.push(i);
  }
  if (indices.length < 2) return { points: [], timeOffsetSec: 0 };

  const first = valid[indices[0]!]!;
  const timeOffsetSec = first.timeSec;
  // Ribasa distM sul valore DEVICE del primo punto ritagliato (non sull'haversine
  // ricalcolata sopra): coerente con `computeDistanceSpeedGradient`, che preferisce distM
  // quando disponibile su ogni punto — ribasare sulla fonte sbagliata introdurrebbe uno
  // scarto residuo silenzioso tra distM ribasata e la dist ricalcolata a valle.
  const distOffsetM = first.distM;

  const croppedPoints = indices.map(i => {
    const p = valid[i]!;
    return {
      ...p,
      timeSec: p.timeSec - timeOffsetSec,
      distM: p.distM != null && distOffsetM != null ? p.distM - distOffsetM : null
    };
  });

  return { points: croppedPoints, timeOffsetSec };
}
