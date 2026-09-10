import type { PhysicsParams } from '@physics-core';
import { NumberField } from './NumberField.js';

interface RideConditionsPanelProps {
  physicsParams: PhysicsParams;
  onPhysicsParamsChange: (params: PhysicsParams) => void;
}

const FIELDS: Array<{ key: 'bikeMassKg' | 'crr' | 'airDensity' | 'drivetrainLossPct'; label: string; step: number }> = [
  { key: 'bikeMassKg', label: 'Peso bici+kit (kg)', step: 0.1 },
  { key: 'crr', label: 'Crr', step: 0.0005 },
  { key: 'airDensity', label: 'Densità aria (kg/m³)', step: 0.001 },
  { key: 'drivetrainLossPct', label: 'Drivetrain loss (%)', step: 0.1 }
];

/**
 * Questi 4 valori entrano DIRETTAMENTE nella regressione di `estimateCdaFromSamples`
 * (physics-core/cdaFromActivity.ts: `m = riderMassKg + bikeMassKg`, `crr`, `airDensity`,
 * `drivetrainLossPct` compaiono tutti nella formula) — un CdA stimato con valori sbagliati o
 * lasciati al default globale di un'altra tab è un numero che sembra preciso ma non significa
 * niente. A differenza del profilo atleta (peso/CP/W', persistiti), questi cambiano da uscita
 * a uscita (giornata, quota/temperatura, catena pulita o sporca, bici usata) — niente salvataggio
 * automatico qui: si impostano per QUESTA analisi, scrivendo negli stessi `physicsParams`
 * condivisi con le altre tab (nessuno stato parallelo — stesso principio "single source of
 * truth" già seguito ovunque nell'app). Il Crr qui è modificabile a mano ("a volte lo conosco
 * e basta") indipendentemente dai pneumatici salvati sopra, che restano una scorciatoia per
 * non doverlo ricordare a memoria — stesso valore, due modi di impostarlo.
 */
export function RideConditionsPanel({ physicsParams, onPhysicsParamsChange }: RideConditionsPanelProps) {
  return (
    <div className="ride-conditions-panel">
      <h3>Condizioni di questa attività</h3>
      <p className="physics-hint">
        Diversi da peso/CP/W': non sono proprietà dell'atleta, cambiano ad ogni uscita (bici usata, catena, quota,
        temperatura). Servono per una stima del CdA che abbia senso — altrimenti la regressione qui sotto usa
        qualunque valore sia rimasto impostato altrove.
      </p>
      <div className="ride-conditions-fields">
        {FIELDS.map(f => (
          <label key={f.key} className="physics-field">
            <span>{f.label}</span>
            <NumberField
              value={physicsParams[f.key]}
              step={f.step}
              onCommit={v => onPhysicsParamsChange({ ...physicsParams, [f.key]: v })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
