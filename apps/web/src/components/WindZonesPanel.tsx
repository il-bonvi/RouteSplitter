import { useState } from 'react';
import type { WindZoneBoundary } from '@shared-schema';
import { NumberField } from './NumberField.js';
import { cardinalName } from '../lib/windDisplay.js';

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
      <div className="physics-panel-title">💨 Vento</div>
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
