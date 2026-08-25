import { processRoute, type ProcessedPoint, type RawTrackPoint } from '@physics-core';
import type { ActivityTrackPoint } from './parseActivityFile.js';

export interface ActivityDisplayPoint extends ProcessedPoint {
  powerW: number | null;
  /** velocità istantanea grezza fra questo punto e il precedente, km/h. null sul primo punto. */
  speedKmh: number | null;
  timeSec: number;
}

export interface ActivityDisplay {
  points: ActivityDisplayPoint[];
  distanceKm: number;
  elevationGain: number;
  elevationLoss: number;
  durationSec: number;
  avgPowerW: number | null;
  maxPowerW: number | null;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
}

/**
 * Trasforma i punti grezzi di un'attività (da `parseActivityFile.ts`/`parseFitFile.ts`) in
 * una struttura pronta per mappa + grafico altimetria/potenza — riusa `processRoute`
 * (physics-core), lo stesso motore che elabora il GPX pianificato nella tab "Percorso":
 * stessa logica di distanza cumulata/pendenza/D+/D-, nessuna duplicazione, e il risultato è
 * compatibile con `ProcessedPoint` (`ActivityMap` può quindi riusare `buildColorSegments`
 * senza adattamenti).
 *
 * `processRoute` richiede una quota numerica per ogni punto: dove l'attività non la
 * riporta (raro, ma possibile su un GPX minimale) si riusa l'ultima quota nota — non altera
 * la pendenza dei punti circostanti, che dipende dai punti EFFETTIVAMENTE misurati.
 */
export function buildActivityDisplay(points: ActivityTrackPoint[]): ActivityDisplay | null {
  const valid = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timeSec));
  if (valid.length < 2) return null;

  let lastEle = valid.find(p => p.ele != null)?.ele ?? 0;
  const rawPoints: RawTrackPoint[] = valid.map(p => {
    if (p.ele != null) lastEle = p.ele;
    return { lat: p.lat, lon: p.lon, ele: lastEle };
  });

  const processed = processRoute(rawPoints);

  // Velocità istantanea grezza (non smussata: lo smoothing, se serve, è solo grafico e
  // vive nel componente che disegna il grafico — stessa separazione già in uso per il
  // percorso pianificato, vedi geo.ts).
  const displayPoints: ActivityDisplayPoint[] = processed.points.map((pp, i) => {
    const curr = valid[i]!;
    let speedKmh: number | null = null;
    if (i > 0) {
      const prevRaw = valid[i - 1]!;
      const prevProcessed = processed.points[i - 1]!;
      const dtSec = curr.timeSec - prevRaw.timeSec;
      const ddM = pp.dist - prevProcessed.dist;
      speedKmh = dtSec > 0 ? (ddM / dtSec) * 3.6 : 0;
    }
    return { ...pp, powerW: curr.powerW, speedKmh, timeSec: curr.timeSec };
  });

  const durationSec = valid[valid.length - 1]!.timeSec - valid[0]!.timeSec;
  const powerValues = displayPoints.map(p => p.powerW).filter((w): w is number => w != null);
  const speedValues = displayPoints.map(p => p.speedKmh).filter((v): v is number => v != null);

  return {
    points: displayPoints,
    distanceKm: processed.distanceKm,
    elevationGain: processed.elevationGain,
    elevationLoss: processed.elevationLoss,
    durationSec,
    avgPowerW: powerValues.length > 0 ? powerValues.reduce((a, b) => a + b, 0) / powerValues.length : null,
    maxPowerW: powerValues.length > 0 ? Math.max(...powerValues) : null,
    avgSpeedKmh: durationSec > 0 ? processed.distanceKm / (durationSec / 3600) : 0,
    maxSpeedKmh: speedValues.length > 0 ? Math.max(...speedValues) : 0
  };
}
