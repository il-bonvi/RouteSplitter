import { useState } from 'react';
import { optimizePacingDynamic, type ProcessedPoint, type SectionBreakpoint, type PhysicsParams, type FatigueParams } from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';
import { breakpointsToSegments, buildFineGrid, mapFinePowersToBreakpoints, type FineSegment } from '../lib/pacingActions.js';
import { NumberField } from './NumberField.js';
import { formatTime } from '../lib/formatTime.js';
import { PowerPlanModal } from './PowerPlanModal.js';

interface PacingOptimizerPanelProps {
  breakpoints: SectionBreakpoint[];
  processedPoints: ProcessedPoint[];
  physicsParams: PhysicsParams;
  totalDistanceKm: number;
  windZones: WindZoneBoundary[];
  onApplyPowers: (updates: Map<string, number>) => void;
  /**
   * Finestra di smoothing pendenza (m, 0-100 a gradini di 10) — persistita nel piano
   * (`SectionPlan.smoothingWindowMeters`), non più stato locale del pannello: è l'unica fonte
   * di verità condivisa anche col confronto a microsezioni (Tab 3). Serve due scopi con un
   * solo numero (D43, un solo motore fisico in tutta l'app): smussa la pendenza vista dalla
   * simulazione dinamica E, per "Ottimizza completo", fa anche da passo della griglia fine su
   * cui l'ottimizzatore lavora (con un minimo di 10m anche quando la finestra è "grezza"/0,
   * altrimenti la griglia sarebbe degenere).
   */
  smoothingWindowMeters: number;
  onSmoothingWindowMetersChange: (smoothingWindowMeters: number) => void;
  /** Vedi `computeDynamicSections`/`optimizePacingDynamic` — serve per il vento orario a zone. */
  plannedStartMinuteOfDay: number | null;
  /**
   * CP/W' (D48): proprietà dell'ATLETA, non del piano — per questo non dentro physicsParams
   * (che modella solo l'equilibrio aerodinamico/di massa). Sollevato a livello di app (come
   * physicsParams) invece che stato locale di questo pannello: serve anche al grafico di
   * confronto in Tab 3 (`ActivityElevationChart`), che non ha altrimenti modo di conoscere il
   * CP/W' scelto qui. '' = non impostato, nessun vincolo di fatica applicato.
   */
  criticalPowerW: number | '';
  onCriticalPowerWChange: (v: number | '') => void;
  /** W' in JOULE — stessa unità con cui si ragiona di solito il proprio CP/W' (es. "22000J"),
   * NON kJ: un campo etichettato "kJ" in cui si digita per abitudine il numero in Joule già
   * noto (es. "22000" invece di "22") produce una riserva 1000 volte troppo grande — esattamente
   * il bug osservato in sessione (W'bal che non si abbassa mai, perché una riserva così enorme
   * non si esaurisce mai su una gara di durata normale). Joule diretti eliminano l'ambiguità. */
  wPrimeJ: number | '';
  onWPrimeJChange: (v: number | '') => void;
}

interface FineGridResult {
  segs: FineSegment[];
  powers: number[];
}

export function PacingOptimizerPanel({
  breakpoints,
  processedPoints,
  physicsParams,
  totalDistanceKm,
  windZones,
  onApplyPowers,
  smoothingWindowMeters,
  onSmoothingWindowMetersChange,
  plannedStartMinuteOfDay,
  criticalPowerW,
  onCriticalPowerWChange,
  wPrimeJ,
  onWPrimeJChange
}: PacingOptimizerPanelProps) {
  const [targetAvg, setTargetAvg] = useState(220);
  const [targetNp, setTargetNp] = useState<number | ''>('');
  const [minPower, setMinPower] = useState(100);
  const [maxPower, setMaxPower] = useState(400);
  const [resultText, setResultText] = useState<string | null>(null);
  const [fatigueWarning, setFatigueWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finePlan, setFinePlan] = useState<FineGridResult | null>(null);
  const [chartOpen, setChartOpen] = useState(false);

  const fatigue: FatigueParams | undefined =
    criticalPowerW !== '' && wPrimeJ !== '' && criticalPowerW > 0 && wPrimeJ > 0
      ? { criticalPowerW, wPrimeJ }
      : undefined;

  const windActive = windZones.length >= 2;
  // Vedi doc sul prop: 0 ("grezza") smussa al minimo la pendenza per la simulazione, ma la
  // griglia dell'ottimizzatore non può avere bin larghi 0 — usa comunque almeno 10m.
  const gridStepMeters = Math.max(10, smoothingWindowMeters);

  const runOnSections = () => {
    if (breakpoints.length < 2) return;
    setBusy(true);
    setFatigueWarning(null);
    try {
      const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
      const segs = breakpointsToSegments(sorted, processedPoints, windZones);
      const boundaries = segs.map((s, i) => ({ d0Km: sorted[i]!.distKm, d1Km: sorted[i + 1]!.distKm, gradient: s.gradient, windKmh: s.windKmh }));
      const result = optimizePacingDynamic(
        boundaries,
        processedPoints,
        physicsParams,
        { targetAvgPower: targetAvg, targetNormalizedPower: targetNp === '' ? null : targetNp, minPower, maxPower, fatigue },
        { windZones, plannedStartMinuteOfDay, gradientSmoothingM: smoothingWindowMeters }
      );
      const updates = new Map<string, number>();
      for (let i = 1; i < sorted.length; i++) updates.set(sorted[i]!.id, Math.round(result.powers[i - 1]!));
      onApplyPowers(updates);
      if (result.fatigueInfeasible) {
        setFatigueWarning(
          `⚠️ Con questo CP/W' la media richiesta (${targetAvg}W) non è sostenibile su questo percorso — nemmeno a potenza costante. Il piano usa la potenza più piatta possibile, ma esaurirà comunque la riserva.`
        );
      }
      setResultText(
        `Sezioni${windActive ? ' (con vento)' : ''} · Tempo ${formatTime(result.totalTimeHours)} · Media ${result.timeWeightedAvgPower.toFixed(0)} W · NP ~${result.normalizedPower.toFixed(0)} W${
          result.minWBalJ !== null ? ` · W'bal min ${(result.minWBalJ / 1000).toFixed(1)} kJ` : ''
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  const runFullGrid = () => {
    if (breakpoints.length < 2) return;
    setBusy(true);
    setFatigueWarning(null);
    try {
      const fineSegs = buildFineGrid(totalDistanceKm, gridStepMeters / 1000, processedPoints, windZones);
      const boundaries = fineSegs.map(s => ({ d0Km: s.d0Km, d1Km: s.d1Km, gradient: s.gradient, windKmh: s.windKmh }));
      const result = optimizePacingDynamic(
        boundaries,
        processedPoints,
        physicsParams,
        { targetAvgPower: targetAvg, targetNormalizedPower: targetNp === '' ? null : targetNp, minPower, maxPower, fatigue },
        { windZones, plannedStartMinuteOfDay, gradientSmoothingM: smoothingWindowMeters }
      );
      const updates = mapFinePowersToBreakpoints(breakpoints, fineSegs, result.powers);
      onApplyPowers(updates);
      setFinePlan({ segs: fineSegs, powers: result.powers });
      if (result.fatigueInfeasible) {
        setFatigueWarning(
          `⚠️ Con questo CP/W' la media richiesta (${targetAvg}W) non è sostenibile su questo percorso — nemmeno a potenza costante. Il piano usa la potenza più piatta possibile, ma esaurirà comunque la riserva.`
        );
      }
      setResultText(
        `Completo${windActive ? ' (con vento)' : ''} (${fineSegs.length} × ${gridStepMeters}m) · Tempo ${formatTime(result.totalTimeHours)} · Media ${result.timeWeightedAvgPower.toFixed(0)} W · NP ~${result.normalizedPower.toFixed(0)} W${
          result.minWBalJ !== null ? ` · W'bal min ${(result.minWBalJ / 1000).toFixed(1)} kJ` : ''
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pacing-panel">
      <div className="physics-panel-title">
        Ottimizzatore di pacing (dinamico)
        {windActive && (
          <span className="pacing-wind-badge" title="Tiene conto delle zone vento definite">
            🌬️ con vento
          </span>
        )}
      </div>
      <div className="physics-grid">
        <label className="physics-field">
          <span>Media target (W)</span>
          <NumberField value={targetAvg} onCommit={setTargetAvg} />
        </label>
        <label className="physics-field">
          <span>NP target (opz.)</span>
          <input
            type="text"
            inputMode="decimal"
            value={targetNp}
            placeholder="—"
            onChange={e => {
              const raw = e.target.value;
              if (raw.trim() === '') {
                setTargetNp('');
                return;
              }
              const parsed = parseFloat(raw);
              if (!Number.isNaN(parsed)) setTargetNp(parsed);
            }}
          />
        </label>
        <label className="physics-field">
          <span>Potenza min (W)</span>
          <NumberField value={minPower} onCommit={setMinPower} />
        </label>
        <label className="physics-field">
          <span>Potenza max (W)</span>
          <NumberField value={maxPower} onCommit={setMaxPower} />
        </label>
        <label
          className="physics-field"
          title="Smussa la pendenza vista dalla simulazione (0 = grezza, come nel GPX) e fa anche da passo della griglia per 'Ottimizza completo' — un solo numero per entrambi gli usi, a gradini di 10m come il grafico altimetria."
        >
          <span>Smoothing pendenza (m)</span>
          <NumberField min={0} max={100} step={10} value={smoothingWindowMeters} onCommit={onSmoothingWindowMetersChange} />
        </label>
        <label className="physics-field" title="Vincolo DURO (D48): il piano non scenderà mai sotto W'bal=0. Lascia vuoto per non applicare alcun vincolo di fatica.">
          <span>CP (W, opz.)</span>
          <input
            type="text"
            inputMode="decimal"
            value={criticalPowerW}
            placeholder="—"
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
        <label className="physics-field" title="Riserva anaerobica W', in Joule (es. 22000). Serve insieme a CP per attivare il vincolo di fatica.">
          <span>W' (J, opz.)</span>
          <input
            type="text"
            inputMode="decimal"
            value={wPrimeJ}
            placeholder="—"
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
      <div className="pacing-actions">
        <button type="button" disabled={busy} onClick={runOnSections}>
          Ottimizza sezioni
        </button>
        <button type="button" disabled={busy} className="pacing-full" onClick={runFullGrid}>
          Ottimizza completo
        </button>
        {finePlan && (
          <button type="button" className="pacing-chart-btn" onClick={() => setChartOpen(true)}>
            📈 Grafico potenza prevista
          </button>
        )}
      </div>
      {resultText && <p className="pacing-result">{resultText}</p>}
      {fatigueWarning && <p className="pacing-result" style={{ color: 'var(--accent-warn, #f59e0b)' }}>{fatigueWarning}</p>}

      {finePlan && (
        <PowerPlanModal
          open={chartOpen}
          onClose={() => setChartOpen(false)}
          segs={finePlan.segs}
          powers={finePlan.powers}
          physicsParams={physicsParams}
          processedPoints={processedPoints}
          fatigue={fatigue}
        />
      )}
    </div>
  );
}
