import { useState } from 'react';
import type { PhysicsParams } from '@physics-core';
import type { Tire } from '@shared-schema';
import { NumberField } from './NumberField.js';

interface AthleteProfileCardProps {
  physicsParams: PhysicsParams;
  onPhysicsParamsChange: (params: PhysicsParams) => void;
  /** CP/W' (D48), sollevati a livello di app — stesso stato condiviso con l'ottimizzatore
   * (Tab 1/3) e i grafici W'bal. Qui in più diventano PERSISTENTI (vedi `onSaveProfile`). */
  criticalPowerW: number | '';
  onCriticalPowerWChange: (v: number | '') => void;
  wPrimeJ: number | '';
  onWPrimeJChange: (v: number | '') => void;
  tires: Tire[];
  onSaveProfile: (patch: { weightKg?: number; criticalPowerW?: number; wPrimeJ?: number }) => Promise<void>;
  onAddTire: (name: string, crr: number) => Promise<void>;
  onDeleteTire: (tireId: string) => Promise<void>;
}

/**
 * "So già questi valori, li inserisco io" — a differenza di CdA (stimato dai dati), peso/CP/W'
 * sono numeri che l'atleta conosce da sé (bilancia, test di campo) e non ha senso ricavare
 * dall'attività. Salvati una volta (IndexedDB, tramite `onSaveProfile`), restano impostati
 * anche dopo un reload — a differenza dello stato React "nudo" usato finora per CP/W' (D48/49)
 * e per `physicsParams`, che si azzerava ogni volta.
 *
 * Il Crr è un'eccezione deliberata: NON è una proprietà dell'atleta ma del pneumatico
 * montato — un atleta ne ha diversi (asfalto liscio, gravel, bagnato...) e sceglie quale usare
 * per QUESTA specifica analisi, non un default fisso. Per questo i pneumatici sono
 * un'entità salvabile a parte (elenco riutilizzabile), e "Usa" scrive il Crr scelto nei
 * `physicsParams` correnti — un'azione per-analisi, non un salvataggio permanente.
 */
export function AthleteProfileCard({
  physicsParams,
  onPhysicsParamsChange,
  criticalPowerW,
  onCriticalPowerWChange,
  wPrimeJ,
  onWPrimeJChange,
  tires,
  onSaveProfile,
  onAddTire,
  onDeleteTire
}: AthleteProfileCardProps) {
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [newTireName, setNewTireName] = useState('');
  const [newTireCrr, setNewTireCrr] = useState(0.004);
  const [addingTire, setAddingTire] = useState(false);
  const [tireError, setTireError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveProfile({
        weightKg: physicsParams.riderMassKg,
        criticalPowerW: criticalPowerW === '' ? undefined : criticalPowerW,
        wPrimeJ: wPrimeJ === '' ? undefined : wPrimeJ
      });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Errore durante il salvataggio.');
    } finally {
      setSaving(false);
    }
  };

  const handleAddTire = async () => {
    const name = newTireName.trim();
    if (!name) return;
    setAddingTire(true);
    setTireError(null);
    try {
      await onAddTire(name, newTireCrr);
      setNewTireName('');
    } catch (err) {
      setTireError(err instanceof Error ? err.message : 'Errore durante il salvataggio del pneumatico.');
    } finally {
      setAddingTire(false);
    }
  };

  return (
    <div className="athlete-profile-card">
      <h3>Profilo atleta</h3>
      <p className="physics-hint">
        Peso, CP e W' salvati una volta sola — restano impostati anche dopo un reload, e valgono in tutte le tab
        (ottimizzatore, W'bal, stima CdA).
      </p>

      <div className="athlete-profile-fields">
        <label className="physics-field">
          <span>Peso (kg)</span>
          <NumberField
            value={physicsParams.riderMassKg}
            step={0.5}
            min={30}
            max={160}
            onCommit={v => onPhysicsParamsChange({ ...physicsParams, riderMassKg: v })}
          />
        </label>
        <label className="physics-field" title="Lascia vuoto per non applicare alcun vincolo di fatica altrove nell'app.">
          <span>CP (W)</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="—"
            value={criticalPowerW}
            onChange={e => {
              const raw = e.target.value;
              if (raw.trim() === '') {
                onCriticalPowerWChange('');
                return;
              }
              const parsed = parseFloat(raw);
              if (!Number.isNaN(parsed)) onCriticalPowerWChange(parsed);
            }}
          />
        </label>
        <label className="physics-field" title="Riserva anaerobica, in Joule (es. 22000).">
          <span>W' (J)</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="—"
            value={wPrimeJ}
            onChange={e => {
              const raw = e.target.value;
              if (raw.trim() === '') {
                onWPrimeJChange('');
                return;
              }
              const parsed = parseFloat(raw);
              if (!Number.isNaN(parsed)) onWPrimeJChange(parsed);
            }}
          />
        </label>
      </div>

      <div className="athlete-profile-save-row">
        <button type="button" className="pacing-full" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Salvataggio…' : justSaved ? '✓ Salvato' : '💾 Salva profilo'}
        </button>
        {saveError && <span className="app-error">{saveError}</span>}
      </div>

      <div className="athlete-tires-section">
        <h4>Pneumatici</h4>
        <p className="physics-hint">
          Il Crr dipende dal pneumatico montato, non dall'atleta: salva qui i tuoi pneumatici e scegli quale usare
          per questa analisi — "Usa" scrive il Crr nei parametri fisici correnti, non è un default permanente.
        </p>

        {tires.length > 0 && (
          <div className="tires-list">
            {tires.map(t => {
              const active = Math.abs(t.crr - physicsParams.crr) < 1e-9;
              return (
                <div key={t.id} className={`tire-row${active ? ' tire-row-active' : ''}`}>
                  <span>
                    {t.name} <span className="physics-hint">Crr {t.crr.toFixed(4)}</span>
                  </span>
                  <button
                    type="button"
                    className="pacing-full"
                    disabled={active}
                    onClick={() => onPhysicsParamsChange({ ...physicsParams, crr: t.crr })}
                  >
                    {active ? '✓ In uso' : 'Usa'}
                  </button>
                  <button type="button" className="btn btn-sm ghost" onClick={() => void onDeleteTire(t.id)}>
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="tire-add-row">
          <input
            type="text"
            placeholder="Nome (es. GP5000 asciutto)"
            value={newTireName}
            onChange={e => setNewTireName(e.target.value)}
          />
          <NumberField value={newTireCrr} step={0.0005} min={0.001} max={0.03} onCommit={setNewTireCrr} />
          <button type="button" className="btn btn-sm" disabled={!newTireName.trim() || addingTire} onClick={() => void handleAddTire()}>
            {addingTire ? '…' : '+ Aggiungi'}
          </button>
        </div>
        {tireError && <p className="app-error">{tireError}</p>}
      </div>
    </div>
  );
}
