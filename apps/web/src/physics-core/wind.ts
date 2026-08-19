import { bearingDeg, getInterpolatedPoint, type ProcessedPoint } from './geo.js';

/**
 * Confine di una "zona vento": esattamente lo stesso pattern strutturale dei breakpoint di
 * sezione (start/finish fissi + interni ordinabili), per coerenza con il resto dell'app e per
 * poter riusare la stessa logica di add/remove/sort. Ogni voce (tranne 'start', che non ha un
 * tratto precedente) porta il vento della zona che TERMINA in quel punto — cioè dal confine
 * precedente fino a questo.
 */
export interface WindZoneBoundary {
  id: string;
  distKm: number;
  fixed: 'start' | 'finish' | false;
  /** Intensità del vento, km/h. null solo per il punto 'start'. */
  speedKmh: number | null;
  /** Direzione DA cui soffia il vento (convenzione meteo), gradi bussola [0,360). null solo per 'start'. */
  directionDeg: number | null;
}

export interface WindAtPoint {
  speedKmh: number;
  directionDeg: number;
}

/**
 * Componente di vento efficace lungo la direzione di marcia, in km/h, con la stessa
 * convenzione di segno del vecchio parametro scalare: positivo = vento contrario (in testa),
 * negativo = vento a favore (in coda). Un vento perfettamente laterale dà ~0.
 *
 * Derivazione: il vento soffia (si muove) verso (directionDeg + 180). L'angolo fra la
 * direzione in cui si muove l'aria e la direzione di marcia del ciclista è
 * (directionDeg + 180) - bearingDeg. Se quell'angolo è 0 (aria e ciclista vanno nella stessa
 * direzione) è vento in coda puro; con la convenzione "positivo = in testa" questo si scrive:
 *   effettivo = -speedKmh * cos((directionDeg + 180 - bearingDeg))
 * che si semplifica (cos(x+180) = -cos(x)) in:
 *   effettivo = speedKmh * cos(directionDeg - bearingDeg)
 */
export function effectiveHeadwindKmh(windSpeedKmh: number, windDirectionDeg: number, routeBearingDeg: number): number {
  const deltaRad = ((windDirectionDeg - routeBearingDeg) * Math.PI) / 180;
  return windSpeedKmh * Math.cos(deltaRad);
}

/**
 * Direzione media di marcia del percorso attorno a distKm, calcolata dal bearing fra due punti
 * interpolati a distKm ∓ windowKm/2 (clampati al percorso). Una piccola finestra invece del
 * bearing punto-punto grezzo evita che micro-rumore GPS produca direzioni instabili.
 */
export function routeBearingAtDistKm(points: ProcessedPoint[], distKm: number, windowKm = 0.15): number {
  const total = points[points.length - 1]!.dist / 1000;
  const half = windowKm / 2;
  const fromKm = Math.max(0, distKm - half);
  const toKm = Math.min(total, distKm + half);
  const p1 = getInterpolatedPoint(points, fromKm * 1000);
  const p2 = getInterpolatedPoint(points, toKm * 1000);
  if (Math.abs(p2.lat - p1.lat) < 1e-9 && Math.abs(p2.lon - p1.lon) < 1e-9) {
    // Finestra degenere (percorso troppo corto o punto esattamente a inizio/fine): allarga.
    const p1b = getInterpolatedPoint(points, 0);
    const p2b = getInterpolatedPoint(points, total * 1000);
    return bearingDeg(p1b.lat, p1b.lon, p2b.lat, p2b.lon);
  }
  return bearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);
}

/** Trova la zona vento attiva a distKm (stessa ricerca "primo confine >= distKm" dei breakpoint). */
export function windAtDistKm(zones: WindZoneBoundary[], distKm: number): WindAtPoint | null {
  if (zones.length < 2) return null;
  const sorted = [...zones].sort((a, b) => a.distKm - b.distKm);
  let target = sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i++) {
    if (distKm <= sorted[i]!.distKm + 1e-9) {
      target = sorted[i]!;
      break;
    }
  }
  if (target.speedKmh == null || target.directionDeg == null) return null;
  return { speedKmh: target.speedKmh, directionDeg: target.directionDeg };
}

export function makeUniformWindZones(distanceKm: number, speedKmh = 0, directionDeg = 0): WindZoneBoundary[] {
  return [
    { id: 'wind-start', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
    { id: 'wind-finish', distKm: distanceKm, fixed: 'finish', speedKmh, directionDeg }
  ];
}
