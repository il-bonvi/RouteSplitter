import { useState } from 'react';
import { estimateCda, type PhysicsParams } from '@physics-core';
import { NumberField } from './NumberField.js';

interface CdaEstimatorProps {
  physicsParams: PhysicsParams;
  onApplyCda: (cda: number) => void;
}

export function CdaEstimator({ physicsParams, onApplyCda }: CdaEstimatorProps) {
  const [speedKmh, setSpeedKmh] = useState(36);
  const [powerW, setPowerW] = useState(250);
  const [gradePct, setGradePct] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runEstimate = () => {
    const cda = estimateCda(speedKmh / 3.6, powerW, gradePct, physicsParams);
    if (cda == null) {
      setResult(null);
      setErrorMsg('Dati non validi (forza aerodinamica ≤ 0 — controlla pendenza/potenza/velocità).');
    } else {
      setResult(cda);
      setErrorMsg(null);
    }
  };

  return (
    <div className="cda-box">
      <div className="physics-panel-title">Stima CdA da campo</div>
      <p className="physics-hint">
        Da un singolo campione medio (velocità/potenza/pendenza). Su tratti a pendenza o vento non uniformi il
        risultato può essere impreciso — vedi <code>stato_rs.md</code> per il dettaglio.
      </p>
      <div className="physics-grid">
        <label className="physics-field">
          <span>Velocità misurata (km/h)</span>
          <NumberField step={0.1} value={speedKmh} onCommit={setSpeedKmh} />
        </label>
        <label className="physics-field">
          <span>Potenza media (W)</span>
          <NumberField step={1} value={powerW} onCommit={setPowerW} />
        </label>
        <label className="physics-field">
          <span>Pendenza media (%)</span>
          <NumberField step={0.1} value={gradePct} onCommit={setGradePct} />
        </label>
      </div>
      <div className="pacing-actions">
        <button type="button" onClick={runEstimate}>
          Stima CdA
        </button>
        {result != null && (
          <button type="button" className="pacing-full" onClick={() => onApplyCda(result)}>
            Applica {result.toFixed(3)} m²
          </button>
        )}
      </div>
      {errorMsg && <p className="app-error">{errorMsg}</p>}
    </div>
  );
}
