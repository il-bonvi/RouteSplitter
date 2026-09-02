import {
  computeSections,
  simulateDynamicPacing,
  totalDynamicSimTimeHours,
  type DynamicSimSegment,
  type SectionResult,
  type SectionBreakpoint,
  type PhysicsParams,
  type ProcessedPoint,
  type WindZoneBoundary,
  type CalcMode
} from '@physics-core';

/** Converte i risultati di `computeSections` (equilibrio classico) in segmenti a potenza
 * costante per `simulateDynamicPacing` — riusa la potenza già derivata da `computeSections`
 * per ciascuna sezione (uguale in entrambe le modalità di calcolo, 'power' o 'speed': lì la
 * conversione velocità→potenza è già risolta), così il motore dinamico riceve sempre un
 * bersaglio in Watt, indipendentemente da come l'utente ha impostato il piano. */
export function buildDynamicSegmentsFromSections(sections: SectionResult[]): DynamicSimSegment[] {
  return sections.map(s => ({ d0Km: s.from.distKm, d1Km: s.to.distKm, targetPowerW: s.powerWatts }));
}

export interface DynamicVsClassicComparison {
  /** Tempo totale del piano col modello a equilibrio (invariato, quello di sempre), ore. */
  classicTotalHours: number;
  /** Tempo totale dello stesso piano con l'integrazione dinamica nel tempo (F3.16), ore. */
  dynamicTotalHours: number;
}

/**
 * Confronta il tempo totale previsto dal modello classico (equilibrio per sezione) con
 * quello previsto dalla simulazione dinamica (F3.16, integrazione nel tempo con inerzia),
 * sullo STESSO piano (stessi breakpoint, stessa potenza per sezione) — per capire quanto
 * "costa" l'inerzia rispetto a un modello che la ignora, sul piano attuale dell'utente.
 * Partenza da fermo (`initialSpeedMS: 0`): coerente con l'assunzione più realistica per
 * l'inizio di un giro/gara.
 */
export function computeDynamicVsClassicComparison(
  breakpoints: SectionBreakpoint[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  calcMode: CalcMode,
  defaultPowerWatts: number,
  windZones?: WindZoneBoundary[],
  plannedStartMinuteOfDay?: number | null
): DynamicVsClassicComparison {
  const sections = computeSections(breakpoints, routePoints, params, calcMode, defaultPowerWatts, windZones, plannedStartMinuteOfDay);
  const classicTotalHours = sections.length > 0 ? sections[sections.length - 1]!.cumTimeHours : 0;

  const segments = buildDynamicSegmentsFromSections(sections);
  const steps = simulateDynamicPacing(segments, routePoints, params, { dtSec: 1, initialSpeedMS: 0 });
  const dynamicTotalHours = totalDynamicSimTimeHours(steps, 1);

  return { classicTotalHours, dynamicTotalHours };
}
