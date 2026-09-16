import type { SectionResult } from '@physics-core';
import type { PlanVsActualSectionRow, PlanVsActualFinePoint } from './planVsActual.js';
import { isLikelyBraking } from './planVsActual.js';
import type { EnergyBalanceRow, WindZoneBoundary } from '@physics-core';
import type { PhysicsParams } from '@shared-schema';

/**
 * Blocco di metadata (righe commentate con "# ") messo IN CIMA al CSV, prima dell'intestazione
 * dati vera e propria — così chi riapre il file (Andrea in Python, o chiunque altro, umano o
 * modello) ha SEMPRE tutto il necessario per capire con cosa è stato calcolato, senza doverlo
 * chiedere o assumere: peso, CdA, Crr, densità aria E il vento REALMENTE impostato (numeri, non
 * solo "vento del piano" — un'etichetta senza il valore non basta, D72). Prefisso "# "
 * deliberato: un semplice `pd.read_csv(path, comment='#')` le salta da solo; senza, vanno
 * saltate a mano (`skiprows`).
 */
function physicsParamsMetadataLines(params: PhysicsParams, opts: { includeScalarWind: boolean }): string[] {
  const lines = [
    '# Parametri fisici usati per questo bilancio',
    `# Peso atleta (kg): ${params.riderMassKg}`,
    `# Peso attrezzatura (kg): ${params.bikeMassKg}`,
    `# CdA (m²): ${params.cda}`,
    `# Crr: ${params.crr}`,
    `# Densità aria (kg/m³): ${params.airDensity}`
  ];
  if (opts.includeScalarWind) {
    lines.push(`# Vento (km/h, +=in testa): ${params.windKmh}`);
  }
  lines.push(`# Perdita drivetrain (%): ${params.drivetrainLossPct}`, '#');
  return lines;
}

/**
 * Come sopra ma per le zone vento direzionali (D72) — quelle che i calcoli sul percorso usano
 * DAVVERO (vedi commento su `PhysicsParams.windKmh` in shared-schema/physicsParams.ts). Un
 * confine per riga con il suo valore numerico: mai un'etichetta vaga tipo "vento del piano"
 * senza i numeri dietro. Nessuna zona/valori mancanti = esplicitamente dichiarato "0 su tutto
 * il percorso", non lasciato sottinteso.
 */
function windZonesMetadataLines(windZones: WindZoneBoundary[] | undefined, label = 'Zone vento del piano'): string[] {
  if (!windZones || windZones.length === 0) {
    return [`# ${label}: nessuna zona impostata (vento 0 km/h su tutto il percorso)`, '#'];
  }
  const lines = [`# ${label} (${windZones.length} confini):`];
  [...windZones]
    .sort((a, b) => a.distKm - b.distKm)
    .forEach(z => {
      const wind = z.speedKmh != null && z.directionDeg != null ? `${z.speedKmh} km/h da ${z.directionDeg}°` : 'non impostato (0)';
      const samples =
        z.timeSamples.length > 0 ? `, ${z.timeSamples.length} campioni orari ${z.timeSamplesEnabled === false ? 'DISATTIVATI' : 'attivi'}` : '';
      lines.push(`#   confine a ${z.distKm.toFixed(2)} km: ${wind}${samples}`);
    });
  lines.push('#');
  return lines;
}

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
export function planVsActualFineGridToCsv(points: PlanVsActualFinePoint[], params: PhysicsParams, windZones: WindZoneBoundary[] | undefined): string {
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
  return [
    ...physicsParamsMetadataLines(params, { includeScalarWind: false }),
    ...windZonesMetadataLines(windZones),
    header.map(csvCell).join(','),
    ...rows.map(row => row.map(csvCell).join(','))
  ].join('\n');
}

/**
 * Confronto "con vs senza meteo storico" a livello di MICROSEZIONE (D71) — stesso principio di
 * `energyBalanceComparisonToCsv` ma sulla griglia fine invece che sul bilancio secondo-per-
 * secondo: risponde in un colpo solo a due domande che altrimenti richiedono due export
 * separati e da riallineare a mano: "quanto perdo su curve/frenate" (colonna "Probabile
 * frenata", raggio curva — invariate rispetto a `planVsActualFineGridToCsv`, non dipendono dal
 * vento) e "il meteo storico avvicina o allontana il modello dai dati osservati" (le due
 * colonne "verificata" affiancate, con relativo delta). Le colonne che NON dipendono
 * dall'ipotesi di vento (pendenza, quota, reale, curva) compaiono una sola volta, non
 * duplicate — a differenza del bilancio energetico qui il confronto opera su un motore che
 * usa `windZones` vettoriali (velocità+direzione), non uno scalare unico: il chiamante deve
 * quindi ricalcolare l'intera griglia due volte con `windZones` diversi (non solo
 * `params.airDensity`/`windKmh` come per il bilancio energetico) — vedi PlanVsActualView.tsx.
 */
export function planVsActualFineGridComparisonToCsv(
  baseline: PlanVsActualFinePoint[],
  withWeather: PlanVsActualFinePoint[],
  baselineAirDensity: number,
  weatherParams: { airDensity: number; windKmh: number; windDirectionDeg: number },
  sharedParams: PhysicsParams,
  baselineWindZones: WindZoneBoundary[] | undefined
): string {
  const header = [
    '#',
    'Da (km)',
    'A (km)',
    'Centro (km)',
    'Quota (m)',
    'Pendenza (%)',
    'Vel. reale (km/h)',
    'Pot. reale (W)',
    `Vel. verificata SENZA meteo (km/h, densità ${baselineAirDensity.toFixed(3)} kg/m³, vento del piano)`,
    'Delta vel. verificata-reale SENZA meteo (km/h)',
    'Probabile frenata (senza meteo)',
    `Vel. verificata CON meteo (km/h, densità ${weatherParams.airDensity.toFixed(3)} kg/m³, vento ${weatherParams.windKmh.toFixed(1)} km/h da ${Math.round(weatherParams.windDirectionDeg)}°)`,
    'Delta vel. verificata-reale CON meteo (km/h)',
    'Probabile frenata (con meteo)',
    'Raggio curva stimato (m)',
    'Vel. max sicurezza in curva (km/h)',
    'Delta |errore| (km/h, negativo = il meteo migliora)'
  ];
  const n = Math.min(baseline.length, withWeather.length);
  const rows: (string | number)[][] = [];
  for (let i = 0; i < n; i++) {
    const b = baseline[i]!;
    const w = withWeather[i]!;
    const deltaB = b.actualSpeedKmh != null && b.verifiedSpeedKmh != null ? b.actualSpeedKmh - b.verifiedSpeedKmh : null;
    const deltaW = w.actualSpeedKmh != null && w.verifiedSpeedKmh != null ? w.actualSpeedKmh - w.verifiedSpeedKmh : null;
    const brakingB = isLikelyBraking(b, i > 0 ? baseline[i - 1] : null);
    const brakingW = isLikelyBraking(w, i > 0 ? withWeather[i - 1] : null);
    const deltaAbsError = deltaB != null && deltaW != null ? Math.round((Math.abs(deltaW) - Math.abs(deltaB)) * 10) / 10 : '';
    rows.push([
      i + 1,
      b.fromKm.toFixed(3),
      b.toKm.toFixed(3),
      b.distKm.toFixed(3),
      Math.round(b.ele),
      b.gradientPct.toFixed(2),
      csvNum(b.actualSpeedKmh),
      csvNum(b.actualPowerWatts, 0),
      csvNum(b.verifiedSpeedKmh),
      csvNum(deltaB),
      brakingB ? 'SI' : '',
      csvNum(w.verifiedSpeedKmh),
      csvNum(deltaW),
      brakingW ? 'SI' : '',
      Number.isFinite(b.curveRadiusM) ? Math.round(b.curveRadiusM) : '',
      Number.isFinite(b.maxCorneringSpeedKmh) ? b.maxCorneringSpeedKmh.toFixed(1) : '',
      deltaAbsError
    ]);
  }
  return [
    ...physicsParamsMetadataLines({ ...sharedParams, airDensity: baselineAirDensity }, { includeScalarWind: false }),
    ...windZonesMetadataLines(baselineWindZones, 'Zone vento SENZA meteo (piano)'),
    `# Vento/densità CON meteo storico: ${weatherParams.airDensity} kg/m³, ${weatherParams.windKmh} km/h da ${weatherParams.windDirectionDeg}° (uniforme su tutto il percorso)`,
    '#',
    header.map(csvCell).join(','),
    ...rows.map(row => row.map(csvCell).join(','))
  ].join('\n');
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
export function energyBalanceToCsv(rows: EnergyBalanceRow[], params: PhysicsParams): string {
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
  return [
    ...physicsParamsMetadataLines(params, { includeScalarWind: true }),
    header.map(csvCell).join(','),
    ...dataRows.map(row => row.map(csvCell).join(','))
  ].join('\n');
}

/**
 * Confronto "con vs senza" un override di densità dell'aria E vento (tipicamente da
 * Open-Meteo, D57/D58) sullo STESSO bilancio energetico — una riga per intervallo, entrambi i
 * residui affiancati più il delta, per rispondere empiricamente a "il meteo storico avvicina o
 * allontana il modello dai dati osservati?" in un unico file, senza dover esportare due CSV
 * separati e confrontarli a mano (stesso principio già seguito per `planVsActualSectionsToCsv`:
 * il confronto va nel dato esportato, non lasciato a un'analisi esterna che deve prima
 * riallineare due file per indice/tempo).
 */
export function energyBalanceComparisonToCsv(
  baseline: EnergyBalanceRow[],
  withWeather: EnergyBalanceRow[],
  baselineParams: { airDensity: number; windKmh: number },
  weatherParams: { airDensity: number; windKmh: number },
  sharedParams: PhysicsParams
): string {
  const metadata = [
    '# Parametri fisici condivisi da entrambe le colonne (densità/vento differiscono, vedi intestazione sotto)',
    `# Peso atleta (kg): ${sharedParams.riderMassKg}`,
    `# Peso attrezzatura (kg): ${sharedParams.bikeMassKg}`,
    `# CdA (m²): ${sharedParams.cda}`,
    `# Crr: ${sharedParams.crr}`,
    `# Perdita drivetrain (%): ${sharedParams.drivetrainLossPct}`,
    '#'
  ];
  const header = [
    'Tempo (s)',
    'Distanza (km)',
    'Pendenza (%)',
    'Velocità (km/h)',
    'Potenza (W)',
    `Residuo di partenza (W, densità ${baselineParams.airDensity.toFixed(3)} kg/m³, vento ${baselineParams.windKmh.toFixed(1)} km/h)`,
    `Residuo con meteo (W, densità ${weatherParams.airDensity.toFixed(3)} kg/m³, vento ${weatherParams.windKmh.toFixed(1)} km/h)`,
    'Delta |residuo| (W, negativo = il meteo migliora)'
  ];
  const n = Math.min(baseline.length, withWeather.length);
  const rows: (string | number)[][] = [];
  for (let i = 0; i < n; i++) {
    const b = baseline[i]!;
    const w = withWeather[i]!;
    rows.push([
      b.timeSec.toFixed(1),
      b.distKm.toFixed(3),
      b.gradientPct.toFixed(2),
      b.speedKmh.toFixed(2),
      Math.round(b.powerW),
      Math.round(b.residualPowerW),
      Math.round(w.residualPowerW),
      Math.round(Math.abs(w.residualPowerW) - Math.abs(b.residualPowerW))
    ]);
  }
  return [...metadata, ...[header, ...rows].map(row => row.map(csvCell).join(','))].join('\n');
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
