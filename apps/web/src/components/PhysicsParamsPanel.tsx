import type { PhysicsParams } from '@shared-schema';
import { NumberField } from './NumberField.js';

interface PhysicsParamsPanelProps {
  params: PhysicsParams;
  onChange: (params: PhysicsParams) => void;
  calcMode: 'speed' | 'power';
  onCalcModeChange: (mode: 'speed' | 'power') => void;
}

const FIELDS: Array<{ key: Exclude<keyof PhysicsParams, 'cdaTiers'>; label: string; step: number }> = [
  { key: 'riderMassKg', label: 'Peso ciclista (kg)', step: 0.5 },
  { key: 'bikeMassKg', label: 'Peso bici+kit (kg)', step: 0.1 },
  { key: 'cda', label: 'CdA (m²)', step: 0.005 },
  { key: 'crr', label: 'Crr', step: 0.0005 },
  { key: 'airDensity', label: 'Densità aria (kg/m³)', step: 0.001 },
  { key: 'drivetrainLossPct', label: 'Drivetrain loss (%)', step: 0.1 }
];

const MAX_CDA_TIERS = 8;

/**
 * Editor per un CdA che cambia con la pendenza — 0, 1 o più soglie, tutte opzionali: con 0
 * (default) il comportamento è quello storico, un solo CdA per tutto il percorso; con N
 * soglie, ognuna vale da una certa pendenza in su finché non viene superata da una soglia
 * più alta (vedi `effectiveCda` in physics-core/physics.ts, che applica esattamente questa
 * logica — qui si costruisce solo l'array `cdaTiers`, non serve tenerlo ordinato a mano).
 */
function CdaTiersEditor({ params, onChange }: { params: PhysicsParams; onChange: (params: PhysicsParams) => void }) {
  const tiers = params.cdaTiers ?? [];
  const enabled = tiers.length > 0;

  function setTiers(next: { thresholdPct: number; cda: number }[]) {
    const sorted = [...next].sort((a, b) => a.thresholdPct - b.thresholdPct);
    onChange({ ...params, cdaTiers: sorted.length > 0 ? sorted : undefined });
  }

  function toggle(checked: boolean) {
    if (checked) {
      // Punto di partenza ragionevole: un filo più alto del CdA base, soglia di pendenza
      // tipica per un cambio di posizione percepibile — l'utente li affina da qui.
      setTiers([{ thresholdPct: 5, cda: Math.min(0.6, params.cda + 0.03) }]);
    } else {
      onChange({ ...params, cdaTiers: undefined });
    }
  }

  function addTier() {
    const last = tiers[tiers.length - 1];
    const nextThreshold = last ? Math.min(20, last.thresholdPct + 3) : 5;
    const nextCda = last ? Math.min(0.6, last.cda + 0.02) : Math.min(0.6, params.cda + 0.03);
    setTiers([...tiers, { thresholdPct: nextThreshold, cda: nextCda }]);
  }

  function removeTier(i: number) {
    setTiers(tiers.filter((_, idx) => idx !== i));
  }

  function updateTier(i: number, patch: Partial<{ thresholdPct: number; cda: number }>) {
    // Non riordina ad ogni tasto premuto (spiazzerebbe l'utente mentre digita la soglia):
    // aggiorna in place mantenendo la posizione della riga; l'ordinamento vero e proprio
    // avviene solo quando si aggiunge/toglie una soglia o si spegne/riaccende il toggle.
    onChange({ ...params, cdaTiers: tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) });
  }

  return (
    <>
      <label className="physics-checkbox-field">
        <input type="checkbox" checked={enabled} onChange={e => toggle(e.target.checked)} />
        <span>CdA variabile con la pendenza (una o più soglie)</span>
      </label>
      {enabled && (
        <div className="cda-tiers">
          {tiers.map((tier, i) => (
            <div className="cda-tier-row" key={i}>
              <span>da</span>
              <NumberField step={0.5} min={0} max={20} value={tier.thresholdPct} onCommit={v => updateTier(i, { thresholdPct: v })} />
              <span>% pendenza →</span>
              <NumberField step={0.005} min={0.15} max={0.6} value={tier.cda} onCommit={v => updateTier(i, { cda: v })} />
              <span>m²</span>
              <button type="button" className="cda-tier-remove" onClick={() => removeTier(i)} title="Rimuovi questa soglia">
                ✕
              </button>
            </div>
          ))}
          <div className="pacing-actions">
            <button type="button" className="btn btn-sm ghost" onClick={addTier} disabled={tiers.length >= MAX_CDA_TIERS}>
              + Aggiungi soglia
            </button>
          </div>
          <p className="physics-hint">
            Sotto la soglia più bassa si usa il CdA base ({params.cda.toFixed(3)} m²) qui sopra. Non serve inserirle
            in ordine — si riordinano da sole. Colonna "CdA" in tabella per vedere quale valore è stato usato in
            ciascuna sezione.
          </p>
        </div>
      )}
    </>
  );
}

export function PhysicsParamsPanel({ params, onChange, calcMode, onCalcModeChange }: PhysicsParamsPanelProps) {
  return (
    <div className="physics-panel">
      <div className="physics-panel-header">
        <span className="physics-panel-title">Parametri fisici</span>
        <div className="mode-toggle">
          <button type="button" className={calcMode === 'speed' ? 'active' : ''} onClick={() => onCalcModeChange('speed')}>
            Velocità
          </button>
          <button type="button" className={calcMode === 'power' ? 'active' : ''} onClick={() => onCalcModeChange('power')}>
            Potenza
          </button>
        </div>
      </div>
      <div className="physics-grid">
        {FIELDS.map(field => (
          <label key={field.key} className="physics-field">
            <span>{field.label}</span>
            <NumberField step={field.step} value={params[field.key]} onCommit={v => onChange({ ...params, [field.key]: v })} />
          </label>
        ))}
      </div>
      <CdaTiersEditor params={params} onChange={onChange} />
      <p className="physics-hint">
        <strong>Velocità</strong>: inserisci km/h per sezione → la tabella mostra la potenza richiesta.{' '}
        <strong>Potenza</strong>: inserisci i watt → la tabella mostra la velocità risultante. Il vento si imposta
        nel pannello 💨 Vento qui sotto (varia per direzione lungo il percorso).
      </p>
    </div>
  );
}
