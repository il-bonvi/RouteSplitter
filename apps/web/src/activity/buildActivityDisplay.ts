import { processRoute, getInterpolatedPoint, haversine, type ProcessedPoint, type RawTrackPoint } from '@physics-core';
import type { ActivityTrackPoint } from './parseActivityFile.js';

export interface ActivityDisplayPoint extends ProcessedPoint {
  powerW: number | null;
  /** velocità istantanea grezza fra questo punto e il precedente, km/h. null sul primo punto. */
  speedKmh: number | null;
  timeSec: number;
}

/**
 * Sostituisce la quota di ogni punto attività con quella interpolata dal PERCORSO
 * PIANIFICATO (`routePoints`, il GPX caricato per quel percorso) alla stessa distanza
 * percorsa — non alla stessa quota registrata dal device. Utile quando il device (barometro
 * o GPS) è impreciso: i GPX di un percorso pianificato sono in genere più puliti (spesso
 * corretti da chi li ha creati, es. con dati SRTM), quindi possono essere una sorgente di
 * quota più affidabile della registrazione del singolo giro.
 *
 * La distanza percorsa dall'attività si calcola SOLO da lat/lon (haversine, indipendente
 * dalla quota — vedi `processRoute`), quindi può essere calcolata prima di sapere quale
 * sorgente di quota si userà. Assunzione implicita (la stessa già usata in tutto il resto di
 * questo confronto, es. nel bucketing per sezione): l'attività segue approssimativamente lo
 * stesso percorso, quindi "stessa distanza percorsa" ≈ "stesso punto del percorso".
 */
export function remapElevationFromRoute(points: ActivityTrackPoint[], routePoints: ProcessedPoint[]): ActivityTrackPoint[] {
  const valid = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timeSec));
  if (valid.length < 2 || routePoints.length < 2) return points;

  let cumDistM = 0;
  const remapped: ActivityTrackPoint[] = [{ ...valid[0]!, ele: getInterpolatedPoint(routePoints, 0).ele }];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1]!;
    const curr = valid[i]!;
    cumDistM += haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    remapped.push({ ...curr, ele: getInterpolatedPoint(routePoints, cumDistM).ele });
  }
  return remapped;
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

/** Tempo (secondi da inizio attività) del punto più vicino a `km` — ricerca lineare, va
 * benissimo per il numero di sezioni/bucket tipico (poche decine al massimo). Condivisa fra
 * l'analisi attività (F3.1) e il confronto pianificato-vs-reale (F3.3): stessa tecnica di
 * associazione distanza→tempo, un solo posto dove sta la logica. */
export function nearestPointTimeSec(points: ActivityDisplayPoint[], km: number): number {
  const targetM = km * 1000;
  let nearest = points[0]!;
  let minDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.dist - targetM);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = p;
    }
  }
  return nearest.timeSec;
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
