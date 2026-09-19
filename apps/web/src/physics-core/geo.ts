const EARTH_RADIUS_M = 6371000;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Rotta (bearing) da punto 1 a punto 2, in gradi bussola [0,360): 0=Nord, 90=Est, ecc. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

export interface RawTrackPoint {
  lat: number;
  lon: number;
  ele: number;
}

export interface ProcessedPoint extends RawTrackPoint {
  /** distanza cumulata dal punto di partenza, in metri */
  dist: number;
  /** pendenza punto-punto rispetto al precedente, in percento */
  gradient: number;
}

export interface ProcessedRoute {
  points: ProcessedPoint[];
  distanceKm: number;
  elevationGain: number;
  elevationLoss: number;
  maxElevation: number;
  minElevation: number;
}

/**
 * Elabora una lista di punti grezzi (lat/lon/ele, es. da un GPX già parsato a monte)
 * in un percorso con distanza cumulata e pendenza punto-punto.
 *
 * D+/D- sono calcolati sui dati GREZZI, non smussati: lo smoothing è una scelta
 * puramente grafica (vedi buildDisplayElevation in questo stesso pacchetto / la UI)
 * e non deve mai influenzare le statistiche di dislivello — decisione di prodotto
 * esplicita, non un default arbitrario.
 */
export function processRoute(rawPoints: RawTrackPoint[]): ProcessedRoute {
  if (rawPoints.length < 2) {
    throw new Error('Servono almeno 2 punti per elaborare un percorso.');
  }
  let distance = 0;
  let elevationGain = 0;
  let elevationLoss = 0;
  const first = rawPoints[0]!;
  let maxElevation = first.ele;
  let minElevation = first.ele;

  const processedPoints: ProcessedPoint[] = [{ ...first, dist: 0, gradient: 0 }];
  for (let i = 1; i < rawPoints.length; i++) {
    const prev = processedPoints[i - 1]!;
    const curr = rawPoints[i]!;
    const segDist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    distance += segDist;
    const elevDiff = curr.ele - prev.ele;
    if (elevDiff > 0) elevationGain += elevDiff;
    else elevationLoss += Math.abs(elevDiff);
    if (curr.ele > maxElevation) maxElevation = curr.ele;
    if (curr.ele < minElevation) minElevation = curr.ele;
    const gradient = segDist > 0 ? (elevDiff / segDist) * 100 : 0;
    processedPoints.push({ lat: curr.lat, lon: curr.lon, ele: curr.ele, dist: distance, gradient });
  }

  return {
    points: processedPoints,
    distanceKm: distance / 1000,
    elevationGain,
    elevationLoss,
    maxElevation,
    minElevation
  };
}

/** Ricerca binaria: interpola lat/lon/ele alla distanza esatta (in metri) richiesta. */
export function getInterpolatedPoint(
  points: ProcessedPoint[],
  distM: number
): { lat: number; lon: number; ele: number; dist: number } {
  const n = points.length;
  const clamped = Math.max(0, distM);
  const firstP = points[0]!;
  const lastP = points[n - 1]!;
  if (clamped <= firstP.dist) return firstP;
  if (clamped >= lastP.dist) return lastP;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.dist < clamped) lo = mid;
    else hi = mid;
  }
  const p1 = points[lo]!;
  const p2 = points[hi]!;
  const span = p2.dist - p1.dist;
  const t = span > 0 ? (clamped - p1.dist) / span : 0;
  return {
    lat: p1.lat + (p2.lat - p1.lat) * t,
    lon: p1.lon + (p2.lon - p1.lon) * t,
    ele: p1.ele + (p2.ele - p1.ele) * t,
    dist: clamped
  };
}

/**
 * D+/D- tra due distanze precise (km), interpolando gli estremi — coerente con lo
 * spostamento continuo dei breakpoint. Usa sempre l'elevazione grezza (vedi processRoute).
 */
export function computeGainLossBetween(
  points: ProcessedPoint[],
  fromKm: number,
  toKm: number
): { gain: number; loss: number } {
  const fromM = fromKm * 1000;
  const toM = toKm * 1000;
  let gain = 0;
  let loss = 0;
  let prevEle = getInterpolatedPoint(points, fromM).ele;
  for (const p of points) {
    if (p.dist <= fromM) continue;
    if (p.dist >= toM) break;
    const diff = p.ele - prevEle;
    if (diff > 0) gain += diff;
    else loss += Math.abs(diff);
    prevEle = p.ele;
  }
  const endEle = getInterpolatedPoint(points, toM).ele;
  const diff = endEle - prevEle;
  if (diff > 0) gain += diff;
  else loss += Math.abs(diff);
  return { gain, loss };
}

/**
 * Direzione media di marcia (bearing) su un'intera serie di punti, pesata per la distanza di
 * ogni segmento — media CIRCOLARE (stessa tecnica di `circularMeanDeg` in `lib/openMeteo.ts`,
 * qui perché è un calcolo puramente geometrico, non specifico di una fonte meteo). Serve a
 * proiettare un vento (velocità+direzione) rappresentativo dell'intera uscita su un unico
 * bearing, quando serve un solo scalare (es. bilancio energetico, D57/D58: `params.windKmh`
 * è uno scalare unico per tutta l'attività, non per-zona — vedi `energyBalance.ts`).
 * Un bearing punto-a-punto grezzo (senza pesatura) sarebbe dominato dai tratti con più
 * campioni GPS piuttosto che da quelli più lunghi — la pesatura per distanza corregge questo.
 */
export function distanceWeightedMeanBearingDeg(points: Array<{ lat: number; lon: number }>): number | null {
  let sumSin = 0;
  let sumCos = 0;
  let totalWeight = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    // Distanza equirettangolare approssimata: sufficiente come PESO relativo, non serve la
    // precisione di una formula di grande cerchio qui.
    const midLatRad = (((a.lat + b.lat) / 2) * Math.PI) / 180;
    const dLatM = (b.lat - a.lat) * 111320;
    const dLonM = (b.lon - a.lon) * 111320 * Math.cos(midLatRad);
    const segmentDistM = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
    if (segmentDistM < 1e-6) continue;
    const bearingRad = (bearingDeg(a.lat, a.lon, b.lat, b.lon) * Math.PI) / 180;
    sumSin += Math.sin(bearingRad) * segmentDistM;
    sumCos += Math.cos(bearingRad) * segmentDistM;
    totalWeight += segmentDistM;
  }
  if (totalWeight === 0) return null;
  const meanRad = Math.atan2(sumSin / totalWeight, sumCos / totalWeight);
  const deg = (meanRad * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * Ritaglia un percorso già processato (`ProcessedPoint[]`, con `dist` cumulata) a un
 * intervallo `[fromKm, toKm]`, interpolando i due estremi esattamente sul confine
 * richiesto (stessa tecnica di `getInterpolatedPoint`, già usata per D+/D- e breakpoint) —
 * non tronca al punto GPX più vicino, quindi il ritaglio riproduce esattamente la distanza
 * richiesta invece di sbandierare qualche metro in più o in meno.
 *
 * Ritorna punti grezzi (`RawTrackPoint`, solo lat/lon/ele) pronti per `processRoute` e per
 * il salvataggio come nuovo percorso — il chiamante decide se e come persisterli; questa
 * funzione non tocca lo store, resta puro calcolo (stessa filosofia di tutto physics-core).
 *
 * `fromKm`/`toKm` vengono clampati ai limiti del percorso, ma NON normalizzati se
 * invertiti: `toKm < fromKm` è quasi certamente un errore di chi chiama (es. estremi di
 * sezione scambiati) e va segnalato con un array vuoto, non corretto in silenzio
 * scambiandoli — un crop silenzioso nella direzione sbagliata sarebbe più insidioso di un
 * crop che visibilmente non produce nulla.
 */
export function cropRoutePoints(points: ProcessedPoint[], fromKm: number, toKm: number): RawTrackPoint[] {
  if (points.length < 2) return [];
  const lastDistM = points[points.length - 1]!.dist;
  const fromM = Math.max(0, Math.min(fromKm * 1000, lastDistM));
  const toM = Math.max(0, Math.min(toKm * 1000, lastDistM));
  if (!(toM > fromM)) return [];

  const start = getInterpolatedPoint(points, fromM);
  const end = getInterpolatedPoint(points, toM);
  const middle = points.filter(p => p.dist > fromM && p.dist < toM).map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));

  return [
    { lat: start.lat, lon: start.lon, ele: start.ele },
    ...middle,
    { lat: end.lat, lon: end.lon, ele: end.ele }
  ];
}
