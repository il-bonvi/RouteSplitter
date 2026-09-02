import { GRAVITY } from './physics.js';
import { getInterpolatedPoint, type ProcessedPoint } from './geo.js';

const EARTH_RADIUS_M = 6371000;

/** Finestra (metri, prima e dopo il punto) usata per stimare la curvatura locale. Troppo
 * corta (pochi metri) e il rumore GPS punto-per-punto domina la stima; troppo lunga e si
 * "smussano" curve strette reali che invece contano. 15m è un compromesso ragionevole per
 * GPS da ciclocomputer (non professionale): abbastanza per superare il rumore tipico
 * (qualche metro), abbastanza corto da non perdere tornanti stretti (che hanno un raggio
 * spesso sotto i 10-15m). */
const DEFAULT_CURVATURE_WINDOW_M = 15;

/** Raggio (m) oltre il quale una curva è considerata "dolce" e non vincolante ai fini della
 * velocità di sicurezza — evita di trattare come "curva" ogni impercettibile variazione di
 * direzione su un rettilineo (inevitabile con GPS reale, anche su strada dritta). */
const STRAIGHT_RADIUS_THRESHOLD_M = 500;

/** Proietta un punto lat/lon in coordinate piane locali (metri), relative a un'origine —
 * approssimazione equirettangolare valida per le distanze in gioco qui (decine di metri). */
function toLocalXY(lat: number, lon: number, originLat: number, originLon: number): { x: number; y: number } {
  const y = ((lat - originLat) * Math.PI * EARTH_RADIUS_M) / 180;
  const x = ((lon - originLon) * Math.PI * EARTH_RADIUS_M * Math.cos((originLat * Math.PI) / 180)) / 180;
  return { x, y };
}

/**
 * Stima il raggio di curvatura locale (metri) alla distanza `distKm` lungo il percorso, dal
 * cerchio circoscritto ai tre punti "prima" (a `windowM` metri prima), "al punto" e "dopo" (a
 * `windowM` metri dopo). Formula esatta per tre punti su un vero cerchio (a differenza di una
 * stima basata sulla sola variazione di bearing, che ha un bias sistematico su curve strette
 * quando la finestra non è piccola rispetto al raggio): R = (a·b·c)/(4·Area del triangolo).
 * Restituisce `Infinity` per punti collineari (rettilineo, area ≈ 0) o quando il percorso è
 * troppo corto perché la finestra richiesta esista.
 */
export function estimateCurveRadiusM(routePoints: ProcessedPoint[], distKm: number, windowM = DEFAULT_CURVATURE_WINDOW_M): number {
  const distM = distKm * 1000;
  const before = getInterpolatedPoint(routePoints, Math.max(0, distM - windowM));
  const at = getInterpolatedPoint(routePoints, distM);
  const after = getInterpolatedPoint(routePoints, distM + windowM);

  const pA = toLocalXY(before.lat, before.lon, at.lat, at.lon);
  const pB = { x: 0, y: 0 };
  const pC = toLocalXY(after.lat, after.lon, at.lat, at.lon);

  const a = Math.hypot(pB.x - pC.x, pB.y - pC.y);
  const b = Math.hypot(pC.x - pA.x, pC.y - pA.y);
  const c = Math.hypot(pA.x - pB.x, pA.y - pB.y);
  const area = Math.abs(pA.x * (pB.y - pC.y) + pB.x * (pC.y - pA.y) + pC.x * (pA.y - pB.y)) / 2;

  if (area < 1e-9 || a === 0 || b === 0 || c === 0) return Infinity;
  const radiusM = (a * b * c) / (4 * area);
  // Quasi-collinearità numerica: con punti quasi allineati ma non esattamente (normale col
  // rumore GPS reale), l'area al denominatore può essere estremamente piccola senza essere
  // zero, facendo "esplodere" il raggio calcolato a valori enormi ma finiti (es. miliardi di
  // metri) — numericamente corretti ma privi di senso fisico. Qualunque raggio oltre la soglia
  // "rettilineo" (`STRAIGHT_RADIUS_THRESHOLD_M`) è comunque trattato come nessun limite più
  // sotto in `maxCorneringSpeedKmh`, quindi qui arrotondiamo direttamente a `Infinity` invece
  // di restituire un numero enorme e non informativo (es. nell'export CSV).
  return radiusM > STRAIGHT_RADIUS_THRESHOLD_M * 10 ? Infinity : radiusM;
}

/**
 * Velocità massima "di sicurezza" in curva dato un raggio (m), dalla fisica elementare della
 * piega in bicicletta: v = √(μ·g·R). `gripFactor` (μ) non è un vero coefficiente di attrito
 * pneumatico-asfalto misurato — è un fattore prudenziale che approssima quanto un ciclista
 * reale (non un pilota da pista) è disposto a piegare in sicurezza su strada aperta, fondo
 * non sempre pulito, visibilità non garantita. 0.35 è un valore conservativo tipico per
 * ciclismo su strada (i pneumatici da corsa su asfalto pulito reggerebbero parecchio di più,
 * ma nessuno guida al limite dell'aderenza su un percorso non chiuso al traffico). Raggi oltre
 * `STRAIGHT_RADIUS_THRESHOLD_M` sono trattati come rettilineo (nessun limite): a quel raggio
 * la velocità di sicurezza supererebbe comunque qualunque velocità raggiungibile in bici.
 */
export function maxCorneringSpeedKmh(radiusM: number, gripFactor = 0.35): number {
  if (!Number.isFinite(radiusM) || radiusM >= STRAIGHT_RADIUS_THRESHOLD_M) return Infinity;
  return Math.sqrt(gripFactor * GRAVITY * radiusM) * 3.6;
}
