import { RawTrackPointSchema, type RawTrackPoint } from '@shared-schema';

export interface ParsedGpx {
  points: RawTrackPoint[];
  /** true se almeno un punto aveva un tag <ele> valido — un GPX senza quota risulterebbe
   * altrimenti indistinguibile da un percorso realmente piatto (gap segnalato in review). */
  hasElevation: boolean;
  /** punti scartati perché con coordinate non valide (NaN, fuori range geografico...) */
  discardedCount: number;
}

/**
 * Parsa un file GPX (testo XML) in punti grezzi validati. A differenza del prototipo
 * originale, qui le coordinate non finite o fuori range vengono scartate esplicitamente
 * (con warning) invece di propagarsi silenziosamente in tutta la catena di calcolo.
 */
export function parseGpxText(gpxText: string): ParsedGpx {
  const xml = new DOMParser().parseFromString(gpxText, 'text/xml');
  if (xml.querySelector('parsererror')) {
    throw new Error('File GPX non valido: XML malformato.');
  }

  const trkpts = Array.from(xml.querySelectorAll('trkpt'));
  if (trkpts.length < 2) {
    throw new Error('File GPX non valido: servono almeno 2 punti traccia (<trkpt>).');
  }

  let hasElevation = false;
  const candidates = trkpts.map(pt => {
    const lat = parseFloat(pt.getAttribute('lat') ?? '');
    const lon = parseFloat(pt.getAttribute('lon') ?? '');
    const eleText = pt.querySelector('ele')?.textContent;
    const ele = eleText != null ? parseFloat(eleText) : 0;
    if (eleText != null && Number.isFinite(ele)) hasElevation = true;
    return { lat, lon, ele };
  });

  const points: RawTrackPoint[] = [];
  let discardedCount = 0;
  for (const candidate of candidates) {
    const result = RawTrackPointSchema.safeParse(candidate);
    if (result.success) points.push(result.data);
    else discardedCount++;
  }

  if (points.length < 2) {
    throw new Error('File GPX non valido: nessun punto con coordinate valide trovato.');
  }

  return { points, hasElevation, discardedCount };
}
