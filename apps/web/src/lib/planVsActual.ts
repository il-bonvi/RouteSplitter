import {
  computeSections,
  speedFromPower,
  powerFromSpeed,
  getInterpolatedPoint,
  bucketSamplesByBreakpoints,
  estimateWindFromSamples,
  parseClockTimeToMinutes,
  type PhysicsParams,
  type ProcessedPoint,
  type SectionBreakpoint,
  type WindZoneBoundary,
  type CdaSample,
  type CalcMode
} from '@physics-core';
import { buildFineGrid } from './pacingActions.js';
import { nearestPointTimeSec, type ActivityDisplayPoint } from '../activity/buildActivityDisplay.js';

/**
 * Confronto pianificato-vs-reale per una sezione del piano (F3.3). Il vento "reale" non è
 * misurato direttamente ma stimato a ritroso dai dati di potenza/velocità/pendenza
 * (`estimateWindFromSamples`) — è questo il numero da confrontare con quello pianificato
 * (manuale o, in futuro, da forecast) per giudicarne l'affidabilità: vedi il campo
 * `actualWindUsedSamples`, che segnala quanto è solido il confronto (poche decine di
 * campioni validi = stima da prendere con cautela).
 */
export interface PlanVsActualSectionRow {
  index: number;
  label: string | null;
  fromKm: number;
  toKm: number;
  distanceKm: number;
  /** Id del breakpoint che TERMINA questa sezione — è quello su cui è impostato il target
   * (velocità o potenza) letto da `computeSections` (`to.speedKmh`/`to.powerWatts`), quindi
   * quello su cui scrivere per modificare il piano di questa sezione dall'esterno (es. "usa
   * la potenza reale registrata qui" — vedi bottone "Verifica dati" in Tab 3). */
  breakpointId: string;
  plannedSpeedKmh: number;
  plannedPowerWatts: number;
  plannedTimeHours: number;
  plannedWindHeadwindKmh: number;
  actualSpeedKmh: number | null;
  actualPowerWatts: number | null;
  actualTimeHours: number | null;
  actualWindHeadwindKmh: number | null;
  actualWindUsedSamples: number;
  /** actual - planned. Positivo = più lento del previsto. null se manca il dato reale. */
  deltaTimeHours: number | null;
  deltaSpeedPct: number | null;
  deltaPowerPct: number | null;
  /** vento implicito reale - vento pianificato. Positivo = più testa del previsto. */
  deltaWindKmh: number | null;
  /** "Verifica dati" a livello di sezione: velocità che il modello predice usando la potenza
   * MEDIA REALE di questa sezione (non quella pianificata), con la STESSA pendenza netta e
   * vento effettivo già usati per `plannedSpeedKmh` — stesso principio di
   * `PlanVsActualFinePoint.verifiedSpeedKmh` (microsezioni), qui a livello di sezione
   * personalizzata. `null` quando la sezione non ha alcun campione di potenza reale. */
  verifiedSpeedKmh: number | null;
}

/**
 * Confronto per sezione (granularità "come la tabella sezioni" del piano) fra ciò che il
 * piano prevedeva e ciò che i dati dell'attività reale mostrano nello stesso tratto.
 */
export function computePlanVsActualSections(
  breakpoints: SectionBreakpoint[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  calcMode: CalcMode,
  defaultPowerWatts: number,
  windZones: WindZoneBoundary[] | undefined,
  plannedStartTime: string | null,
  activityPoints: ActivityDisplayPoint[],
  actualSamples: CdaSample[]
): PlanVsActualSectionRow[] {
  const plannedStartMinuteOfDay = parseClockTimeToMinutes(plannedStartTime);
  const plannedResults = computeSections(
    breakpoints,
    routePoints,
    params,
    calcMode,
    defaultPowerWatts,
    windZones,
    plannedStartMinuteOfDay
  );

  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const internalKm = sorted.slice(1, -1).map(b => b.distKm);
  const buckets = bucketSamplesByBreakpoints(actualSamples, internalKm);

  return plannedResults.map((pr, i) => {
    const bucket = buckets[i];
    const fromKm = pr.from.distKm;
    const toKm = pr.to.distKm;

    let actualSpeedKmh: number | null = null;
    let actualPowerWatts: number | null = null;
    let actualTimeHours: number | null = null;
    let actualWindHeadwindKmh: number | null = null;
    let actualWindUsedSamples = 0;

    if (bucket && bucket.samples.length > 0) {
      const n = bucket.samples.length;
      actualSpeedKmh = (bucket.samples.reduce((s, x) => s + x.speedMS, 0) / n) * 3.6;
      const powerSamples = bucket.samples.filter(s => s.powerW > 0);
      actualPowerWatts = powerSamples.length > 0 ? powerSamples.reduce((s, x) => s + x.powerW, 0) / powerSamples.length : null;

      if (activityPoints.length > 0) {
        // toKm è potenzialmente Infinity per l'ultimo bucket (bucketSamplesByBreakpoints non
        // conosce il traguardo del PIANO): clampato al confine pianificato per restare
        // coerente con "questa è la sezione pianificata da X a Y", non "tutto il resto del file".
        const toKmClamped = Number.isFinite(bucket.toKm) ? Math.min(bucket.toKm, toKm) : toKm;
        const durationSec = nearestPointTimeSec(activityPoints, toKmClamped) - nearestPointTimeSec(activityPoints, bucket.fromKm);
        if (durationSec > 0) actualTimeHours = durationSec / 3600;
      }

      const windEst = estimateWindFromSamples(bucket.samples, params);
      if (windEst) {
        actualWindHeadwindKmh = windEst.windKmh;
        actualWindUsedSamples = windEst.usedSamples;
      }
    }

    const deltaTimeHours = actualTimeHours != null ? actualTimeHours - pr.timeHours : null;
    const deltaSpeedPct = actualSpeedKmh != null && pr.speedKmh > 0 ? ((actualSpeedKmh - pr.speedKmh) / pr.speedKmh) * 100 : null;
    const deltaPowerPct = actualPowerWatts != null && pr.powerWatts > 0 ? ((actualPowerWatts - pr.powerWatts) / pr.powerWatts) * 100 : null;
    const deltaWindKmh = actualWindHeadwindKmh != null ? actualWindHeadwindKmh - pr.windHeadwindKmh : null;

    // Ricostruisce lo STESSO effectiveParams usato internamente da computeSections per
    // calcolare pr.speedKmh — pr.windHeadwindKmh è già il valore corretto in entrambi i
    // rami (con o senza zone vento), quindi questo riproduce esattamente lo stesso contesto
    // fisico senza dover esportare effectiveParams da computeSections.
    const effectiveParamsForVerify: PhysicsParams = { ...params, windKmh: pr.windHeadwindKmh };
    const verifiedSpeedKmh = actualPowerWatts != null ? speedFromPower(actualPowerWatts, pr.gradient, effectiveParamsForVerify) * 3.6 : null;

    return {
      index: i + 1,
      label: pr.to.sectionLabel,
      fromKm,
      toKm,
      distanceKm: pr.distanceKm,
      breakpointId: pr.to.id,
      plannedSpeedKmh: pr.speedKmh,
      plannedPowerWatts: pr.powerWatts,
      plannedTimeHours: pr.timeHours,
      plannedWindHeadwindKmh: pr.windHeadwindKmh,
      actualSpeedKmh,
      actualPowerWatts,
      actualTimeHours,
      actualWindHeadwindKmh,
      actualWindUsedSamples,
      deltaTimeHours,
      deltaSpeedPct,
      deltaPowerPct,
      deltaWindKmh,
      verifiedSpeedKmh
    };
  });
}

/**
 * Estende una serie {distKm, powerWatts} in modo che copra visivamente TUTTO il percorso,
 * da 0 a `totalDistanceKm` — senza questo, il primo/ultimo punto della griglia fine sono al
 * CENTRO del loro bin (es. con bin da 250m, il primo punto è a 0.125km, non 0km), e una
 * linea D3 non si estende mai oltre il suo primo/ultimo punto dati: il risultato visibile è
 * che la prima e l'ultima (mezza) sezione restano senza la linea di potenza pianificata.
 * Duplica il valore del primo/ultimo bin fino ai veri bordi 0/totalDistanceKm — coerente col
 * significato del dato (il bin COPRE quell'intervallo, il suo valore è valido su tutto il
 * bin, non solo nel punto medio). Pensata solo per il DISEGNO della linea: la tabella usa i
 * bin originali (`fromKm`/`toKm`/`distKm` come centro), qui non tocchiamo quelli.
 */
export function padSeriesToRouteEdges<T extends { distKm: number }>(series: T[], totalDistanceKm: number): T[] {
  if (series.length === 0) return series;
  const result = [...series];
  const first = result[0]!;
  if (first.distKm > 1e-9) result.unshift({ ...first, distKm: 0 });
  const last = result[result.length - 1]!;
  if (last.distKm < totalDistanceKm - 1e-9) result.push({ ...last, distKm: totalDistanceKm });
  return result;
}

export interface PlanVsActualFinePoint {
  distKm: number;
  /** Estremi del bin (utile in tabella per essere inequivocabili su cosa rappresenta ogni
   * riga — `distKm` resta il centro, usato per posizionare i punti nei grafici). */
  fromKm: number;
  toKm: number;
  ele: number;
  gradientPct: number;
  plannedSpeedKmh: number;
  plannedPowerWatts: number;
  actualSpeedKmh: number | null;
  actualPowerWatts: number | null;
  /** "Verifica dati" a livello di microsezione: velocità che il modello fisico predice
   * usando la potenza REALE di questo bin (non quella pianificata), con la STESSA pendenza,
   * vento e CdA effettivi già usati per `plannedSpeedKmh` — cambia solo l'input potenza.
   * A differenza del bottone "Verifica dati" delle sezioni macro (che sovrascrive il piano
   * persistito, impraticabile qui: centinaia di micro-bin non possono diventare breakpoint),
   * questo campo è puramente calcolato per il confronto, non tocca nulla di persistito.
   * `null` quando il bin non ha un campione di potenza reale (nessun dato da verificare). */
  verifiedSpeedKmh: number | null;
}

function findCoveringPair(sorted: SectionBreakpoint[], distKm: number): [SectionBreakpoint, SectionBreakpoint] {
  for (let i = 1; i < sorted.length; i++) {
    if (distKm <= sorted[i]!.distKm + 1e-9) return [sorted[i - 1]!, sorted[i]!];
  }
  return [sorted[sorted.length - 2]!, sorted[sorted.length - 1]!];
}

/**
 * Confronto continuo su griglia fine (stesso motore di "Ottimizza completo" —
 * `buildFineGrid`), per il grafico sovrapposto pianificato/reale. A differenza della vista
 * per sezioni, qui il valore pianificato NON è la media della sezione ma il risultato
 * puntuale della potenza/velocità target della sezione applicata alla pendenza e al vento
 * locali del bin — più fedele a cosa il piano "prevede davvero" lungo un tratto non
 * uniforme (es. potenza costante in salita → velocità che varia col pendio).
 *
 * NB: il vento qui usa `windAtDistKm` (via `buildFineGrid`), non la variante time-aware —
 * stessa scelta già fatta per l'ottimizzatore fine-grid esistente, per coerenza. Il confronto
 * vento orario "serio" resta quello per sezione sopra.
 */
export function computePlanVsActualFineGrid(
  breakpoints: SectionBreakpoint[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  calcMode: CalcMode,
  defaultPowerWatts: number,
  windZones: WindZoneBoundary[] | undefined,
  totalDistanceKm: number,
  actualSamples: CdaSample[],
  stepKm = 0.25
): PlanVsActualFinePoint[] {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const fineSegs = buildFineGrid(totalDistanceKm, stepKm, routePoints, windZones);

  const sortedSamples = actualSamples
    .filter((s): s is CdaSample & { distKm: number } => s.distKm != null)
    .sort((a, b) => a.distKm - b.distKm);
  let sampleIdx = 0;

  return fineSegs.map(seg => {
    const midKm = (seg.d0Km + seg.d1Km) / 2;
    const [, to] = findCoveringPair(sorted, midKm);
    const effectiveParams: PhysicsParams = seg.windKmh !== undefined ? { ...params, windKmh: seg.windKmh } : params;

    let plannedSpeedKmh: number;
    let plannedPowerWatts: number;
    if (calcMode === 'power') {
      plannedPowerWatts = to.powerWatts ?? defaultPowerWatts;
      plannedSpeedKmh = speedFromPower(plannedPowerWatts, seg.gradient, effectiveParams) * 3.6;
    } else {
      plannedSpeedKmh = to.speedKmh ?? 0;
      plannedPowerWatts = powerFromSpeed(plannedSpeedKmh / 3.6, seg.gradient, effectiveParams);
    }

    while (sampleIdx < sortedSamples.length && sortedSamples[sampleIdx]!.distKm < seg.d0Km) sampleIdx++;
    const inBin: CdaSample[] = [];
    let j = sampleIdx;
    while (j < sortedSamples.length && sortedSamples[j]!.distKm < seg.d1Km) {
      inBin.push(sortedSamples[j]!);
      j++;
    }

    let actualSpeedKmh: number | null = null;
    let actualPowerWatts: number | null = null;
    if (inBin.length > 0) {
      actualSpeedKmh = (inBin.reduce((s, x) => s + x.speedMS, 0) / inBin.length) * 3.6;
      const p = inBin.filter(s => s.powerW > 0);
      actualPowerWatts = p.length > 0 ? p.reduce((s, x) => s + x.powerW, 0) / p.length : null;
    }

    const verifiedSpeedKmh = actualPowerWatts != null ? speedFromPower(actualPowerWatts, seg.gradient, effectiveParams) * 3.6 : null;

    const ele = getInterpolatedPoint(routePoints, midKm * 1000).ele;

    return {
      distKm: midKm,
      fromKm: seg.d0Km,
      toKm: seg.d1Km,
      ele,
      gradientPct: seg.gradient,
      plannedSpeedKmh,
      plannedPowerWatts,
      actualSpeedKmh,
      actualPowerWatts,
      verifiedSpeedKmh
    };
  });
}

/** Sotto questa pendenza (%) un bin è considerato "in discesa" ai fini del flag frenata. */
const BRAKING_GRADIENT_THRESHOLD_PCT = -1;
/** Sotto questo scarto (km/h, verificata - reale) un bin è considerato sospetto. Soglia
 * scelta sui dati reali del 2026-08-30 ("3 giorni trevigiana"): separa nettamente i bin di
 * frenata evidente (scarti da -9 a -44 km/h) dal normale rumore di discesa (mediana -0.4/-1.5
 * km/h nei bin senza frenata). Volutamente conservativa: meglio qualche frenata non
 * segnalata che falsi positivi che nascondono un vero problema di modello. */
const BRAKING_DELTA_THRESHOLD_KMH = -8;

/**
 * Euristica "probabile frenata": in discesa, con potenza reale ancora pedalata (non a ruota
 * libera) ma velocità reale molto più bassa di quanto il modello preveda usando quella stessa
 * potenza (`verifiedSpeedKmh`) — il segno più chiaro che il ciclista sta frenando (curve,
 * fondo tecnico, sicurezza) piuttosto che subire un limite del modello fisico. Vedi analisi
 * F3.11/F3.12 in `stato_rs.md` per l'origine delle soglie. Puramente diagnostica: non
 * modifica alcun calcolo esistente, serve solo a segnalare i bin da NON usare per giudicare
 * l'accuratezza del modello.
 */
export function isLikelyBraking(point: Pick<PlanVsActualFinePoint, 'gradientPct' | 'actualSpeedKmh' | 'verifiedSpeedKmh'>): boolean {
  if (point.gradientPct >= BRAKING_GRADIENT_THRESHOLD_PCT) return false;
  if (point.actualSpeedKmh == null || point.verifiedSpeedKmh == null) return false;
  return point.actualSpeedKmh - point.verifiedSpeedKmh < BRAKING_DELTA_THRESHOLD_KMH;
}

