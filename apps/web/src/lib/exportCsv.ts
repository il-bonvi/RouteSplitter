import type { SectionResult } from '@physics-core';
import type { PlanVsActualSectionRow, PlanVsActualFinePoint } from './planVsActual.js';
import { isLikelyBraking } from './planVsActual.js';
import type { EnergyBalanceRow } from '@physics-core';

function csvCell(value: string | number): string {
  const s = String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Valore numerico o stringa vuota per null — evita "null"/"undefined" letterali nel CSV. */
function csvNum(value: number | null | undefined, decimals = 2): string {
  return value == null ? '' : value.toFixed(decimals);
}

export function sectionsToCsv(sections: SectionResult[]): string {
  const header = [
    '#',
    'Nome',
    'Da (km)',
    'A (km)',
    'Distanza (km)',
    'D+ (m)',
    'D- (m)',
    'Pendenza (%)',
    'VAM (m/h)',
    'Potenza (W)',
    'Velocità (km/h)',
    'Tempo (s)',
    'Tempo cumulato (s)'
  ];
  const rows = sections.map(s => [
    s.index,
    s.to.sectionLabel ?? '',
    s.from.distKm.toFixed(3),
    s.to.distKm.toFixed(3),
    s.distanceKm.toFixed(3),
    Math.round(s.gain),
    Math.round(s.loss),
    s.gradient.toFixed(2),
    Math.round(s.vam),
    Math.round(s.powerWatts),
    s.speedKmh.toFixed(1),
    Math.round(s.timeHours * 3600),
    Math.round(s.cumTimeHours * 3600)
  ]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

/**
 * Export per l'analisi F3.3 (Tab 3, "Confronto per sezione"): righe GREZZE
 * (`PlanVsActualSectionRow`, non le `displayRows` con toggle "Verifica dati" già applicato),
 * così il CSV contiene SEMPRE sia il valore pianificato originale (potenza/velocità del piano)
 * sia `verifiedSpeedKmh` (cosa predice il modello usando la potenza reale) — indispensabile per
 * distinguere errore di pacing (piano vs verificata) da errore di modello fisico (verificata vs
 * reale) in un'analisi esterna.
 */
export function planVsActualSectionsToCsv(rows: PlanVsActualSectionRow[]): string {
  const header = [
    '#',
    'Sezione',
    'Da (km)',
    'A (km)',
    'Distanza (km)',
    'Vel. pianificata (km/h)',
    'Pot. pianificata (W)',
    'Tempo pianificato (h)',
    'Vento pianificato (km/h, +=testa)',
    'Vel. reale (km/h)',
    'Pot. reale (W)',
    'Tempo reale (h)',
    'Vento reale stimato (km/h, +=testa)',
    'Campioni vento',
    'Vel. verificata - pot.reale (km/h)',
    'Delta tempo (h, +=più lento del previsto)',
    'Delta vel. (%)',
    'Delta pot. (%)',
    'Delta vento (km/h)'
  ];
  const rows_ = rows.map(r => [
    r.index,
    r.label ?? '',
    r.fromKm.toFixed(3),
    r.toKm.toFixed(3),
    r.distanceKm.toFixed(3),
    r.plannedSpeedKmh.toFixed(2),
    Math.round(r.plannedPowerWatts),
    r.plannedTimeHours.toFixed(4),
    r.plannedWindHeadwindKmh.toFixed(1),
    csvNum(r.actualSpeedKmh),
    csvNum(r.actualPowerWatts, 0),
    csvNum(r.actualTimeHours, 4),
    csvNum(r.actualWindHeadwindKmh, 1),
    r.actualWindUsedSamples,
    csvNum(r.verifiedSpeedKmh),
    csvNum(r.deltaTimeHours, 4),
    csvNum(r.deltaSpeedPct, 1),
    csvNum(r.deltaPowerPct, 1),
    csvNum(r.deltaWindKmh, 1)
  ]);
  return [header, ...rows_].map(row => row.map(csvCell).join(',')).join('\n');
}

/**
 * Export per l'analisi F3.3 a livello di MICROSEZIONE (griglia fine, stesso passo del pacing
 * optimizer): include pendenza e quota per bin, essenziali per correlare l'errore del modello
 * con transizioni di pendenza (es. l'ipotesi "manca l'inerzia" si verifica guardando se il
 * delta velocità è sistematicamente più alto subito dopo un cambio di pendenza brusco).
 */
export function planVsActualFineGridToCsv(points: PlanVsActualFinePoint[]): string {
  const header = [
    '#',
    'Da (km)',
    'A (km)',
    'Centro (km)',
    'Quota (m)',
    'Pendenza (%)',
    'Vel. pianificata (km/h)',
    'Pot. pianificata (W)',
    'Vel. reale (km/h)',
    'Pot. reale (W)',
    'Vel. verificata - pot.reale (km/h)',
    'Delta vel. pian.-reale (km/h)',
    'Delta vel. pian.-reale (%)',
    'Delta vel. verificata-reale (km/h)',
    'Probabile frenata',
    'Raggio curva stimato (m)',
    'Vel. max sicurezza in curva (km/h)'
  ];
  const rows = points.map((p, i) => {
    const deltaAbs = p.actualSpeedKmh != null ? p.actualSpeedKmh - p.plannedSpeedKmh : null;
    const deltaPct = p.actualSpeedKmh != null && p.plannedSpeedKmh > 0 ? ((p.actualSpeedKmh - p.plannedSpeedKmh) / p.plannedSpeedKmh) * 100 : null;
    const deltaVerified = p.actualSpeedKmh != null && p.verifiedSpeedKmh != null ? p.actualSpeedKmh - p.verifiedSpeedKmh : null;
    return [
      i + 1,
      p.fromKm.toFixed(3),
      p.toKm.toFixed(3),
      p.distKm.toFixed(3),
      Math.round(p.ele),
      p.gradientPct.toFixed(2),
      p.plannedSpeedKmh.toFixed(2),
      Math.round(p.plannedPowerWatts),
      csvNum(p.actualSpeedKmh),
      csvNum(p.actualPowerWatts, 0),
      csvNum(p.verifiedSpeedKmh),
      csvNum(deltaAbs),
      csvNum(deltaPct, 1),
      csvNum(deltaVerified),
      isLikelyBraking(p, i > 0 ? points[i - 1] : null) ? 'SI' : '',
      Number.isFinite(p.curveRadiusM) ? Math.round(p.curveRadiusM) : '',
      Number.isFinite(p.maxCorneringSpeedKmh) ? p.maxCorneringSpeedKmh.toFixed(1) : ''
    ];
  });
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

/**
 * Export del bilancio energetico secondo-per-secondo (ipotesi inerzia, F3.3): a differenza
 * degli export a bin (`planVsActualFineGridToCsv`), qui ogni riga è un intervallo fra due
 * campioni consecutivi dell'attività reale (cadenza nativa del device, dopo smoothing
 * temporale leggero) — abbastanza breve da non poter assumere l'equilibrio stazionario di
 * forze. `residualJ`/`residualPowerW` isolano quanto dell'accelerazione/decelerazione reale
 * NON è spiegato da pedalata+gravità+resistenze note: un residuo negativo forte e
 * concentrato in discesa ripida è quasi certamente frenata (non un errore di modello).
 */
export function energyBalanceToCsv(rows: EnergyBalanceRow[]): string {
  const header = [
    'Tempo (s)',
    'Distanza (km)',
    'Δt (s)',
    'Pendenza (%)',
    'Velocità (km/h)',
    'Potenza (W)',
    'Pot. dissipativa aero+rotolamento (W)',
    'Pot. gravità (W, +=salita)',
    'ΔEC osservata (J)',
    'ΔEC prevista dal bilancio (J)',
    'Residuo (J, negativo=frenata o resistenza non modellata)',
    'Residuo equivalente (W)'
  ];
  const dataRows = rows.map(r => [
    r.timeSec.toFixed(1),
    r.distKm.toFixed(3),
    r.dtSec.toFixed(2),
    r.gradientPct.toFixed(2),
    r.speedKmh.toFixed(2),
    Math.round(r.powerW),
    Math.round(r.dissipativePowerW),
    Math.round(r.gravPowerW),
    Math.round(r.observedDeltaKeJ),
    Math.round(r.predictedDeltaKeJ),
    Math.round(r.residualJ),
    Math.round(r.residualPowerW)
  ]);
  return [header, ...dataRows].map(row => row.map(csvCell).join(',')).join('\n');
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
