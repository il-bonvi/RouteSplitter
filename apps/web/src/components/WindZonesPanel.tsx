import { useState } from 'react';
import type { WindZoneBoundary } from '@shared-schema';
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

interface WindZonesPanelProps {
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
  selectedZoneId: string | null;
  onSelectZone: (id: string) => void;
  onAddBoundary: (distKm: number) => void;
  onRemoveBoundary: (id: string) => void;
  onReset: () => void;
}

/**
 * Elenco compatto delle zone vento — la bussola per modificarle vive direttamente sulla mappa
 * (WindMapControl in RouteMap.tsx), non qui: qui ci si limita a creare/rimuovere confini e a
 * scegliere quale zona la bussola sulla mappa sta modificando in questo momento.
 */
export function WindZonesPanel({ windZones, totalDistanceKm, selectedZoneId, onSelectZone, onAddBoundary, onRemoveBoundary, onReset }: WindZonesPanelProps) {
  const [splitKm, setSplitKm] = useState(0);

  const sorted = [...windZones].sort((a, b) => a.distKm - b.distKm);
  const isUniform = sorted.length <= 2;
  // Ogni zona "utile" è delimitata da (confine precedente, confine attuale] e porta il vento
  // impostato sul confine attuale — il confine 'start' non ne ha uno proprio (vedi wind.ts).
  const zoneCards = sorted.slice(1);

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
        </>
      )}
    </div>
  );
}
