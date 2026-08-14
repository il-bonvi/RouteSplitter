import { useState } from 'react';
import { optimizePacing, type ProcessedPoint, type SectionBreakpoint, type PhysicsParams } from '@physics-core';
import { breakpointsToSegments, buildFineGrid, mapFinePowersToBreakpoints, type FineSegment } from '../lib/pacingActions.js';
import { NumberField } from './NumberField.js';
import { formatTime } from '../lib/formatTime.js';
import { PowerPlanModal } from './PowerPlanModal.js';

interface PacingOptimizerPanelProps {
  breakpoints: SectionBreakpoint[];
  processedPoints: ProcessedPoint[];
  physicsParams: PhysicsParams;
  totalDistanceKm: number;
  onApplyPowers: (updates: Map<string, number>) => void;
}

interface FineGridResult {
  segs: FineSegment[];
  powers: number[];
}

export function PacingOptimizerPanel({ breakpoints, processedPoints, physicsParams, totalDistanceKm, onApplyPowers }: PacingOptimizerPanelProps) {
  const [targetAvg, setTargetAvg] = useState(220);
  const [targetNp, setTargetNp] = useState<number | ''>('');
  const [minPower, setMinPower] = useState(100);
  const [maxPower, setMaxPower] = useState(400);
  const [stepMeters, setStepMeters] = useState(250);
  const [resultText, setResultText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finePlan, setFinePlan] = useState<FineGridResult | null>(null);
  const [chartOpen, setChartOpen] = useState(false);

  const runOnSections = () => {
    if (breakpoints.length < 2) return;
    setBusy(true);
    try {
      const segs = breakpointsToSegments(breakpoints, processedPoints);
      const result = optimizePacing(
        segs,
        { targetAvgPower: targetAvg, targetNormalizedPower: targetNp === '' ? null : targetNp, minPower, maxPower },
        physicsParams
      );
      const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
      const updates = new Map<string, number>();
      for (let i = 1; i < sorted.length; i++) updates.set(sorted[i]!.id, Math.round(result.powers[i - 1]!));
      onApplyPowers(updates);
      setResultText(
        `Sezioni · Tempo ${formatTime(result.totalTimeHours)} · Media ${result.timeWeightedAvgPower.toFixed(0)} W · NP ~${result.normalizedPower.toFixed(0)} W`
      );
    } finally {
      setBusy(false);
    }
  };

  const runFullGrid = () => {
    if (breakpoints.length < 2 || stepMeters < 50) return;
    setBusy(true);
    try {
      const fineSegs = buildFineGrid(totalDistanceKm, stepMeters / 1000, processedPoints);
      const result = optimizePacing(
        fineSegs.map(s => ({ distanceKm: s.distanceKm, gradient: s.gradient })),
        { targetAvgPower: targetAvg, targetNormalizedPower: targetNp === '' ? null : targetNp, minPower, maxPower },
        physicsParams
      );
      const updates = mapFinePowersToBreakpoints(breakpoints, fineSegs, result.powers);
      onApplyPowers(updates);
      setFinePlan({ segs: fineSegs, powers: result.powers });
      setResultText(
        `Completo (${fineSegs.length} × ${stepMeters}m) · Tempo ${formatTime(result.totalTimeHours)} · Media ${result.timeWeightedAvgPower.toFixed(0)} W · NP ~${result.normalizedPower.toFixed(0)} W`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pacing-panel">
      <div className="physics-panel-title">Ottimizzatore di pacing</div>
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
        <label className="physics-field">
          <span>Step griglia fine (m)</span>
          <NumberField min={50} step={50} value={stepMeters} onCommit={setStepMeters} />
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

      {finePlan && (
        <PowerPlanModal
          open={chartOpen}
          onClose={() => setChartOpen(false)}
          segs={finePlan.segs}
          powers={finePlan.powers}
          physicsParams={physicsParams}
          processedPoints={processedPoints}
        />
      )}
    </div>
  );
}
