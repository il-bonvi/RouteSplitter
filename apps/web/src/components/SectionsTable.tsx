import type { SectionResult } from '@physics-core';
import { NumberField } from './NumberField.js';
import { formatTime } from '../lib/formatTime.js';

interface SectionsTableProps {
  sections: SectionResult[];
  calcMode: 'speed' | 'power';
  onUpdateLabel: (id: string, label: string) => void;
  onUpdateSpeed: (id: string, speedKmh: number) => void;
  onUpdatePower: (id: string, powerWatts: number) => void;
  onRemove: (id: string) => void;
}

function windBadge(headwindKmh: number) {
  if (Math.abs(headwindKmh) < 0.5) {
    return <span className="wind-badge wind-badge-neutral">— </span>;
  }
  const isHeadwind = headwindKmh > 0;
  return (
    <span className={`wind-badge ${isHeadwind ? 'wind-badge-head' : 'wind-badge-tail'}`}>
      {isHeadwind ? '↑' : '↓'} {Math.abs(headwindKmh).toFixed(1)} km/h
    </span>
  );
}

export function SectionsTable({ sections, calcMode, onUpdateLabel, onUpdateSpeed, onUpdatePower, onRemove }: SectionsTableProps) {
  if (sections.length === 0) {
    return <p className="sections-table-empty">Nessuna sezione: aggiungi un punto sulla mappa o sul grafico.</p>;
  }

  const last = sections[sections.length - 1]!;
  const totalGain = sections.reduce((s, x) => s + x.gain, 0);
  const totalLoss = sections.reduce((s, x) => s + x.loss, 0);

  return (
    <div className="sections-table-wrap">
      <table className="sections-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Nome</th>
            <th>Da → A</th>
            <th>Distanza</th>
            <th>D+</th>
            <th>D−</th>
            <th>Pend.</th>
            <th>Vento</th>
            <th>VAM</th>
            {calcMode === 'power' ? <th>Potenza</th> : <th>Potenza (calc.)</th>}
            <th>Pot. media cum.</th>
            {calcMode === 'speed' ? <th>Velocità</th> : <th>Velocità (calc.)</th>}
            <th>Vel. media cum.</th>
            <th>Tempo</th>
            <th>Tempo cum.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sections.map(s => {
            const removable = !s.to.fixed;
            return (
              <tr key={s.to.id}>
                <td>{s.index}</td>
                <td>
                  <input
                    type="text"
                    value={s.to.sectionLabel ?? ''}
                    onChange={e => onUpdateLabel(s.to.id, e.target.value)}
                  />
                </td>
                <td className="mono">
                  {s.from.distKm.toFixed(2)} → {s.to.distKm.toFixed(2)} km
                </td>
                <td className="mono dist">{s.distanceKm.toFixed(2)} km</td>
                <td className="mono gain">+{Math.round(s.gain)} m</td>
                <td className="mono loss">−{Math.round(s.loss)} m</td>
                <td className="mono">
                  {s.gradient >= 0 ? '+' : ''}
                  {s.gradient.toFixed(1)}%
                </td>
                <td className="mono wind-cell">{windBadge(s.windHeadwindKmh)}</td>
                <td className="mono vam">{s.timeHours > 0 ? `${s.vam >= 0 ? '+' : ''}${Math.round(s.vam)} m/h` : '—'}</td>
                {calcMode === 'power' ? (
                  <td>
                    <NumberField step={1} value={Math.round(s.powerWatts)} onCommit={v => onUpdatePower(s.to.id, v)} />
                  </td>
                ) : (
                  <td className="mono">{Math.round(s.powerWatts)} W</td>
                )}
                <td className="mono cum">{Math.round(s.cumAvgPowerWatts)} W</td>
                {calcMode === 'speed' ? (
                  <td>
                    <NumberField step={0.1} value={s.speedKmh} onCommit={v => onUpdateSpeed(s.to.id, v)} />
                  </td>
                ) : (
                  <td className="mono">{s.speedKmh.toFixed(1)} km/h</td>
                )}
                <td className="mono cum">{s.cumAvgSpeedKmh.toFixed(1)} km/h</td>
                <td className="mono time">{formatTime(s.timeHours)}</td>
                <td className="mono cum">{formatTime(s.cumTimeHours)}</td>
                <td>{removable && <button onClick={() => onRemove(s.to.id)}>✕</button>}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Totale</td>
            <td className="mono dist">{last.cumDistKm.toFixed(2)} km</td>
            <td className="mono gain">+{Math.round(totalGain)} m</td>
            <td className="mono loss">−{Math.round(totalLoss)} m</td>
            <td colSpan={3} />
            <td />
            <td className="mono">{Math.round(last.cumAvgPowerWatts)} W</td>
            <td />
            <td className="mono">{last.cumAvgSpeedKmh.toFixed(1)} km/h</td>
            <td className="mono time">{formatTime(last.cumTimeHours)}</td>
            <td className="mono time">{formatTime(last.cumTimeHours)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
