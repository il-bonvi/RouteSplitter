import type { PhysicsParams } from '@shared-schema';
import { NumberField } from './NumberField.js';

interface PhysicsParamsPanelProps {
  params: PhysicsParams;
  onChange: (params: PhysicsParams) => void;
  calcMode: 'speed' | 'power';
  onCalcModeChange: (mode: 'speed' | 'power') => void;
}

const FIELDS: Array<{ key: keyof PhysicsParams; label: string; step: number }> = [
  { key: 'riderMassKg', label: 'Peso ciclista (kg)', step: 0.5 },
  { key: 'bikeMassKg', label: 'Peso bici+kit (kg)', step: 0.1 },
  { key: 'cda', label: 'CdA (m²)', step: 0.005 },
  { key: 'crr', label: 'Crr', step: 0.0005 },
  { key: 'airDensity', label: 'Densità aria (kg/m³)', step: 0.001 },
  { key: 'drivetrainLossPct', label: 'Drivetrain loss (%)', step: 0.1 }
];

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
      <p className="physics-hint">
        <strong>Velocità</strong>: inserisci km/h per sezione → la tabella mostra la potenza richiesta.{' '}
        <strong>Potenza</strong>: inserisci i watt → la tabella mostra la velocità risultante. Il vento si imposta
        nel pannello 💨 Vento qui sotto (varia per direzione lungo il percorso).
      </p>
    </div>
  );
}
