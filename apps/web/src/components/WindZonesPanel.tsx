import { useState } from 'react';
import type { WindZoneBoundary } from '@shared-schema';
import { parseClockTimeToMinutes } from '@physics-core';
import { NumberField } from './NumberField.js';
import { cardinalName } from '../lib/windDisplay.js';

const KMH_PER_KNOT = 1.852;

/**
 * Piccolo convertitore km/h ↔ nodi, bidirezionale — utile perché i bollettini meteo marini/
 * di alcuni servizi vento (compresi molti report per il ciclismo costiero) usano i nodi,
 * mentre il resto dell'app lavora in km/h. Stato locale indipendente dalle zone vento: è solo
 * un calcolatore, non scrive né legge alcun dato del piano.
 */
function WindSpeedConverter() {
  const [kts, setKts] = useState(10);
  const [kmh, setKmh] = useState(round1(10 * KMH_PER_KNOT));

  return (
    <div className="wind-converter">
      <NumberField min={0} step={0.5} value={kmh} onCommit={v => { setKmh(v); setKts(round1(v / KMH_PER_KNOT)); }} className="wind-converter-input" />
      <span className="wind-converter-unit">km/h</span>
      <span className="wind-converter-eq">=</span>
      <NumberField min={0} step={0.5} value={kts} onCommit={v => { setKts(v); setKmh(round1(v * KMH_PER_KNOT)); }} className="wind-converter-input" />
      <span className="wind-converter-unit">kts</span>
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function minutesToHHmm(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60) % 24;
  const m = Math.floor(minuteOfDay % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface WindZonesPanelProps {
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
  selectedZoneId: string | null;
  onSelectZone: (id: string) => void;
  onAddBoundary: (distKm: number) => void;
  onRemoveBoundary: (id: string) => void;
  onReset: () => void;
  /** "HH:mm" o null — ora di partenza pianificata del piano (unica fonte, condivisa col report). */
  plannedStartTime: string | null;
  onAddTimeSample: (zoneId: string, minuteOfDay: number, speedKmh: number, directionDeg: number) => void;
  onRemoveTimeSample: (zoneId: string, sampleId: string) => void;
}

/**
 * Piccolo editor "vento nel tempo" per la zona selezionata — pensato per un futuro forecast
 * orario reale (vedi WindTimeSample in physics-core/wind.ts), oggi inserito a mano. Vuoto =
 * vento statico invariato (comportamento storico). Richiede un'ora di partenza pianificata
 * per avere senso (senza, non c'è modo di sapere a che ora del giorno si passerà per una
 * zona).
 */
function WindTimeSamplesEditor({
  zone,
  plannedStartTime,
  onAdd,
  onRemove
}: {
  zone: WindZoneBoundary;
  plannedStartTime: string | null;
  onAdd: (minuteOfDay: number, speedKmh: number, directionDeg: number) => void;
  onRemove: (sampleId: string) => void;
}) {
  const [time, setTime] = useState('12:00');
  const [speed, setSpeed] = useState(zone.speedKmh ?? 0);
  const [direction, setDirection] = useState(zone.directionDeg ?? 0);

  const samples = [...zone.timeSamples].sort((a, b) => a.minuteOfDay - b.minuteOfDay);

  if (plannedStartTime == null) {
    return (
      <p className="wind-panel-hint wind-time-hint">
        Imposta un'ora di partenza (in alto, "Ora partenza") per poter far variare il vento di questa zona nel tempo —
        utile per il vento termico di valle, o in futuro per un forecast orario reale.
      </p>
    );
  }

  return (
    <div className="wind-time-editor">
      <div className="wind-panel-hint">Vento nel tempo per questa zona (opzionale — vuoto = vento statico come sopra):</div>
      {samples.length > 0 && (
        <ul className="wind-time-samples-list">
          {samples.map(s => (
            <li key={s.id}>
              <span>
                {minutesToHHmm(s.minuteOfDay)} — {s.speedKmh.toFixed(0)} km/h da {cardinalName(s.directionDeg)}
              </span>
              <button type="button" className="wind-zone-remove" onClick={() => onRemove(s.id)} title="Rimuovi campione">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wind-time-add-row">
        <input type="time" value={time} onChange={e => setTime(e.target.value)} />
        <NumberField min={0} step={1} value={speed} onCommit={setSpeed} className="wind-converter-input" />
        <span>km/h da</span>
        <NumberField min={0} max={360} step={5} value={direction} onCommit={setDirection} className="wind-converter-input" />
        <span>°</span>
        <button
          type="button"
          className="btn btn-sm ghost"
          onClick={() => {
            const minuteOfDay = parseClockTimeToMinutes(time);
            if (minuteOfDay == null) return;
            onAdd(minuteOfDay, speed, direction);
          }}
        >
          + Aggiungi
        </button>
      </div>
    </div>
  );
}

/**
 * Elenco compatto delle zone vento — la bussola per modificarle vive direttamente sulla mappa
 * (WindMapControl in RouteMap.tsx), non qui: qui ci si limita a creare/rimuovere confini e a
 * scegliere quale zona la bussola sulla mappa sta modificando in questo momento.
 */
export function WindZonesPanel({
  windZones,
  totalDistanceKm,
  selectedZoneId,
  onSelectZone,
  onAddBoundary,
  onRemoveBoundary,
  onReset,
  plannedStartTime,
  onAddTimeSample,
  onRemoveTimeSample
}: WindZonesPanelProps) {
  const [splitKm, setSplitKm] = useState(0);

  const sorted = [...windZones].sort((a, b) => a.distKm - b.distKm);
  const isUniform = sorted.length <= 2;
  // Ogni zona "utile" è delimitata da (confine precedente, confine attuale] e porta il vento
  // impostato sul confine attuale — il confine 'start' non ne ha uno proprio (vedi wind.ts).
  const zoneCards = sorted.slice(1);
  const selectedZone = zoneCards.find(z => z.id === selectedZoneId) ?? zoneCards[zoneCards.length - 1] ?? null;

  return (
    <div className="wind-panel">
      <div className="wind-panel-header">
        <div className="physics-panel-title wind-panel-title-inline">💨 Vento</div>
        <WindSpeedConverter />
      </div>
      {sorted.length === 0 ? (
        <p className="wind-panel-hint">
          Nessun vento configurato (equivale a 0 su tutto il percorso).{' '}
          <button type="button" className="btn btn-sm" onClick={() => onAddBoundary(totalDistanceKm)}>
            Imposta vento
          </button>
        </p>
      ) : (
        <>
          <p className="wind-panel-hint">
            Trascina la bussola sulla mappa per impostare la direzione della zona selezionata (evidenziata sotto).
          </p>
          <div className="wind-zones-chips">
            {zoneCards.map((zone, i) => {
              const fromKm = sorted[i]!.distKm;
              const speed = zone.speedKmh ?? 0;
              const direction = zone.directionDeg ?? 0;
              const selected = zone.id === selectedZoneId;
              return (
                <div key={zone.id} className={`wind-zone-chip${selected ? ' selected' : ''}`} onClick={() => onSelectZone(zone.id)} role="button" tabIndex={0}>
                  <div className="wind-zone-chip-range">
                    {fromKm.toFixed(1)} → {zone.distKm.toFixed(1)} km
                  </div>
                  <div className="wind-zone-chip-wind">
                    {speed.toFixed(0)} km/h da {cardinalName(direction)}
                  </div>
                  {zone.fixed === false && (
                    <button
                      type="button"
                      className="wind-zone-remove"
                      onClick={e => {
                        e.stopPropagation();
                        onRemoveBoundary(zone.id);
                      }}
                      title="Unisci con la zona successiva"
                    >
                      ✕ zona
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="wind-panel-actions">
            <NumberField min={0} max={totalDistanceKm} step={0.1} value={splitKm} onCommit={setSplitKm} />
            <span>km</span>
            <button type="button" className="btn btn-sm ghost" onClick={() => onAddBoundary(splitKm)}>
              + Dividi qui
            </button>
            {!isUniform && (
              <button type="button" className="btn btn-sm ghost" onClick={onReset}>
                ↺ Vento uniforme
              </button>
            )}
          </div>
          {selectedZone && (
            <WindTimeSamplesEditor
              zone={selectedZone}
              plannedStartTime={plannedStartTime}
              onAdd={(minuteOfDay, speedKmh, directionDeg) => onAddTimeSample(selectedZone.id, minuteOfDay, speedKmh, directionDeg)}
              onRemove={sampleId => onRemoveTimeSample(selectedZone.id, sampleId)}
            />
          )}
        </>
      )}
    </div>
  );
}
