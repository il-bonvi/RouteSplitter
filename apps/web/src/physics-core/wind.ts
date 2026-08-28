import { bearingDeg, getInterpolatedPoint, type ProcessedPoint } from './geo.js';

/**
 * Campione vento a un'ora del giorno precisa, per una zona. Opzionale: una zona senza
 * `timeSamples` (o con l'array vuoto) si comporta esattamente come prima di questo campo
 * (vento statico da `speedKmh`/`directionDeg`) — stesso pattern "0/1/N opzionale, 0 =
 * comportamento storico invariato" già usato per `cdaTiers` in physics.ts. Pensato per
 * accogliere un futuro forecast orario (F1.1/decisioni aperte in stato_rs.md): un forecast
 * reale fornisce dati per ora del giorno, non per "minuti dalla partenza", quindi si usa
 * l'ora assoluta (richiede `SectionPlan.plannedStartTime` per essere collocata sul percorso).
 */
export interface WindTimeSample {
  id: string;
  /** Ora del giorno, minuti da mezzanotte [0,1440). */
  minuteOfDay: number;
  speedKmh: number;
  directionDeg: number;
}

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
  /** Vedi `WindTimeSample`. Vuoto = vento statico (comportamento storico). */
  timeSamples: WindTimeSample[];
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

/** Trova il confine (zona) attivo a distKm — stessa ricerca "primo confine >= distKm" dei breakpoint. */
function findZoneAt(zones: WindZoneBoundary[], distKm: number): WindZoneBoundary | null {
  if (zones.length < 2) return null;
  const sorted = [...zones].sort((a, b) => a.distKm - b.distKm);
  let target = sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i++) {
    if (distKm <= sorted[i]!.distKm + 1e-9) {
      target = sorted[i]!;
      break;
    }
  }
  return target;
}

/** Trova la zona vento attiva a distKm (vento statico — ignora eventuali `timeSamples`). */
export function windAtDistKm(zones: WindZoneBoundary[], distKm: number): WindAtPoint | null {
  const target = findZoneAt(zones, distKm);
  if (!target || target.speedKmh == null || target.directionDeg == null) return null;
  return { speedKmh: target.speedKmh, directionDeg: target.directionDeg };
}

/**
 * Interpola linearmente fra i due campioni orari più vicini a `minuteOfDay` (clampato ai
 * bordi fuori range — nessuna estrapolazione). L'intensità si interpola linearmente; la
 * direzione con un'interpolazione circolare (media vettoriale pesata) per gestire
 * correttamente l'attraversamento di 0°/360° (es. 350° → 10° non deve passare per 180°).
 */
function interpolateTimeSamples(samples: WindTimeSample[], minuteOfDay: number): WindAtPoint {
  const sorted = [...samples].sort((a, b) => a.minuteOfDay - b.minuteOfDay);
  if (sorted.length === 1 || minuteOfDay <= sorted[0]!.minuteOfDay) {
    return { speedKmh: sorted[0]!.speedKmh, directionDeg: sorted[0]!.directionDeg };
  }
  const last = sorted[sorted.length - 1]!;
  if (minuteOfDay >= last.minuteOfDay) {
    return { speedKmh: last.speedKmh, directionDeg: last.directionDeg };
  }
  let a = sorted[0]!;
  let b = sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i++) {
    if (minuteOfDay <= sorted[i]!.minuteOfDay) {
      a = sorted[i - 1]!;
      b = sorted[i]!;
      break;
    }
  }
  const span = b.minuteOfDay - a.minuteOfDay;
  const t = span > 0 ? (minuteOfDay - a.minuteOfDay) / span : 0;
  const speedKmh = a.speedKmh + (b.speedKmh - a.speedKmh) * t;
  // Interpolazione circolare della direzione via media vettoriale pesata (gestisce il
  // wraparound 0/360 senza casi speciali).
  const aRad = (a.directionDeg * Math.PI) / 180;
  const bRad = (b.directionDeg * Math.PI) / 180;
  const x = Math.cos(aRad) * (1 - t) + Math.cos(bRad) * t;
  const y = Math.sin(aRad) * (1 - t) + Math.sin(bRad) * t;
  let directionDeg = (Math.atan2(y, x) * 180) / Math.PI;
  if (directionDeg < 0) directionDeg += 360;
  return { speedKmh, directionDeg };
}

/**
 * Come `windAtDistKm`, ma se la zona attiva ha `timeSamples` configurati e `minuteOfDay` è
 * noto, interpola il vento nel tempo invece di usare il valore statico — pensato per un
 * futuro forecast orario reale (vedi `WindTimeSample`). Se la zona non ha campioni orari, o
 * `minuteOfDay` è null (piano senza `plannedStartTime`), il comportamento è identico a
 * `windAtDistKm` (nessuna regressione per chi non configura nulla).
 */
export function windAtDistKmTime(zones: WindZoneBoundary[], distKm: number, minuteOfDay: number | null): WindAtPoint | null {
  const target = findZoneAt(zones, distKm);
  if (!target) return null;
  if (target.timeSamples && target.timeSamples.length > 0 && minuteOfDay != null) {
    return interpolateTimeSamples(target.timeSamples, minuteOfDay);
  }
  if (target.speedKmh == null || target.directionDeg == null) return null;
  return { speedKmh: target.speedKmh, directionDeg: target.directionDeg };
}

/** Converte "HH:mm" in minuti da mezzanotte. Ritorna null per stringhe vuote/non valide. */
export function parseClockTimeToMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function makeUniformWindZones(distanceKm: number, speedKmh = 0, directionDeg = 0): WindZoneBoundary[] {
  return [
    { id: 'wind-start', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null, timeSamples: [] },
    { id: 'wind-finish', distKm: distanceKm, fixed: 'finish', speedKmh, directionDeg, timeSamples: [] }
  ];
}
