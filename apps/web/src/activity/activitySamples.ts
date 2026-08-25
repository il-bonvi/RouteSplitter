import { haversine, smoothByDistance, type CdaSample } from '@physics-core';
import type { ActivityTrackPoint } from './parseActivityFile.js';

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
