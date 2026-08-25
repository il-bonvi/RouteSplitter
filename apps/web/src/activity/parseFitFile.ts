/**
 * Parsing di file FIT (formato binario nativo dei ciclocomputer) per la stima CdA
 * multi-punto. A differenza di TCX/GPX (testo, parsing a regex in `parseActivityFile.ts`),
 * il FIT è un formato binario con record/definizioni a lunghezza variabile e CRC — qui non
 * ha senso reimplementarlo a mano: si usa `@garmin/fitsdk`, l'SDK JavaScript ufficiale di
 * Garmin (zero dipendenze proprie, stessa libreria usata da Garmin Connect), che decodifica
 * il file e applica già scala/offset del profilo FIT ai valori (quota in metri, potenza in
 * W, distanza in metri — non i valori grezzi memorizzati nel file).
 *
 * Le coordinate nei messaggi "record" del FIT sono in semicerchi (unità nativa del
 * protocollo, non convertita dallo SDK): 1 semicerchio = 180/2^31 gradi.
 */
import { Decoder, Stream } from '@garmin/fitsdk';
import type { ActivityTrackPoint, ParsedActivity } from './parseActivityFile.js';

const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

interface RawFitRecord {
  positionLat?: number;
  positionLong?: number;
  altitude?: number;
  power?: number;
  distance?: number;
  timestamp?: Date;
}

export async function parseFitFile(file: File): Promise<ParsedActivity> {
  const buffer = await file.arrayBuffer();
  const stream = Stream.fromArrayBuffer(buffer);

  if (!Decoder.isFIT(stream)) {
    throw new Error('File non valido: intestazione ".FIT" non trovata (il file non sembra un FIT).');
  }

  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    convertDateTimesToDates: true,
    mergeHeartRates: false,
    expandSubFields: false,
    expandComponents: false,
    decodeMemoGlobs: false
  });

  const records = (messages as { recordMesgs?: RawFitRecord[] }).recordMesgs;
  if (!records || records.length === 0) {
    const detail = errors.length > 0 ? `: ${errors[0]?.message ?? errors[0]}` : '.';
    throw new Error(`Il file FIT non contiene punti traccia validi${detail}`);
  }

  let discardedCount = 0;
  const candidates: {
    lat: number;
    lon: number;
    ele: number | null;
    timeMs: number;
    powerW: number | null;
    distM: number | null;
  }[] = [];

  for (const r of records) {
    const lat = typeof r.positionLat === 'number' ? r.positionLat * SEMICIRCLES_TO_DEGREES : null;
    const lon = typeof r.positionLong === 'number' ? r.positionLong * SEMICIRCLES_TO_DEGREES : null;
    const timeMs = r.timestamp instanceof Date ? r.timestamp.getTime() : null;
    if (lat == null || lon == null || timeMs == null) {
      discardedCount++;
      continue;
    }
    candidates.push({
      lat,
      lon,
      ele: typeof r.altitude === 'number' ? r.altitude : null,
      timeMs,
      powerW: typeof r.power === 'number' ? r.power : null,
      distM: typeof r.distance === 'number' ? r.distance : null
    });
  }

  if (candidates.length === 0) {
    throw new Error('File FIT non valido: nessun punto con coordinate e orario validi trovato.');
  }

  const t0 = candidates[0]!.timeMs;
  const points: ActivityTrackPoint[] = candidates.map(c => ({
    lat: c.lat,
    lon: c.lon,
    ele: c.ele,
    timeSec: (c.timeMs - t0) / 1000,
    powerW: c.powerW,
    distM: c.distM
  }));
  const hasPower = points.some(p => p.powerW != null && p.powerW > 0);

  return { points, format: 'fit', hasPower, discardedCount };
}
