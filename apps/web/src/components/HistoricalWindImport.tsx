import { useState } from 'react';
import { fetchHistoricalWeather, hourlyToWindTimeSamples } from '../lib/openMeteo.js';

interface HistoricalWindImportProps {
  latitude: number | null;
  longitude: number | null;
  startTimeIso: string | null;
  durationHours: number;
  targetZoneId: string | null;
  targetZoneLabel: string | null;
  plannedStartTimeMissing: boolean;
  onImport: (zoneId: string, samples: Array<{ minuteOfDay: number; speedKmh: number; directionDeg: number }>) => Promise<void>;
}

/**
 * D62 — spostato QUI (dentro/accanto alla card "Zone vento") dopo il feedback diretto
 * dell'utente su D61: il pulsante di import viveva nella sezione "Bilancio energetico", lontano
 * dalla card dove il risultato è effettivamente visibile — "devo scrollare in basso, caricare,
 * importare, ri-scrollare in alto [...] il vento va aggiunto da qua". Fetch+conversione+import
 * in un solo click (niente pannello intermedio da aprire): il risultato compare nella chip
 * della zona subito sotto, nello stesso viewport.
 */
export function HistoricalWindImport({
  latitude,
  longitude,
  startTimeIso,
  durationHours,
  targetZoneId,
  targetZoneLabel,
  plannedStartTimeMissing,
  onImport
}: HistoricalWindImportProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const missingReason =
    latitude == null || longitude == null || startTimeIso == null
      ? "Carica prima un'attività reale (con data/orario validi) qui sopra."
      : targetZoneId == null
        ? 'Aggiungi prima una zona vento qui sotto.'
        : plannedStartTimeMissing
          ? "Imposta un'ora di partenza per il piano, altrimenti non si sa a che ora del giorno il piano passerà da qui."
          : null;

  const canImport = missingReason == null;

  const handleClick = async () => {
    if (!canImport || latitude == null || longitude == null || startTimeIso == null || targetZoneId == null) return;
    setStatus('loading');
    setMessage(null);
    try {
      const hourly = await fetchHistoricalWeather(latitude, longitude, startTimeIso);
      const samples = hourlyToWindTimeSamples(hourly, startTimeIso, durationHours);
      if (samples.length === 0) {
        setStatus('error');
        setMessage("Nessun dato di vento disponibile per questa data/luogo (l'archivio storico ha qualche giorno di ritardo).");
        return;
      }
      await onImport(targetZoneId, samples);
      setStatus('done');
      setMessage(`Importate ${samples.length} ore di vento storico nella zona${targetZoneLabel ? ` (${targetZoneLabel})` : ''}.`);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Errore durante il recupero del meteo storico.');
    }
  };

  return (
    <div className="wind-historical-import">
      <button type="button" className="btn btn-sm" disabled={!canImport || status === 'loading'} onClick={() => void handleClick()}>
        {status === 'loading' ? 'Recupero…' : '🌦️ Importa vento storico qui'}
      </button>
      {!canImport && <span className="physics-hint">{missingReason}</span>}
      {message && <span className={status === 'error' ? 'app-error' : 'physics-hint'}>{message}</span>}
    </div>
  );
}
