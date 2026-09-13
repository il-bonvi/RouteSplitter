import { useState } from 'react';
import type { PhysicsParams } from '@physics-core';
import { computeAirDensity } from '@physics-core';
import { fetchHistoricalWeather, averageWeatherOverWindow, type WeatherAverageWindow, type OpenMeteoHourlyPoint } from '../lib/openMeteo.js';

interface WeatherPanelProps {
  latitude: number | null;
  longitude: number | null;
  /** Istante di inizio attività (UTC, D55) — null se non disponibile (es. GPX senza tempi). */
  startTimeIso: string | null;
  durationHours: number;
  physicsParams: PhysicsParams;
  onPhysicsParamsChange: (params: PhysicsParams) => void;
  windSpeedKmh: number;
  windDirectionDeg: number;
  onWindChange: (speedKmh: number, directionDeg: number) => void;
  /** Nasconde il pulsante "Applica vento" — usato in Tab 3, dove il vento non è un unico
   * scalare ma un sistema di zone (`WindZonesPanel`): applicare una media dell'intera uscita
   * a "la zona attiva" sarebbe ambiguo e dipendente da uno stato di selezione mappa non
   * ovvio da qui. Il vento storico resta comunque visibile come confronto informativo.
   * Default true (mostrato) — comportamento invariato per Tab 2. */
  showApplyWind?: boolean;
  /** Riporta il risultato grezzo dell'ultimo fetch riuscito (null se non ancora richiesto,
   * fallito, o azzerato da un cambio file) — opzionale: usato da Tab 3 (D57) per il confronto
   * "con vs senza densità dal meteo" sul bilancio energetico. Tab 2 non lo passa. */
  onResult?: (result: WeatherAverageWindow | null) => void;
  /** Riporta la serie ORARIA grezza (non mediata) dell'ultimo fetch riuscito — opzionale:
   * usato da Tab 3 (D61) per importare il vento storico come veri `WindTimeSample` nel
   * modello a zone esistente, non come uno scalare isolato. `onResult` resta la via preferita
   * per chi vuole solo il valore medio (es. la densità aria). */
  onHourlyResult?: (hourly: OpenMeteoHourlyPoint[] | null) => void;
}

/**
 * Recupero meteo storico (Open-Meteo, D56) per la data/luogo REALI di questa attività —
 * niente API key, endpoint pubblico gratuito per uso non commerciale. Un terzo modo di
 * riempire densità aria/vento in Tab 2, accanto a "inseriscilo a mano" (D53) e "stimalo dai
 * dati di potenza" (D54, solo per il vento): qui il dato viene da un archivio meteorologico
 * indipendente, utile proprio per VALIDARE gli altri due, non solo per comodità.
 *
 * Spento di default ("disattivabile", richiesta esplicita): nessuna chiamata di rete finché
 * l'atleta non lo accende esplicitamente — mai un fetch automatico a sua insaputa.
 *
 * Solo API storica per ora: la previsione (per pianificare una gara futura, Tab 1/3) è
 * un'estensione naturale ma volontariamente rimandata a quando servirà davvero quel caso
 * d'uso — stesso principio di scope-tight già seguito in tutta questa sessione.
 */
export function WeatherPanel({
  latitude,
  longitude,
  startTimeIso,
  durationHours,
  physicsParams,
  onPhysicsParamsChange,
  windSpeedKmh,
  windDirectionDeg,
  onWindChange,
  showApplyWind = true,
  onResult,
  onHourlyResult
}: WeatherPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WeatherAverageWindow | null>(null);

  const canFetch = enabled && latitude != null && longitude != null && startTimeIso != null;

  const handleFetch = async () => {
    if (latitude == null || longitude == null || startTimeIso == null) return;
    setLoading(true);
    setError(null);
    try {
      const hourly = await fetchHistoricalWeather(latitude, longitude, startTimeIso);
      const avg = averageWeatherOverWindow(hourly, startTimeIso, durationHours);
      if (avg.hoursUsed === 0) {
        setError(
          "Nessun dato orario disponibile per questa data/luogo (potrebbe essere troppo recente: l'archivio ha qualche giorno di ritardo)."
        );
        setResult(null);
        onResult?.(null);
        onHourlyResult?.(null);
        return;
      }
      setResult(avg);
      onResult?.(avg);
      onHourlyResult?.(hourly);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore durante il recupero dei dati meteo.');
      setResult(null);
      onResult?.(null);
      onHourlyResult?.(null);
    } finally {
      setLoading(false);
    }
  };

  const impliedAirDensity =
    result?.temperatureC != null && result?.surfacePressureHPa != null
      ? computeAirDensity(result.temperatureC, result.surfacePressureHPa)
      : null;

  return (
    <div className="weather-panel">
      <label className="weather-panel-toggle">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>Recupera dati meteo storici (Open-Meteo)</span>
      </label>

      {enabled && (
        <>
          <p className="physics-hint">
            Temperatura, pressione e vento REALI registrati per la data e il luogo di questa attività (archivio
            meteorologico indipendente) — utile sia per calcolare una densità dell'aria corretta sia come ulteriore
            confronto per il vento, accanto a bussola e stima fisica.
          </p>

          {latitude == null && <p className="physics-hint">Carica prima un'attività con coordinate valide.</p>}
          {latitude != null && startTimeIso == null && (
            <p className="physics-hint">Questo file non ha un orario di partenza valido: impossibile datare la richiesta meteo.</p>
          )}

          <button type="button" className="btn btn-sm" disabled={!canFetch || loading} onClick={() => void handleFetch()}>
            {loading ? 'Recupero…' : '🌦️ Recupera meteo storico'}
          </button>

          {error && <p className="app-error">{error}</p>}

          {result && (
            <div className="weather-panel-results">
              <div className="weather-panel-result-row">
                <span>
                  {result.temperatureC != null ? `${result.temperatureC.toFixed(1)} °C` : 'temp. n.d.'} ·{' '}
                  {result.surfacePressureHPa != null ? `${result.surfacePressureHPa.toFixed(0)} hPa` : 'press. n.d.'}
                  {impliedAirDensity != null ? ` → densità ${impliedAirDensity.toFixed(3)} kg/m³` : ''}
                  <span className="physics-hint"> (media su {result.hoursUsed}h)</span>
                </span>
                {impliedAirDensity != null && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onPhysicsParamsChange({ ...physicsParams, airDensity: impliedAirDensity })}
                  >
                    Applica densità
                  </button>
                )}
              </div>

              {result.windSpeedKmh != null && result.windDirectionDeg != null && (
                <div className="weather-panel-result-row">
                  <span>
                    Vento storico: {result.windSpeedKmh.toFixed(1)} km/h da {Math.round(result.windDirectionDeg)}°{' '}
                    <span className="physics-hint">
                      (bussola attuale: {windSpeedKmh.toFixed(1)} km/h da {Math.round(windDirectionDeg)}°)
                    </span>
                  </span>
                  {showApplyWind && (
                    <button type="button" className="btn btn-sm" onClick={() => onWindChange(result.windSpeedKmh!, result.windDirectionDeg!)}>
                      Applica vento
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
