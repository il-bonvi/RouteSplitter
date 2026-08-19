import {
  getInterpolatedPoint,
  windAtDistKm,
  routeBearingAtDistKm,
  effectiveHeadwindKmh,
  type OptimizableSegment,
  type ProcessedPoint,
  type SectionBreakpoint,
  type WindZoneBoundary
} from '@physics-core';

/**
 * Componente di vento efficace (km/h, +testa/-coda) nel PUNTO MEDIO di un tratto, se sono
 * definite zone vento — altrimenti `undefined` (l'ottimizzatore userà in quel caso il
 * params.windKmh scalare globale, comportamento storico). Punto medio invece di un
 * campionamento multi-punto: coerente con la stessa approssimazione già usata da
 * `computeSections` per le sezioni utente (vedi sections.ts), non introduce un doppio
 * standard fra "sezioni" e "ottimizzatore" per lo stesso tratto.
 */
function segmentWindKmh(fromKm: number, toKm: number, points: ProcessedPoint[], windZones?: WindZoneBoundary[]): number | undefined {
  if (!windZones || windZones.length < 2) return undefined;
  const midKm = (fromKm + toKm) / 2;
  const wind = windAtDistKm(windZones, midKm);
  if (!wind) return 0;
  const bearing = routeBearingAtDistKm(points, midKm);
  return effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing);
}

/** Converte i breakpoint utente in segmenti {distanceKm, gradient} pronti per l'ottimizzatore. */
export function breakpointsToSegments(
  breakpoints: SectionBreakpoint[],
  routePoints: ProcessedPoint[],
  windZones?: WindZoneBoundary[]
): OptimizableSegment[] {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const segs: OptimizableSegment[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]!;
    const to = sorted[i]!;
    const distanceKm = to.distKm - from.distKm;
    const eleFrom = getInterpolatedPoint(routePoints, from.distKm * 1000).ele;
    const eleTo = getInterpolatedPoint(routePoints, to.distKm * 1000).ele;
    const gradient = distanceKm > 0 ? ((eleTo - eleFrom) / (distanceKm * 1000)) * 100 : 0;
    segs.push({ distanceKm, gradient, windKmh: segmentWindKmh(from.distKm, to.distKm, routePoints, windZones) });
  }
  return segs;
}

export interface FineSegment {
  d0Km: number;
  d1Km: number;
  distanceKm: number;
  gradient: number;
  windKmh?: number;
}

/** Spezza l'intero percorso in una griglia di segmenti a step regolare (per "Ottimizza completo"). */
export function buildFineGrid(
  totalDistanceKm: number,
  stepKm: number,
  routePoints: ProcessedPoint[],
  windZones?: WindZoneBoundary[]
): FineSegment[] {
  const boundaries: number[] = [];
  for (let d = 0; d < totalDistanceKm - 1e-9; d += stepKm) boundaries.push(d);
  boundaries.push(totalDistanceKm);
  const segs: FineSegment[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const d0 = boundaries[i - 1]!;
    const d1 = boundaries[i]!;
    const distanceKm = d1 - d0;
    if (distanceKm < 1e-6) continue;
    const eleFrom = getInterpolatedPoint(routePoints, d0 * 1000).ele;
    const eleTo = getInterpolatedPoint(routePoints, d1 * 1000).ele;
    const gradient = ((eleTo - eleFrom) / (distanceKm * 1000)) * 100;
    segs.push({ d0Km: d0, d1Km: d1, distanceKm, gradient, windKmh: segmentWindKmh(d0, d1, routePoints, windZones) });
  }
  return segs;
}

/**
 * Mappa la potenza calcolata su una griglia fine sulle sezioni utente, come media
 * pesata sulla distanza di sovrapposizione. Restituisce una Map id-breakpoint → potenza,
 * pensata per essere applicata in un solo salvataggio (evita aggiornamenti sequenziali
 * che potrebbero perdersi l'un l'altro su stato React non ancora sincronizzato).
 */
export function mapFinePowersToBreakpoints(
  breakpoints: SectionBreakpoint[],
  fineSegs: FineSegment[],
  finePowers: number[]
): Map<string, number> {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const result = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]!;
    const to = sorted[i]!;
    let wSum = 0;
    let pSum = 0;
    for (let j = 0; j < fineSegs.length; j++) {
      const seg = fineSegs[j]!;
      const a = Math.max(seg.d0Km, from.distKm);
      const b = Math.min(seg.d1Km, to.distKm);
      const overlap = b - a;
      if (overlap > 1e-9) {
        pSum += finePowers[j]! * overlap;
        wSum += overlap;
      }
    }
    if (wSum > 0) result.set(to.id, Math.round(pSum / wSum));
  }
  return result;
}
