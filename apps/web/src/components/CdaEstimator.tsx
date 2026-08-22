import { useState } from 'react';
import { estimateCda, type PhysicsParams } from '@physics-core';
import { NumberField } from './NumberField.js';

interface CdaEstimatorProps {
  physicsParams: PhysicsParams;
  /** target 'base' = sovrascrive il CdA base; un numero = indice della soglia in cdaTiers da sovrascrivere. */
  onApplyCda: (cda: number, target: 'base' | number) => void;
}

export function CdaEstimator({ physicsParams, onApplyCda }: CdaEstimatorProps) {
  // Collassato di default: è un tool da usare ogni tanto (dopo un test in campo), non
  // qualcosa da tenere sempre aperto a occupare spazio nel pannello parametri.
  const [expanded, setExpanded] = useState(false);
  const [speedKmh, setSpeedKmh] = useState(36);
  const [powerW, setPowerW] = useState(250);
  const [gradePct, setGradePct] = useState(0);
  const [windKmh, setWindKmh] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runEstimate = () => {
    const cda = estimateCda(speedKmh / 3.6, powerW, gradePct, { ...physicsParams, windKmh });
    if (cda == null) {
      setResult(null);
      setErrorMsg('Dati non validi (forza aerodinamica ≤ 0 — controlla pendenza/potenza/velocità).');
    } else {
      setResult(cda);
      setErrorMsg(null);
    }
  };

  // Se sono configurate soglie CdA, capisce quale soglia si applicherebbe REALMENTE a un
  // giro fatto alla pendenza appena misurata (stessa logica di effectiveCda: la soglia più
  // alta fra quelle raggiunte) — un test fatto al 12% deve proporre di aggiornare la soglia
  // che copre il 12%, non un'altra a caso, né il CdA base se una soglia è comunque attiva.
  const tiers = physicsParams.cdaTiers ?? [];
  let activeTierIdx: number | null = null;
  let bestThreshold = -Infinity;
  tiers.forEach((tier, i) => {
    if (gradePct >= tier.thresholdPct && tier.thresholdPct > bestThreshold) {
      bestThreshold = tier.thresholdPct;
      activeTierIdx = i;
    }
  });

  return (
    <div className="cda-box">
      <button type="button" className="cda-box-header" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
        <span className={`cda-box-chevron${expanded ? ' expanded' : ''}`}>▶</span>
        <span className="physics-panel-title cda-box-title">Stima CdA da campo</span>
      </button>
      {expanded && (
        <div className="cda-box-body">
          <p className="physics-hint">
            Da un singolo campione medio (velocità/potenza/pendenza/vento). Su tratti a pendenza o vento non uniformi
            il risultato può essere impreciso — vedi <code>stato_rs.md</code> per il dettaglio.
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
            <label className="physics-field">
              <span>Vento durante la misura (km/h, +testa)</span>
              <NumberField step={0.5} value={windKmh} onCommit={setWindKmh} />
            </label>
          </div>
          <div className="pacing-actions">
            <button type="button" onClick={runEstimate}>
              Stima CdA
            </button>
            {result != null && tiers.length === 0 && (
              <button type="button" className="pacing-full" onClick={() => onApplyCda(result, 'base')}>
                Applica {result.toFixed(3)} m²
              </button>
            )}
            {result != null && tiers.length > 0 && (
              <>
                <button
                  type="button"
                  className={activeTierIdx === null ? 'pacing-full' : ''}
                  onClick={() => onApplyCda(result, 'base')}
                >
                  Applica {result.toFixed(3)} m² come CdA base (piano)
                </button>
                {activeTierIdx !== null && (
                  <button type="button" className="pacing-full" onClick={() => onApplyCda(result, activeTierIdx!)}>
                    Applica {result.toFixed(3)} m² alla soglia ≥{tiers[activeTierIdx]!.thresholdPct}%
                  </button>
                )}
              </>
            )}
          </div>
          {errorMsg && <p className="app-error">{errorMsg}</p>}
        </div>
      )}
    </div>
  );
}
