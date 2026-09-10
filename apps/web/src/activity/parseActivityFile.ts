/**
 * Parsing di file attività (TCX o GPX con estensione potenza) per la stima CdA multi-punto
 * (F3.1 roadmap). A differenza di `gpx/parseGpx.ts` (che usa `DOMParser`, disponibile solo
 * in browser), qui si usa un'estrazione testuale a espressioni regolari: i file esportati
 * dai device (Garmin Connect, TrainingPeaks, Strava, ...) hanno una struttura molto
 * regolare, quindi un parser a regex è affidabile in pratica ed è per di più testabile in
 * Node (nei test Vitest, `environment: 'node'`, `DOMParser` non esiste) — vantaggio
 * concreto in più rispetto a portare qui lo stesso approccio DOM di `parseGpx.ts`.
 *
 * FIT (formato binario nativo dei ciclocomputer) non è supportato direttamente: va
 * esportato come TCX o GPX-con-potenza dal servizio del device (Garmin Connect, Strava,
 * TrainingPeaks lo fanno tutti) prima di caricarlo qui.
 */

export interface ActivityTrackPoint {
  lat: number;
  lon: number;
  /** Quota, metri. null se il file non la riporta per questo punto. */
  ele: number | null;
  /** Secondi trascorsi dal primo punto valido del file (tempo relativo, non timestamp assoluto). */
  timeSec: number;
  /** Potenza istantanea, W. null se il file non la riporta per questo punto. */
  powerW: number | null;
  /** Distanza cumulata dichiarata dal device, metri. null se il file non la riporta (tipico dei GPX). */
  distM: number | null;
}

export interface ParsedActivity {
  points: ActivityTrackPoint[];
  format: 'tcx' | 'gpx' | 'fit';
  /** true se ALMENO un punto ha un valore di potenza valido. */
  hasPower: boolean;
  /** blocchi trovati ma scartati (coordinate/tempo mancanti o non validi). */
  discardedCount: number;
  /** Istante assoluto (ISO 8601) del primo punto valido — `timeSec` sopra è relativo a
   * questo. Serve per datare correttamente un'attività salvata (D55): senza questo, "quando"
   * è successa un'uscita si saprebbe solo dalla data di caricamento del file, non da quella
   * reale della registrazione. */
  startTimeIso: string;
}

interface RawCandidate {
  lat: number;
  lon: number;
  ele: number | null;
  timeMs: number | null;
  powerW: number | null;
  distM: number | null;
}

function parseNum(text: string | undefined): number | null {
  if (text == null) return null;
  const n = parseFloat(text.trim());
  return Number.isFinite(n) ? n : null;
}

function extractTag(block: string, tagName: string): string | undefined {
  // Prefisso di namespace opzionale (es. <ns3:Watts>250</ns3:Watts>), case-insensitive
  // (alcuni export usano <Power>, altri <power>).
  const re = new RegExp(`<(?:[\\w-]+:)?${tagName}(?:\\s[^>]*)?>([^<]*)<\\/(?:[\\w-]+:)?${tagName}>`, 'i');
  return re.exec(block)?.[1];
}

function extractAttr(openTag: string, attrName: string): string | undefined {
  const re = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i');
  return re.exec(openTag)?.[1];
}

function parseTcx(text: string): ParsedActivity {
  const blocks = text.match(/<Trackpoint\b[\s\S]*?<\/Trackpoint>/gi) ?? [];
  const candidates: RawCandidate[] = [];
  let discardedCount = 0;

  for (const block of blocks) {
    const lat = parseNum(extractTag(block, 'LatitudeDegrees'));
    const lon = parseNum(extractTag(block, 'LongitudeDegrees'));
    const timeText = extractTag(block, 'Time');
    const timeMs = timeText != null ? Date.parse(timeText) : NaN;
    if (lat == null || lon == null || !Number.isFinite(timeMs)) {
      discardedCount++;
      continue;
    }
    const ele = parseNum(extractTag(block, 'AltitudeMeters'));
    const distM = parseNum(extractTag(block, 'DistanceMeters'));
    // Il campo potenza nei TCX vive quasi sempre dentro <Extensions><TPX>...<Watts>, ma
    // alcuni esportatori lo mettono a livello Trackpoint diretto — extractTag cerca
    // ovunque nel blocco, indipendentemente dalla profondità di nesting.
    const powerW = parseNum(extractTag(block, 'Watts'));
    candidates.push({ lat, lon, ele, timeMs, powerW, distM });
  }

  return finalize(candidates, 'tcx', discardedCount);
}

function parseGpxActivity(text: string): ParsedActivity {
  const blocks = text.match(/<trkpt\b[^>]*>[\s\S]*?<\/trkpt>/gi) ?? [];
  const candidates: RawCandidate[] = [];
  let discardedCount = 0;

  for (const block of blocks) {
    const openTagMatch = /^<trkpt\b[^>]*>/i.exec(block);
    const openTag = openTagMatch?.[0] ?? '';
    const lat = parseNum(extractAttr(openTag, 'lat'));
    const lon = parseNum(extractAttr(openTag, 'lon'));
    const timeText = extractTag(block, 'time');
    const timeMs = timeText != null ? Date.parse(timeText) : NaN;
    if (lat == null || lon == null || !Number.isFinite(timeMs)) {
      discardedCount++;
      continue;
    }
    const ele = parseNum(extractTag(block, 'ele'));
    // Nessuno standard unico per la potenza nei GPX: si provano i pattern più comuni fra
    // gli export dei device (Garmin PowerExtension: <power>; alcuni tool: <PowerInWatts>).
    const powerW = parseNum(extractTag(block, 'power')) ?? parseNum(extractTag(block, 'PowerInWatts'));
    candidates.push({ lat, lon, ele, timeMs, powerW, distM: null });
  }

  return finalize(candidates, 'gpx', discardedCount);
}

function finalize(candidates: RawCandidate[], format: 'tcx' | 'gpx', discardedCount: number): ParsedActivity {
  if (candidates.length === 0) {
    throw new Error(
      format === 'tcx'
        ? 'File TCX non valido: nessun <Trackpoint> con coordinate e orario validi trovato.'
        : 'File GPX non valido: nessun <trkpt> con coordinate e orario validi trovato.'
    );
  }
  const t0 = candidates[0]!.timeMs!;
  const points: ActivityTrackPoint[] = candidates.map(c => ({
    lat: c.lat,
    lon: c.lon,
    ele: c.ele,
    timeSec: (c.timeMs! - t0) / 1000,
    powerW: c.powerW,
    distM: c.distM
  }));
  const hasPower = points.some(p => p.powerW != null && p.powerW > 0);

  return { points, format, hasPower, discardedCount, startTimeIso: new Date(t0).toISOString() };
}

/** Autodetect TCX vs GPX dal contenuto (non dal nome file, spesso inaffidabile). */
export function parseActivityText(text: string): ParsedActivity {
  const isTcx = /<Trackpoint\b/.test(text) || /<TrainingCenterDatabase\b/i.test(text);
  return isTcx ? parseTcx(text) : parseGpxActivity(text);
}
