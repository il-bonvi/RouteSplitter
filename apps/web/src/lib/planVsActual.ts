import {
  computeDynamicSections,
  speedFromPower,
  powerFromSpeed,
  getInterpolatedPoint,
  bucketSamplesByBreakpoints,
  estimateWindFromSamples,
  parseClockTimeToMinutes,
  estimateCurveRadiusM,
  maxCorneringSpeedKmh as physicsMaxCorneringSpeedKmh,
  simulateDynamicPacing,
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
  /** "Verifica dati" a livello di sezione: velocità che il motore dinamico predice usando la
   * potenza MEDIA REALE di questa sezione (non quella pianificata) — una simulazione
   * continua su tutto il percorso incatenando le sezioni (l'inerzia si porta dietro da una
   * all'altra, come per il piano), usando la potenza pianificata come riserva per le sezioni
   * senza campioni reali (per non spezzare la catena). `null` quando la sezione non ha alcun
   * campione di potenza reale — stesso principio di `PlanVsActualFinePoint.verifiedSpeedKmh`
   * (microsezioni), qui a livello di sezione personalizzata. */
  verifiedSpeedKmh: number | null;
}

/**
 * Confronto per sezione (granularità "come la tabella sezioni" del piano) fra ciò che il
 * piano prevedeva e ciò che i dati dell'attività reale mostrano nello stesso tratto. Il
 * motore è SEMPRE quello dinamico (D43, unico motore fisico in tutta l'app).
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
  actualSamples: CdaSample[],
  smoothingWindowMeters?: number
): PlanVsActualSectionRow[] {
  const plannedStartMinuteOfDay = parseClockTimeToMinutes(plannedStartTime);
  const plannedResults = computeDynamicSections(
    breakpoints,
    routePoints,
    params,
    calcMode,
    defaultPowerWatts,
    windZones,
    plannedStartMinuteOfDay,
    smoothingWindowMeters
  );

  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const internalKm = sorted.slice(1, -1).map(b => b.distKm);
  const buckets = bucketSamplesByBreakpoints(actualSamples, internalKm);

  // Prima passata: estrae i dati reali (velocità/potenza/vento) per sezione dai campioni —
  // serve PRIMA di poter costruire la simulazione continua di verifica sotto (che ha bisogno
  // della potenza reale di TUTTE le sezioni in un colpo solo, non sezione per sezione).
  const actuals = plannedResults.map((pr, i) => {
    const bucket = buckets[i];
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
        const toKmClamped = Number.isFinite(bucket.toKm) ? Math.min(bucket.toKm, pr.to.distKm) : pr.to.distKm;
        const durationSec = nearestPointTimeSec(activityPoints, toKmClamped) - nearestPointTimeSec(activityPoints, bucket.fromKm);
        if (durationSec > 0) actualTimeHours = durationSec / 3600;
      }

      const windEst = estimateWindFromSamples(bucket.samples, params);
      if (windEst) {
        actualWindHeadwindKmh = windEst.windKmh;
        actualWindUsedSamples = windEst.usedSamples;
      }
    }
    return { actualSpeedKmh, actualPowerWatts, actualTimeHours, actualWindHeadwindKmh, actualWindUsedSamples };
  });

  // "Verifica dati": UNA simulazione dinamica continua su tutto il piano (l'inerzia si porta
  // dietro da una sezione alla successiva, come per `plannedResults`), usando la potenza
  // MEDIA REALE dove disponibile e quella pianificata come riserva altrove (per non spezzare
  // la catena) — poi si legge la velocità media simulata in ciascuna sezione. Sostituisce il
  // vecchio calcolo per equilibrio istantaneo (`speedFromPower` sezione per sezione, ignorava
  // l'inerzia fra una sezione e l'altra).
  const verifySegments = plannedResults.map((pr, i) => ({
    d0Km: pr.from.distKm,
    d1Km: pr.to.distKm,
    targetPowerW: actuals[i]!.actualPowerWatts ?? pr.powerWatts
  }));
  const verifySteps = simulateDynamicPacing(verifySegments, routePoints, params, {
    dtSec: 1,
    initialSpeedMS: 0,
    windZones,
    plannedStartMinuteOfDay,
    gradientSmoothingM: smoothingWindowMeters
  });
  let verifyIdx = 0;

  return plannedResults.map((pr, i) => {
    const { actualSpeedKmh, actualPowerWatts, actualTimeHours, actualWindHeadwindKmh, actualWindUsedSamples } = actuals[i]!;
    const fromKm = pr.from.distKm;
    const toKm = pr.to.distKm;

    const deltaTimeHours = actualTimeHours != null ? actualTimeHours - pr.timeHours : null;
    const deltaSpeedPct = actualSpeedKmh != null && pr.speedKmh > 0 ? ((actualSpeedKmh - pr.speedKmh) / pr.speedKmh) * 100 : null;
    const deltaPowerPct = actualPowerWatts != null && pr.powerWatts > 0 ? ((actualPowerWatts - pr.powerWatts) / pr.powerWatts) * 100 : null;
    const deltaWindKmh = actualWindHeadwindKmh != null ? actualWindHeadwindKmh - pr.windHeadwindKmh : null;

    let verifiedSpeedKmh: number | null = null;
    if (actualPowerWatts != null) {
      while (verifyIdx < verifySteps.length && verifySteps[verifyIdx]!.distKm < fromKm) verifyIdx++;
      const inSection: number[] = [];
      let p = verifyIdx;
      while (p < verifySteps.length && verifySteps[p]!.distKm < toKm) {
        inSection.push(verifySteps[p]!.speedMS);
        p++;
      }
      // Fallback sull'equilibrio puntuale se la simulazione non ha ancora coperto la sezione
      // (stesso limite noto già documentato per `computeDynamicSections`).
      const effectiveParamsForVerify: PhysicsParams = { ...params, windKmh: pr.windHeadwindKmh };
      verifiedSpeedKmh =
        inSection.length > 0
          ? (inSection.reduce((s, x) => s + x, 0) / inSection.length) * 3.6
          : speedFromPower(actualPowerWatts, pr.gradient, effectiveParamsForVerify) * 3.6;
    }

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
  /** "Verifica dati" a livello di microsezione: velocità che il motore dinamico predice
   * usando la potenza REALE di questo bin (non quella pianificata) — UNA simulazione
   * continua sul tratto coperto da dati reali (l'inerzia si porta dietro da un bin al
   * successivo, come deve), poi mediata per bin solo per il confronto/display. A differenza
   * del bottone "Verifica dati" delle sezioni macro (che sovrascrive il piano persistito,
   * impraticabile qui: centinaia di micro-bin non possono diventare breakpoint), questo
   * campo è puramente calcolato per il confronto, non tocca nulla di persistito. `null`
   * quando il bin non ha un campione di potenza reale (nessun dato da verificare). */
  verifiedSpeedKmh: number | null;
  /** Raggio di curvatura stimato del percorso in questo bin (m), `Infinity` se il tratto è
   * sostanzialmente dritto. Diagnostico (F3.15): serve a distinguere una vera frenata per
   * curva stretta da un errore del modello fisico — vedi `estimateCurveRadiusM` in
   * physics-core. */
  curveRadiusM: number;
  /** Velocità massima "di sicurezza" in curva a questo raggio (km/h), `Infinity` se dritto —
   * vedi `maxCorneringSpeedKmh` in physics-core per il significato di questo limite. */
  maxCorneringSpeedKmh: number;
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
 * uniforme (es. potenza costante in salita → velocità che varia col pendio). Il motore è
 * SEMPRE quello dinamico (D43, unico motore fisico in tutta l'app) per sia "Pianificata" sia
 * "Verificata".
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
  stepKm = 0.25,
  smoothingWindowMeters?: number
): PlanVsActualFinePoint[] {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const fineSegs = buildFineGrid(totalDistanceKm, stepKm, routePoints, windZones);

  // Potenza target per bin — SEMPRE quella pianificata (stesso calcolo di prima, invariato):
  // è un input del piano, non dipende dal motore fisico. Precalcolata qui perché la
  // simulazione dinamica sotto ne ha bisogno tutta insieme PRIMA di partire (una sola
  // simulazione continua, non una per bin).
  const plannedPowerPerBin = fineSegs.map(seg => {
    const midKm = (seg.d0Km + seg.d1Km) / 2;
    const [, to] = findCoveringPair(sorted, midKm);
    const effectiveParams: PhysicsParams = seg.windKmh !== undefined ? { ...params, windKmh: seg.windKmh } : params;
    return calcMode === 'power' ? (to.powerWatts ?? defaultPowerWatts) : powerFromSpeed((to.speedKmh ?? 0) / 3.6, seg.gradient, effectiveParams);
  });

  // Stesso limite già noto e documentato per il resto di questa funzione (vedi NB sopra):
  // vento statico per zona, non time-aware — coerenza con `buildFineGrid`/l'ottimizzatore
  // fine-grid, non una nuova approssimazione introdotta qui.
  const plannedDynamicSteps =
    fineSegs.length > 0
      ? simulateDynamicPacing(
          fineSegs.map((seg, i) => ({ d0Km: seg.d0Km, d1Km: seg.d1Km, targetPowerW: plannedPowerPerBin[i]! })),
          routePoints,
          params,
          { dtSec: 1, initialSpeedMS: 0, windZones, gradientSmoothingM: smoothingWindowMeters }
        )
      : [];
  let plannedDynIdx = 0;

  const sortedSamples = actualSamples
    .filter((s): s is CdaSample & { distKm: number } => s.distKm != null)
    .sort((a, b) => a.distKm - b.distKm);
  let sampleIdx = 0;

  // Simulazione dinamica CONTINUA sui dati reali (F3.17): un segmento per ogni coppia di
  // campioni reali consecutivi, potenza = quella del campione — copre esattamente il tratto
  // con dati reali, senza inventare potenza dove non ce n'è. L'inerzia si porta dietro da un
  // bin al successivo, come deve. Il risultato viene poi mediato per bin più sotto, solo per
  // il confronto — la simulazione stessa non lavora a bin.
  const dynamicSteps =
    sortedSamples.length >= 2
      ? simulateDynamicPacing(
          sortedSamples.slice(0, -1).map((s, i) => ({ d0Km: s.distKm, d1Km: sortedSamples[i + 1]!.distKm, targetPowerW: s.powerW })),
          routePoints,
          params,
          { dtSec: 1, initialSpeedMS: 0, windZones, gradientSmoothingM: smoothingWindowMeters }
        )
      : [];
  let dynIdx = 0;

  return fineSegs.map((seg, segIdx) => {
    const midKm = (seg.d0Km + seg.d1Km) / 2;
    const effectiveParams: PhysicsParams = seg.windKmh !== undefined ? { ...params, windKmh: seg.windKmh } : params;

    const plannedPowerWatts = plannedPowerPerBin[segIdx]!; // sempre il target, invariato per motore
    while (plannedDynIdx < plannedDynamicSteps.length && plannedDynamicSteps[plannedDynIdx]!.distKm < seg.d0Km) plannedDynIdx++;
    const inBinSpeeds: number[] = [];
    let p = plannedDynIdx;
    while (p < plannedDynamicSteps.length && plannedDynamicSteps[p]!.distKm < seg.d1Km) {
      inBinSpeeds.push(plannedDynamicSteps[p]!.speedMS);
      p++;
    }
    // Fallback sull'equilibrio puntuale se la simulazione non ha ancora coperto questo bin
    // (stesso limite/stessa scelta di `computeDynamicSections` — vedi lì per i dettagli).
    const plannedSpeedKmh =
      inBinSpeeds.length > 0
        ? (inBinSpeeds.reduce((s, x) => s + x, 0) / inBinSpeeds.length) * 3.6
        : speedFromPower(plannedPowerWatts, seg.gradient, effectiveParams) * 3.6;

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
      const pow = inBin.filter(s => s.powerW > 0);
      actualPowerWatts = pow.length > 0 ? pow.reduce((s, x) => s + x.powerW, 0) / pow.length : null;
    }

    while (dynIdx < dynamicSteps.length && dynamicSteps[dynIdx]!.distKm < seg.d0Km) dynIdx++;
    const dynInBin: number[] = [];
    let k = dynIdx;
    while (k < dynamicSteps.length && dynamicSteps[k]!.distKm < seg.d1Km) {
      dynInBin.push(dynamicSteps[k]!.speedMS);
      k++;
    }
    // Fallback sull'equilibrio puntuale se il bin ha potenza reale ma la simulazione
    // continua non lo ha coperto (es. buco nei campioni) — stesso spirito del fallback sopra.
    const verifiedSpeedKmh =
      dynInBin.length > 0
        ? (dynInBin.reduce((s, x) => s + x, 0) / dynInBin.length) * 3.6
        : actualPowerWatts != null
          ? speedFromPower(actualPowerWatts, seg.gradient, effectiveParams) * 3.6
          : null;

    const ele = getInterpolatedPoint(routePoints, midKm * 1000).ele;
    const curveRadiusM = estimateCurveRadiusM(routePoints, midKm);
    const maxCorneringSpeedKmh = physicsMaxCorneringSpeedKmh(curveRadiusM);

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
      verifiedSpeedKmh,
      curveRadiusM,
      maxCorneringSpeedKmh
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
/** Sotto questa velocità reale (km/h) nel bin PRECEDENTE, si considera che il ciclista fosse
 * fermo o quasi — una velocità bassa nel bin corrente è allora una partenza da fermo (in
 * accelerazione, non frenata): fisicamente l'opposto, anche se produce lo stesso sintomo
 * superficiale (reale molto sotto la verificata) che il resto dell'euristica cerca. Segnalato
 * dall'utente il 2026-08-31 sul primo bin del percorso "3 giorni trevigiana". */
const STANDING_START_PREV_SPEED_KMH = 5;

/**
 * Euristica "probabile frenata": in discesa, con potenza reale ancora pedalata (non a ruota
 * libera) ma velocità reale molto più bassa di quanto il modello preveda usando quella stessa
 * potenza (`verifiedSpeedKmh`) — il segno più chiaro che il ciclista sta frenando (curve,
 * fondo tecnico, sicurezza) piuttosto che subire un limite del modello fisico. Vedi analisi
 * F3.11/F3.12 in `stato_rs.md` per l'origine delle soglie. Puramente diagnostica: non
 * modifica alcun calcolo esistente, serve solo a segnalare i bin da NON usare per giudicare
 * l'accuratezza del modello.
 *
 * `previousPoint` (opzionale, il bin immediatamente precedente in ordine di percorrenza) serve
 * a escludere le PARTENZE DA FERMO: se il ciclista era già quasi fermo nel bin prima, una
 * velocità reale bassa in questo bin è normale accelerazione (non frenata) — stesso sintomo
 * superficiale (reale « verificata), causa opposta. Se `previousPoint` non è fornito, questo
 * caso non viene escluso (comportamento invariato rispetto a prima del 2026-08-31).
 */
export function isLikelyBraking(
  point: Pick<PlanVsActualFinePoint, 'gradientPct' | 'actualSpeedKmh' | 'verifiedSpeedKmh'>,
  previousPoint?: Pick<PlanVsActualFinePoint, 'actualSpeedKmh'> | null
): boolean {
  if (point.gradientPct >= BRAKING_GRADIENT_THRESHOLD_PCT) return false;
  if (point.actualSpeedKmh == null || point.verifiedSpeedKmh == null) return false;
  if (previousPoint?.actualSpeedKmh != null && previousPoint.actualSpeedKmh < STANDING_START_PREV_SPEED_KMH) return false;
  return point.actualSpeedKmh - point.verifiedSpeedKmh < BRAKING_DELTA_THRESHOLD_KMH;
}

