import { GRAVITY, effectiveCda } from './physics.js';
import { getInterpolatedPoint, type ProcessedPoint } from './geo.js';
import { windAtDistKmTime, routeBearingAtDistKm, effectiveHeadwindKmh, type WindZoneBoundary } from './wind.js';
import type { PhysicsParams, FatigueParams } from './types.js';
import { computeSections, type SectionBreakpoint, type SectionResult, type CalcMode } from './sections.js';

/** Finestra (metri) usata per calcolare la pendenza locale a una distanza esatta —
 * `getInterpolatedPoint` interpola solo lat/lon/quota, non un campo "pendenza" (che nei punti
 * del percorso è definito fra coppie consecutive, non a una distanza arbitraria): la
 * pendenza qui si ricava dalla differenza di quota fra `distM-window/2` e `distM+window/2`,
 * più stabile della pendenza punto-a-punto grezza se i punti del GPX sono irregolarmente
 * spaziati (non dipende dalla densità dei punti originali). */
const LOCAL_GRADIENT_WINDOW_M = 10;

function localGradientPct(routePoints: ProcessedPoint[], distM: number, windowM = LOCAL_GRADIENT_WINDOW_M): number {
  // 0 ("grezza", nessuno smoothing) userebbe before===after (span=0) e romperebbe il calcolo
  // sotto — 1m è indistinguibile da "zero smoothing" alla risoluzione tipica di un GPX, ma
  // evita la divisione degenere.
  const half = Math.max(0.5, windowM / 2);
  const before = getInterpolatedPoint(routePoints, Math.max(0, distM - half));
  const after = getInterpolatedPoint(routePoints, distM + half);
  const span = after.dist - before.dist;
  return span > 0 ? ((after.ele - before.ele) / span) * 100 : 0;
}

/**
 * Un tratto a potenza-target costante — l'unità su cui lavora la simulazione dinamica.
 * Coincide con l'intervallo fra due breakpoint consecutivi del piano (stessa granularità
 * che l'utente controlla in Tab 1/2): quello che il ciclista sceglie è UNA potenza per
 * tratto, non un profilo continuo — è la fisica (pendenza reale, inerzia) a determinare
 * come la velocità si sviluppa dentro il tratto, non più un equilibrio ricalcolato di colpo.
 */
export interface DynamicSimSegment {
  d0Km: number;
  d1Km: number;
  targetPowerW: number;
}

/** Un passo della simulazione, a cadenza `dtSec` fissa. */
export interface DynamicSimStep {
  timeSec: number;
  distKm: number;
  speedMS: number;
  gradientPct: number;
  powerW: number;
}

export interface DynamicSimOptions {
  /** Passo di integrazione, secondi. Più piccolo = più preciso ma più lento da calcolare;
   * 1s è già più che sufficiente per le scale temporali dell'inerzia in bici (il transitorio
   * dopo un cambio di potenza/pendenza dura tipicamente diversi secondi, non frazioni di
   * secondo) — vedi bilancio energetico (F3.12), costruito anch'esso a cadenza ~1s. */
  dtSec?: number;
  /** Velocità di partenza, m/s. 0 = partenza da fermo (default: la maggior parte dei piani
   * comincia realisticamente da fermi al via). */
  initialSpeedMS?: number;
  /** Numero massimo di passi, come guardia contro un loop che non termina (es. potenza
   * insufficiente a vincere la pendenza per l'intero tratto, velocità che resta ~0
   * indefinitamente) — con `dtSec=1` corrisponde a poco più di 16h di simulazione. */
  maxSteps?: number;
  /** Zone vento (stesso modello di `computeSections`/`buildFineGrid`) — se presenti (≥2,
   * come sempre per le zone), sostituiscono `params.windKmh` scalare con la componente
   * efficace calcolata passo-passo dalla posizione/ora corrente e dalla rotta locale del
   * percorso. Assente/vuoto = comportamento storico (vento scalare fisso), nessuna
   * regressione per chi non configura zone vento. */
  windZones?: WindZoneBoundary[];
  /** Ora di partenza (minuti da mezzanotte), serve SOLO se una zona vento ha `timeSamples`
   * orari configurati — vedi `windAtDistKmTime`. */
  plannedStartMinuteOfDay?: number | null;
  /** Finestra (metri) di smoothing della pendenza locale — vedi `localGradientPct`. Persistita
   * sul piano (`SectionPlan.smoothingWindowMeters`, 5–100m, default 50m): una finestra stretta
   * segue fedelmente ogni variazione del GPX (rischia di amplificare il rumore GPS/quota),
   * una larga la smussa (rischia di perdere transizioni di pendenza brevi ma reali, es. un
   * tornante). Default a `LOCAL_GRADIENT_WINDOW_M` se non specificata. */
  gradientSmoothingM?: number;
}

/**
 * Integra la velocità nel tempo, tratto per tratto, invece di risolvere un equilibrio
 * stazionario per ciascuno. Ad ogni passo: l'energia cinetica guadagnata/persa è
 * `(potenza_effettiva - dissipazione_aero_rotolamento - potenza_gravità) · dt` — la STESSA
 * identità usata (in direzione opposta, dati osservati anziché da prevedere) in
 * `computeEnergyBalance` (F3.12): lì si verificava se il bilancio tornava sui dati reali, qui
 * lo si usa per PREVEDERE come si sviluppa la velocità dato un piano di potenza. Non è fisica
 * nuova, è l'inverso di uno strumento già validato sui dati reali di F3.12/F3.14.
 *
 * La pendenza usata ad ogni passo è quella REALE del percorso in quel punto (da
 * `routePoints`, risoluzione nativa, smussata su una finestra configurabile — vedi
 * `gradientSmoothingM` — per non amplificare il rumore GPS/quota) — non la pendenza media
 * del tratto — così un cambio di pendenza dentro un tratto a potenza costante si ripercuote
 * sulla velocità nel momento giusto (esattamente il meccanismo che manca al modello a
 * equilibrio-per-sezione).
 *
 * Il vento supporta sia `params.windKmh` scalare sia le zone vento (`options.windZones`),
 * ricalcolato ad ogni passo in base a posizione/ora correnti — vedi `windKmhAt` sotto.
 */
export function simulateDynamicPacing(
  segments: DynamicSimSegment[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  options: DynamicSimOptions = {}
): DynamicSimStep[] {
  const dtSec = options.dtSec ?? 1;
  const maxSteps = options.maxSteps ?? 60000;
  const sorted = [...segments].sort((a, b) => a.d0Km - b.d0Km);
  if (sorted.length === 0) return [];

  const m = params.riderMassKg + params.bikeMassKg;
  const driveEff = 1 - params.drivetrainLossPct / 100;
  const endKm = sorted[sorted.length - 1]!.d1Km;
  const windZones = options.windZones;
  const hasWindZones = windZones != null && windZones.length >= 2;

  /** Vento efficace (km/h, positivo=in testa) alla distanza/ora correnti — stesso identico
   * calcolo di `computeSections`/`buildFineGrid` (zona attiva → vento statico o interpolato
   * nel tempo → proiezione sulla rotta locale), qui rivalutato ad ogni passo perché sia
   * posizione che ora avanzano continuamente durante la simulazione (a differenza del
   * modello a equilibrio, dove viene calcolato una volta per sezione). Senza zone vento
   * configurate, ricade su `params.windKmh` scalare — comportamento storico invariato. */
  function windKmhAt(distKm: number, timeSec: number): number {
    if (!hasWindZones) return params.windKmh;
    const minuteOfDay = options.plannedStartMinuteOfDay != null ? (options.plannedStartMinuteOfDay + timeSec / 60) % 1440 : null;
    const wind = windAtDistKmTime(windZones!, distKm, minuteOfDay);
    if (!wind) return 0;
    const bearing = routeBearingAtDistKm(routePoints, distKm);
    return effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing);
  }

  let v = Math.max(0, options.initialSpeedMS ?? 0);
  let distKm = sorted[0]!.d0Km;
  let timeSec = 0;
  let segIdx = 0;

  const steps: DynamicSimStep[] = [];

  for (let i = 0; i < maxSteps && distKm < endKm; i++) {
    while (segIdx < sorted.length - 1 && distKm >= sorted[segIdx]!.d1Km) segIdx++;
    const seg = sorted[segIdx]!;
    const targetPowerW = seg.targetPowerW;

    const gradientPct = localGradientPct(routePoints, distKm * 1000, options.gradientSmoothingM);
    const slopeRad = Math.atan(gradientPct / 100);
    const windMS = windKmhAt(distKm, timeSec) / 3.6;
    const rel = v + windMS;
    const aeroN = 0.5 * params.airDensity * effectiveCda(params, gradientPct) * rel * Math.abs(rel);
    const rollN = params.crr * m * GRAVITY * Math.cos(slopeRad);
    const gravN = m * GRAVITY * Math.sin(slopeRad);

    const dissipativePowerW = (aeroN + rollN) * v;
    const gravPowerW = gravN * v;
    const effectivePowerW = targetPowerW * driveEff;

    const deltaKeJ = (effectivePowerW - dissipativePowerW - gravPowerW) * dtSec;
    const vNext = Math.sqrt(Math.max(0, v * v + (2 * deltaKeJ) / m));

    // Distanza percorsa nel passo: media fra v iniziale e finale (trapezoidale), più accurata
    // di v·dt puro quando la velocità cambia molto in un passo (es. partenza da fermo).
    const distKmNext = distKm + ((v + vNext) / 2 / 1000) * dtSec;

    steps.push({ timeSec, distKm, speedMS: v, gradientPct, powerW: targetPowerW });

    v = vNext;
    distKm = distKmNext;
    timeSec += dtSec;
  }

  return steps;
}

/** Risultato per tratto — stessa granularità di `SectionBreakpoint`, per confronto diretto
 * con `SectionResult` (il risultato del modello a equilibrio) nella UI/export. */
export interface DynamicSectionResult {
  index: number;
  from: SectionBreakpoint;
  to: SectionBreakpoint;
  distanceKm: number;
  timeHours: number;
  avgSpeedKmh: number;
  avgPowerWatts: number;
}

/**
 * Aggrega i passi della simulazione per tratto fra breakpoint (non per passo temporale) —
 * per confrontare il totale con `computeSections`/`SectionResult` senza dover cambiare tutto
 * il resto della UI che già sa presentare risultati "per sezione". `dtSec` deve coincidere
 * con quello passato a `simulateDynamicPacing` (stesso default 1s).
 */
export function aggregateDynamicSimulationBySection(steps: DynamicSimStep[], breakpoints: SectionBreakpoint[], dtSec = 1): DynamicSectionResult[] {
  const sorted = [...breakpoints].sort((a, b) => a.distKm - b.distKm);
  const results: DynamicSectionResult[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]!;
    const to = sorted[i]!;
    const inRange = steps.filter(s => s.distKm >= from.distKm && s.distKm < to.distKm);
    const distanceKm = to.distKm - from.distKm;
    if (inRange.length === 0) {
      results.push({ index: i, from, to, distanceKm, timeHours: 0, avgSpeedKmh: 0, avgPowerWatts: 0 });
      continue;
    }
    const timeHours = (inRange.length * dtSec) / 3600;
    const avgSpeedKmh = (inRange.reduce((s, p) => s + p.speedMS, 0) / inRange.length) * 3.6;
    const avgPowerWatts = inRange.reduce((s, p) => s + p.powerW, 0) / inRange.length;
    results.push({ index: i, from, to, distanceKm, timeHours, avgSpeedKmh, avgPowerWatts });
  }
  return results;
}

/** Tempo totale simulato (ore) — durata dell'intera simulazione dall'inizio all'ultimo passo. */
export function totalDynamicSimTimeHours(steps: DynamicSimStep[], dtSec = 1): number {
  return steps.length === 0 ? 0 : (steps.length * dtSec) / 3600;
}

/** Piccolo PRNG deterministico (mulberry32) — usato per rendere il raffinamento dinamico
 * riproducibile nei test con un seed fisso, invece di dipendere da `Math.random()`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DynamicRefinementOptions {
  minPower: number;
  maxPower: number;
  windZones?: WindZoneBoundary[];
  plannedStartMinuteOfDay?: number | null;
  /** Numero di mosse di prova (ognuna = una simulazione completa del percorso). Il costo
   * totale è O(maxTrials × durata_percorso_in_secondi), NON dipende dal numero di sezioni —
   * a differenza di un'analisi marginale per-sezione (che richiederebbe N+1 simulazioni per
   * iterazione), qui il budget resta costante indipendentemente da quante sezioni ci sono.
   * Default 200: su un percorso di poche ore è dell'ordine dei milioni di passi totali,
   * pochi decimi di secondo in JS — non serve web worker. */
  maxTrials?: number;
  /** Seed del PRNG — fisso di default per risultati riproducibili a parità di piano
   * (l'utente si aspetta che ricliccare "Ottimizza" sullo stesso piano dia lo stesso
   * risultato, non uno diverso ogni volta per puro rumore casuale). */
  seed?: number;
}

export interface DynamicRefinementResult {
  powers: number[];
  /** Tempo totale dinamico (ore) DOPO il raffinamento. */
  totalTimeHours: number;
  /** Tempo totale dinamico (ore) del piano di PARTENZA (prima del raffinamento) — utile per
   * mostrare quanto ha guadagnato il raffinamento, non solo il risultato finale. */
  startingTimeHours: number;
  trialsAccepted: number;
}

/**
 * Raffina un'allocazione di potenza per tratto (tipicamente il seed geometrico di
 * `buildGradientWeightedSeed`/`optimizePacingDynamic`) usando la simulazione dinamica come
 * vero costo da minimizzare. Non ricalcola l'allocazione da zero: parte da un punto già
 * ragionevole e prova a spostare potenza fra coppie di tratti — mantenendo la potenza media
 * INVARIATA per costruzione (un trasferimento i→j non cambia la somma) — tenendo la mossa
 * solo se il tempo totale SIMULATO (con inerzia) migliora.
 *
 * Euristica (hill-climbing locale con step decrescente), non un solver esatto: nessuna
 * garanzia formale di ottimo globale, buona in pratica perché il punto di partenza è già
 * ragionevole.
 */
export function refinePacingWithDynamicSimulation(
  boundaries: { d0Km: number; d1Km: number }[],
  initialPowers: number[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  options: DynamicRefinementOptions
): DynamicRefinementResult {
  const n = boundaries.length;
  if (n === 0 || initialPowers.length !== n) {
    return { powers: initialPowers.slice(), totalTimeHours: 0, startingTimeHours: 0, trialsAccepted: 0 };
  }
  const { minPower, maxPower, windZones, plannedStartMinuteOfDay } = options;
  const maxTrials = options.maxTrials ?? 200;
  const rand = mulberry32(options.seed ?? 20260902);

  const totalTimeFor = (powers: number[]): number => {
    const segments: DynamicSimSegment[] = boundaries.map((b, i) => ({ d0Km: b.d0Km, d1Km: b.d1Km, targetPowerW: powers[i]! }));
    const steps = simulateDynamicPacing(segments, routePoints, params, {
      dtSec: 1,
      initialSpeedMS: 0,
      windZones,
      plannedStartMinuteOfDay
    });
    return totalDynamicSimTimeHours(steps, 1);
  };

  let powers = initialPowers.slice();
  const startingTimeHours = totalTimeFor(powers);
  let best = startingTimeHours;
  let trialsAccepted = 0;

  if (n < 2) return { powers, totalTimeHours: best, startingTimeHours, trialsAccepted: 0 };

  for (let trial = 0; trial < maxTrials; trial++) {
    // Step decrescente: mosse ampie all'inizio (esplorazione), fini verso la fine
    // (affinamento) — stessa idea di un annealing molto semplice, senza le mosse peggiorative.
    const progress = trial / maxTrials;
    const step = Math.max(1, Math.round(8 * (1 - progress)));

    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (j === i) j = (j + 1) % n;

    if (powers[i]! - step < minPower || powers[j]! + step > maxPower) continue;

    const candidate = powers.slice();
    candidate[i]! -= step;
    candidate[j]! += step;

    const t = totalTimeFor(candidate);
    if (t < best - 1e-7) {
      powers = candidate;
      best = t;
      trialsAccepted++;
    }
  }

  return { powers, totalTimeHours: best, startingTimeHours, trialsAccepted };
}

/**
 * Come `computeSections`, ma il tempo/velocità di ogni sezione (e i cumulati che ne
 * derivano) vengono dall'integrazione dinamica nel tempo invece che dall'equilibrio
 * stazionario — stessa forma dati `SectionResult[]`, così può sostituire `computeSections`
 * ovunque nella UI (StatsRow, ElevationChart, SectionsTable, ReportView) senza che quei
 * componenti sappiano quale motore fisico ha prodotto i numeri.
 *
 * Approccio: 1) `computeSections` fornisce, come sempre, la potenza target per sezione e i
 * campi puramente geometrici/di configurazione (distanza, D+/D-, pendenza, vento
 * pianificato, CdA usato) — questi NON dipendono dal motore, restano identici. 2) UNA sola
 * simulazione dinamica continua su tutto il piano (stesso motore di F3.16/F3.17, partenza da
 * fermo al primo breakpoint) usa quelle potenze target come segmenti — l'inerzia si porta
 * dietro da una sezione alla successiva, esattamente come deve. 3) I passi vengono
 * riaggregati per sezione e i campi tempo-dipendenti (velocità, tempo, VAM, cumulati)
 * vengono ricalcolati da lì; tutto il resto (potenza target, geometria) resta quello di
 * `computeSections`, un solo posto dove è calcolato.
 *
 * Limite noto: se la potenza target non basta a superare una salita entro `maxSteps` (v
 * resta bloccata vicino a 0 indefinitamente), la simulazione può non raggiungere le sezioni
 * successive — quelle sezioni ricadono sul tempo/velocità del modello classico per quel
 * tratto (fallback esplicito sotto), invece di restituire zero/NaN.
 */
export function computeDynamicSections(
  breakpoints: SectionBreakpoint[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  calcMode: CalcMode,
  defaultPowerWatts = 250,
  windZones?: WindZoneBoundary[],
  plannedStartMinuteOfDay?: number | null,
  gradientSmoothingM?: number
): SectionResult[] {
  const classic = computeSections(breakpoints, routePoints, params, calcMode, defaultPowerWatts, windZones, plannedStartMinuteOfDay);
  if (classic.length === 0) return [];

  const segments: DynamicSimSegment[] = classic.map(s => ({ d0Km: s.from.distKm, d1Km: s.to.distKm, targetPowerW: s.powerWatts }));
  const steps = simulateDynamicPacing(segments, routePoints, params, {
    dtSec: 1,
    initialSpeedMS: 0,
    gradientSmoothingM,
    windZones,
    plannedStartMinuteOfDay
  });
  const dynBySection = aggregateDynamicSimulationBySection(steps, breakpoints, 1);
  const dynByIndex = new Map(dynBySection.map(d => [d.index, d]));

  let cumDist = 0;
  let cumTime = 0;
  let cumGain = 0;
  let cumLoss = 0;
  let cumWork = 0;

  return classic.map(c => {
    const dyn = dynByIndex.get(c.index);
    // Fallback sul tempo classico se la simulazione non ha coperto la sezione (vedi limite
    // sopra) — evita di propagare uno zero che romperebbe le medie a valle.
    const timeHours = dyn && dyn.timeHours > 0 ? dyn.timeHours : c.timeHours;
    const speedKmh = timeHours > 0 ? c.distanceKm / timeHours : 0;
    const powerWatts = c.powerWatts; // bersaglio in ingresso alla simulazione, non un suo output
    const netElevM = (c.gradient / 100) * c.distanceKm * 1000;
    const vam = timeHours > 0 ? netElevM / timeHours : 0;

    cumDist += c.distanceKm;
    cumTime += timeHours;
    cumGain += c.gain;
    cumLoss += c.loss;
    cumWork += powerWatts * timeHours;

    return {
      ...c,
      speedKmh,
      timeHours,
      vam,
      cumDistKm: cumDist,
      cumTimeHours: cumTime,
      cumGain,
      cumLoss,
      cumAvgSpeedKmh: cumTime > 0 ? cumDist / cumTime : 0,
      cumAvgPowerWatts: cumTime > 0 ? cumWork / cumTime : 0
    };
  });
}

/**
 * Normalized Power (Coggan/TrainingPeaks: media mobile 30s, poi radice quarta della media
 * della quarta potenza) calcolata DIRETTAMENTE dalla serie temporale della simulazione
 * dinamica — a differenza del calcolo storico (`normalizedPower.ts`, `computeNormalizedPower`)
 * che doveva STIMARE quanto tempo si passa in ogni tratto risolvendo un equilibrio
 * (`speedFromPower`), qui il tempo è quello vero, già prodotto dall'integrazione passo-passo
 * (inerzia inclusa) — nessuna stima aggiuntiva, nessuna assunzione di equilibrio.
 */
export function normalizedPowerFromSteps(steps: DynamicSimStep[], dtSec = 1): number {
  if (steps.length === 0) return 0;
  const windowSteps = Math.max(1, Math.round(30 / dtSec));
  const rolling = new Array<number>(steps.length);
  let sum = 0;
  for (let i = 0; i < steps.length; i++) {
    sum += steps[i]!.powerW;
    if (i >= windowSteps) sum -= steps[i - windowSteps]!.powerW;
    const n = Math.min(i + 1, windowSteps);
    rolling[i] = sum / n;
  }
  const sum4 = rolling.reduce((a, p) => a + Math.pow(p, 4), 0);
  return Math.pow(sum4 / rolling.length, 0.25);
}

/** Potenza media, DIRETTAMENTE dalla serie della simulazione — passi a durata costante
 * (`dtSec`), quindi la media semplice è già pesata sul tempo, nessun calcolo aggiuntivo
 * necessario (a differenza della media pesata "storica", che doveva ricostruire il tempo per
 * tratto da un equilibrio stimato). */
export function avgPowerFromSteps(steps: DynamicSimStep[]): number {
  if (steps.length === 0) return 0;
  return steps.reduce((a, s) => a + s.powerW, 0) / steps.length;
}

/**
 * Bilancio W' istante per istante — modello DIFFERENZIALE di Skiba (2012), lo standard de
 * facto per Critical Power / W' (usato anche da Golden Cheetah, intervals.icu, ecc.): sopra
 * CP la riserva si scarica linearmente (quanti watt sopra CP, per quanto tempo); sotto CP
 * recupera esponenzialmente verso il pieno con una costante di tempo che dipende da QUANTO si
 * sta sotto CP (più sotto, recupero più rapido) — `Tau = 546*exp(-0.01*DCP) + 316` secondi,
 * con `DCP = CP - potenza istantanea` (formula empirica di Skiba, invariata qui).
 *
 * `dtSec`, se fornito, è il passo FISSO usato per ogni intervallo (il caso della simulazione
 * dinamica interna, sempre a cadenza uniforme). Se omesso, il passo per ogni intervallo è
 * derivato dalla differenza fra `timeSec` consecutivi — necessario per serie a cadenza NON
 * uniforme, come il grafico "Piano potenza" in UI, che campiona più densamente dove la
 * velocità è più bassa (stesso numero di campioni per segmento indipendentemente da quanto
 * dura, quindi durata per campione variabile). Con step a cadenza costante (`timeSec` che
 * cresce sempre della stessa quantità) le due modalità coincidono esattamente.
 *
 * Parte dal pieno (`wPrimeJ`) al tempo zero — l'ipotesi standard per pianificare una gara "a
 * fresco", non a metà di uno sforzo precedente. Il valore può scendere sotto zero (non
 * clampato qui): un W'bal negativo è il segnale che la potenza richiesta in quel punto non è
 * fisiologicamente sostenibile con questo CP/W' — sta a chi chiama (l'ottimizzatore, o la UI)
 * decidere come reagire, non a questa funzione di puro calcolo.
 */
export function computeWBalFromSteps(steps: DynamicSimStep[], fatigue: FatigueParams, dtSec?: number): number[] {
  const { criticalPowerW: cp, wPrimeJ: wPrime } = fatigue;
  const result: number[] = new Array(steps.length);
  let wBal = wPrime;
  for (let i = 0; i < steps.length; i++) {
    const p = steps[i]!.powerW;
    const dt = dtSec ?? (i === 0 ? 1 : Math.max(1e-6, steps[i]!.timeSec - steps[i - 1]!.timeSec));
    if (p > cp) {
      wBal -= (p - cp) * dt;
    } else {
      const dcp = cp - p;
      const tau = 546 * Math.exp(-0.01 * dcp) + 316;
      wBal = wPrime - (wPrime - wBal) * Math.exp(-dt / tau);
    }
    result[i] = wBal;
  }
  return result;
}

/** Il punto di minimo bilancio W' lungo una serie — dove il rischio di "esplodere" è
 * massimo. Ciclo esplicito invece di `Math.min(...array)` per non rischiare limiti sulla
 * dimensione degli argomenti spread su simulazioni molto lunghe. */
export function minWBalJ(wBalSeries: number[]): number {
  if (wBalSeries.length === 0) return 0;
  let m = Infinity;
  for (const w of wBalSeries) if (w < m) m = w;
  return m;
}

/**
 * Ri-clampa un'allocazione di potenza su `[minPower, maxPower]` conservando il più possibile
 * la media pesata (su `weights`, tipicamente le distanze dei tratti) che l'allocazione aveva
 * PRIMA del clamp — invece di limitarsi a troncare ogni valore fuori range (che sposterebbe
 * la media in modo incontrollato), l'eccesso/difetto tagliato dal clamp viene ridistribuito
 * (water-filling iterativo) sui tratti non ancora al limite. Usata sia per costruire il seed
 * geometrico (`buildGradientWeightedSeed`) sia per la correzione iterativa della media vera
 * (`rescalePowersToTargetAvg`) — stessa identica logica, prima duplicata inline nel seed.
 */
function distancesOf(boundaries: { d0Km: number; d1Km: number }[]): number[] {
  return boundaries.map(b => Math.max(1e-9, b.d1Km - b.d0Km));
}

function clampPreservingWeightedMean(
  powers: number[],
  weights: number[],
  minPower: number,
  maxPower: number
): number[] {
  const n = powers.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((a, w) => a + w, 0) || 1;
  const targetWeightedMean = powers.reduce((a, p, i) => a + p * weights[i]!, 0) / totalWeight;
  let result = powers.slice();

  for (let pass = 0; pass < 12; pass++) {
    result = result.map(p => Math.min(maxPower, Math.max(minPower, p)));
    const curAvg = result.reduce((a, p, i) => a + p * weights[i]!, 0) / totalWeight;
    const err = targetWeightedMean - curAvg;
    if (Math.abs(err) < 0.1) break;
    const freeIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      const atMax = result[i]! >= maxPower - 0.1;
      const atMin = result[i]! <= minPower + 0.1;
      if ((err > 0 && !atMax) || (err < 0 && !atMin)) freeIdx.push(i);
    }
    if (freeIdx.length === 0) break;
    const freeWeight = freeIdx.reduce((a, i) => a + weights[i]!, 0) || 1;
    const delta = (err * totalWeight) / freeWeight;
    for (const i of freeIdx) result[i] = result[i]! + delta;
  }
  return result.map(p => Math.min(maxPower, Math.max(minPower, p)));
}

/**
 * Punto di partenza per l'ottimizzatore dinamico: un'allocazione di potenza puramente
 * GEOMETRICA (basata solo sulla pendenza di ciascun tratto, nessun calcolo di
 * velocità/equilibrio) — più potenza dove la pendenza è più ripida, `slopeSensitivity`
 * controlla quanto. Poi proiettata (`clampPreservingWeightedMean`, pesi = distanze) a
 * rispettare `[minPower, maxPower]` mantenendo la media pesata sulla DISTANZA pari a
 * `targetAvgPower` — un punto di partenza ragionevole, non ancora corretto sulla media VERA
 * (pesata sul tempo simulato, non sulla distanza — vedi `rescalePowersToTargetAvg`, applicata
 * subito dopo in `optimizePacingDynamic`) né ottimizzato: ci pensa
 * `refinePacingWithDynamicSimulation`, con la simulazione vera come costo.
 */
function buildGradientWeightedSeed(
  boundaries: { d0Km: number; d1Km: number; gradient: number }[],
  targetAvgPower: number,
  minPower: number,
  maxPower: number,
  slopeSensitivity: number
): number[] {
  const n = boundaries.length;
  if (n === 0) return [];
  const distances = distancesOf(boundaries);
  const weights = boundaries.map(b => Math.max(0.25, 1 + slopeSensitivity * b.gradient));
  const totalDist = distances.reduce((a, d) => a + d, 0);
  const weightedMean = weights.reduce((a, w, i) => a + w * distances[i]!, 0) / totalDist;
  const initialPowers = weights.map(w => (targetAvgPower * w) / weightedMean);
  return clampPreservingWeightedMean(initialPowers, distances, minPower, maxPower);
}

/**
 * Corregge iterativamente un'allocazione di potenza affinché la media VERA (pesata sul tempo
 * — `avgPowerFromSteps` sulla simulazione, ciò che l'utente vede in UI come "Media") converga
 * a `targetAvgPower`, invece della media pesata sulla distanza che seed/raffinamento trattano
 * come invariante — le due medie divergono sistematicamente su un percorso con saliscendi
 * (più tempo per km in salita, meno in discesa) e ancora di più su tratti di lunghezza
 * disuguale (il raffinamento a trasferimenti preserva la SOMMA grezza delle potenze, che
 * coincide con la media pesata-distanza solo se i tratti hanno la stessa lunghezza).
 *
 * Ad ogni iterazione: simula, misura la media vera, calcola un fattore di scala
 * `target/attuale`, riscala tutte le potenze moltiplicativamente, ri-clampa su
 * `[minPower, maxPower]` con lo stesso water-filling del seed (pesato sulla distanza — non è
 * il peso "esatto" per la media pesata-tempo, che dipenderebbe circolarmente dalle potenze
 * stesse, ma un'approssimazione ragionevole che l'iterazione esterna raffina). Si ferma alla
 * tolleranza richiesta o al numero massimo di iterazioni (il fattore di scala è quasi lineare
 * in pratica, converge in poche iterazioni).
 */
function rescalePowersToTargetAvg(
  powers: number[],
  boundaries: { d0Km: number; d1Km: number }[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  simOpts: DynamicSimOptions,
  targetAvgPower: number,
  minPower: number,
  maxPower: number,
  toleranceW = 1.5,
  maxIterations = 8
): number[] {
  const n = boundaries.length;
  if (n === 0) return [];
  const distances = distancesOf(boundaries);
  let current = powers.slice();

  for (let iter = 0; iter < maxIterations; iter++) {
    const steps = simulateDynamicPacing(
      boundaries.map((b, i) => ({ d0Km: b.d0Km, d1Km: b.d1Km, targetPowerW: current[i]! })),
      routePoints,
      params,
      simOpts
    );
    const actualAvg = avgPowerFromSteps(steps);
    if (Math.abs(targetAvgPower - actualAvg) < toleranceW) break;
    const factor = actualAvg > 1e-6 ? targetAvgPower / actualAvg : 1;
    const scaled = current.map(p => p * factor);
    current = clampPreservingWeightedMean(scaled, distances, minPower, maxPower);
  }
  return current;
}

export interface DynamicOptimizerBoundary {
  d0Km: number;
  d1Km: number;
  gradient: number;
  windKmh?: number;
}

export interface DynamicOptimizerConstraints {
  targetAvgPower: number;
  targetNormalizedPower?: number | null;
  minPower: number;
  maxPower: number;
  /**
   * Vincolo di fatica CP/W' (opzionale). A differenza di `targetNormalizedPower` (limite
   * MORBIDO, penalizzato ma non impedito), questo è un vincolo DURO: l'ottimizzatore garantisce
   * (appiattendo il profilo quanto serve, via bisezione — vedi dentro `optimizePacingDynamic`)
   * che il bilancio W' (`computeWBalFromSteps`) non scenda mai sotto zero lungo la simulazione.
   * Se la media richiesta supera CP per una durata che esaurirebbe comunque la riserva (anche a
   * potenza perfettamente costante), il risultato riporta `fatigueInfeasible: true` — nessun
   * appiattimento risolverebbe quel caso, è un limite fisiologico della richiesta stessa, non
   * dell'algoritmo. Se non fornito, comportamento identico a prima (nessun impatto).
   */
  fatigue?: FatigueParams;
}

export interface DynamicOptimizerOptions {
  windZones?: WindZoneBoundary[];
  plannedStartMinuteOfDay?: number | null;
  gradientSmoothingM?: number;
  /**
   * Passato a `refinePacingWithDynamicSimulation` quando non c'è un NP target (ramo senza
   * hill-climbing NP-aware). Quando c'è un NP target e `maxTrials` non è specificato, il
   * numero di trial è invece derivato da `trialsPerSegment` (vedi lì) — impostare `maxTrials`
   * esplicitamente qui lo sovrascrive comunque in entrambi i rami.
   */
  maxTrials?: number;
  /**
   * Solo ramo con NP target: trial di hill-climbing per tratto (default 40, capped a 20000
   * totali). Ogni trial sposta potenza fra solo 2 tratti, quindi più tratti ci sono più trial
   * servono per esplorare lo spazio a sufficienza — misurato: con 262 tratti e un budget
   * fisso di 200 trial (indipendente dal numero di tratti) l'NP raggiunto poteva scostarsi di
   * +30W dal target anche con la media centrata. Ignorato se `maxTrials` è specificato.
   */
  trialsPerSegment?: number;
  seed?: number;
}

export interface DynamicOptimizerResult {
  powers: number[];
  totalTimeHours: number;
  timeWeightedAvgPower: number;
  normalizedPower: number;
  /** Bilancio W' minimo lungo il percorso, solo se `constraints.fatigue` era fornito —
   * `null` altrimenti (nessun calcolo eseguito, zero overhead quando non serve). */
  minWBalJ: number | null;
  /** `true` solo se `constraints.fatigue` era fornito E anche alla minima varianza possibile
   * (potenza perfettamente costante) il W'bal andrebbe comunque sotto zero — la media
   * richiesta supera CP per una durata insostenibile con questo W', indipendentemente da come
   * si distribuisce la potenza. `false` in ogni altro caso, incluso quando `fatigue` non è
   * fornito. */
  fatigueInfeasible: boolean;
}

/**
 * Sceglie la potenza per tratto usando SOLO il motore dinamico — nessun equilibrio, nessun
 * calcolo marginale via `speedFromPower` (quello era `optimizePacing`, rimosso: lavorava per
 * costruzione su un'astrazione a "microsezioni indipendenti", incompatibile con un modello
 * dove l'inerzia collega un tratto al successivo).
 *
 * Due fasi:
 * 1. Un punto di partenza geometrico (`buildGradientWeightedSeed`, solo pendenza) — più watt
 *    dove la pendenza è più ripida.
 * 2. Raffinamento per trasferimenti di potenza fra coppie di tratti (stesso hill-climbing di
 *    `refinePacingWithDynamicSimulation`): senza un NP target, accetta una mossa solo se il
 *    tempo simulato migliora. CON un NP target, il criterio è combinato — tempo simulato PIÙ
 *    una penalità se la NP simulata si allontana dal target oltre una piccola tolleranza —
 *    altrimenti (verificato empiricamente) un budget di tentativi generoso su una griglia
 *    fine converge quasi sempre allo stesso ottimo-tempo indipendente dal seed, "cancellando"
 *    l'effetto della scelta iniziale sulla NP.
 *
 * Il risultato riporta media/NP calcolate dalla simulazione FINALE vera (via
 * `avgPowerFromSteps`/`normalizedPowerFromSteps`), non stimate.
 *
 * `targetAvgPower` è trattato come vincolo quasi-duro: `rescalePowersToTargetAvg` viene
 * applicata sia subito dopo il seed (che per costruzione centra solo la media pesata sulla
 * distanza, non quella vera pesata sul tempo — vedi lì) sia sul risultato finale dopo il
 * raffinamento (che può reintrodurre lo scarto, specie su tratti di lunghezza disuguale —
 * diagnosticato e quantificato in sessione: senza questa doppia correzione un target di 230W
 * poteva restituire ~245W in un caso reale).
 */
export function optimizePacingDynamic(
  boundaries: DynamicOptimizerBoundary[],
  routePoints: ProcessedPoint[],
  params: PhysicsParams,
  constraints: DynamicOptimizerConstraints,
  options: DynamicOptimizerOptions = {}
): DynamicOptimizerResult {
  if (boundaries.length === 0) {
    return { powers: [], totalTimeHours: 0, timeWeightedAvgPower: 0, normalizedPower: 0, minWBalJ: null, fatigueInfeasible: false };
  }
  const { targetAvgPower, targetNormalizedPower, minPower, maxPower } = constraints;
  const n = boundaries.length;
  const simOpts = {
    dtSec: 1,
    initialSpeedMS: 0,
    windZones: options.windZones,
    plannedStartMinuteOfDay: options.plannedStartMinuteOfDay,
    gradientSmoothingM: options.gradientSmoothingM
  };
  const simulateFor = (powers: number[]) =>
    simulateDynamicPacing(
      boundaries.map((b, i) => ({ d0Km: b.d0Km, d1Km: b.d1Km, targetPowerW: powers[i]! })),
      routePoints,
      params,
      simOpts
    );
  const evalFor = (powers: number[]) => {
    const steps = simulateFor(powers);
    return { timeHours: totalDynamicSimTimeHours(steps, simOpts.dtSec), np: normalizedPowerFromSteps(steps, simOpts.dtSec), avg: avgPowerFromSteps(steps) };
  };

  const rawSeed = buildGradientWeightedSeed(boundaries, targetAvgPower, minPower, maxPower, 3);
  const plainBoundaries = boundaries.map(b => ({ d0Km: b.d0Km, d1Km: b.d1Km }));
  const seed = rescalePowersToTargetAvg(rawSeed, plainBoundaries, routePoints, params, simOpts, targetAvgPower, minPower, maxPower);
  const hasNpTarget = !!targetNormalizedPower && targetNormalizedPower > 50;

  let powers: number[];
  let fatigueInfeasible = false;

  if (!hasNpTarget || n < 2) {
    // Nessun NP target (o un solo tratto, niente da trasferire): il raffinamento a solo
    // tempo esistente basta.
    const refined = refinePacingWithDynamicSimulation(
      plainBoundaries,
      seed,
      routePoints,
      params,
      { minPower, maxPower, windZones: options.windZones, plannedStartMinuteOfDay: options.plannedStartMinuteOfDay, maxTrials: options.maxTrials, seed: options.seed }
    );
    powers = rescalePowersToTargetAvg(refined.powers, plainBoundaries, routePoints, params, simOpts, targetAvgPower, minPower, maxPower);
  } else {
    powers = optimizeWithNpCeiling();
  }

  // VINCOLO DI FATICA CP/W' (opzionale, DURO — a differenza del limite NP che è morbido):
  // applicato per ULTIMO, dopo qualunque altro aggiustamento sopra, perché ha la priorità più
  // alta — un piano che esaurisce la riserva anaerobica non è eseguibile, a prescindere da
  // quanto sia vicino agli altri target. Stessa architettura a bisezione-di-appiattimento già
  // usata per il limite NP (D46/47), ma il test di fattibilità ad ogni iterazione è "il W'bal
  // minimo lungo tutta la simulazione resta ≥ 0" invece di "l'NP resta sotto un tetto" — molto
  // più fondato fisiologicamente, e non richiede stimare quale NP "equivalga" a un dato CP/W'.
  if (constraints.fatigue) {
    const distances = distancesOf(plainBoundaries);
    const minWBalFor = (p: number[]) => {
      const steps = simulateFor(p);
      return minWBalJ(computeWBalFromSteps(steps, constraints.fatigue!, simOpts.dtSec));
    };
    // Come in `buildGradientWeightedSeed`/D44: l'appiattimento centrato su `targetAvgPower`
    // preserva la media pesata sulla DISTANZA del profilo di base, non quella VERA pesata sul
    // tempo che conta davvero — su tratti di lunghezza disuguale (il caso comune) le due
    // derivano. Ogni candidato va quindi ripassato da `rescalePowersToTargetAvg` (la stessa
    // correzione iterativa di D44) prima di misurarne il W'bal, altrimenti la bisezione
    // convergerebbe su un profilo con la media sbagliata — verificato: senza questo passo la
    // media finita a 240.9W invece di 236W richiesti su un percorso reale a tratti disuguali.
    const flattenAndCorrect = (basePowers: number[], s: number): number[] => {
      const flattened = basePowers.map(p => targetAvgPower + s * (p - targetAvgPower));
      const clamped = clampPreservingWeightedMean(flattened, distances, minPower, maxPower);
      return rescalePowersToTargetAvg(clamped, plainBoundaries, routePoints, params, simOpts, targetAvgPower, minPower, maxPower);
    };
    if (minWBalFor(powers) < -1) {
      // Caso limite: anche a potenza PERFETTAMENTE COSTANTE (s=0, la minima varianza
      // possibile) il W'bal andrebbe sotto zero — significa che la media richiesta supera CP
      // per una durata che esaurisce la riserva comunque, indipendentemente da come si
      // distribuisce la potenza. Non risolvibile appiattendo: si usa comunque s=0 (il meglio
      // possibile) e si segnala l'infattibilità nel risultato.
      const flatOut = flattenAndCorrect(powers, 0);
      if (minWBalFor(flatOut) < -1) {
        powers = flatOut;
        fatigueInfeasible = true;
      } else {
        let lo = 0;
        let hi = 1;
        let bestFeasible = flatOut;
        for (let iter = 0; iter < 18; iter++) {
          const mid = (lo + hi) / 2;
          const candidate = flattenAndCorrect(powers, mid);
          if (minWBalFor(candidate) < -1) {
            hi = mid;
          } else {
            lo = mid;
            bestFeasible = candidate;
          }
        }
        powers = bestFeasible;
      }
    }
  }

  const final = evalFor(powers);
  const wBalSteps = constraints.fatigue ? computeWBalFromSteps(simulateFor(powers), constraints.fatigue, simOpts.dtSec) : null;
  return {
    powers,
    totalTimeHours: final.timeHours,
    timeWeightedAvgPower: final.avg,
    normalizedPower: final.np,
    minWBalJ: wBalSteps ? minWBalJ(wBalSteps) : null,
    fatigueInfeasible
  };

  // --- funzione locale: ramo con NP target (limite superiore) ---
  function optimizeWithNpCeiling(): number[] {

  // Con NP target: hill-climbing con costo tempo+NP (come `refinePacingWithDynamicSimulation`),
  // ma diviso in FASI: ad ogni fine-fase la media viene ri-centrata ESATTAMENTE sul target con
  // `rescalePowersToTargetAvg`, poi la ricerca NP riparte da lì. Prima versione di questo fix
  // provava una penalità "morbida" sulla media dentro la funzione di costo invece delle fasi:
  // funzionava peggio (misurato: su un caso con pochi tratti l'NP finiva PIÙ lontano dal
  // target, non più vicino — la penalità limitava l'esplorazione senza dare in cambio un
  // controllo preciso della media, che i trasferimenti a coppia non garantiscono comunque).
  // Ri-centrare periodicamente con un'operazione esatta invece di una penalità euristica
  // impedisce che la media derivi lontano dal target durante la ricerca (i trasferimenti a
  // coppia preservano solo la somma aritmetica delle potenze, non la media vera pesata sul
  // tempo — vedi `rescalePowersToTargetAvg`) SENZA vincolare la ricerca stessa.
  //
  // NP TARGET TRATTATO COME LIMITE SUPERIORE, non come valore da avvicinare simmetricamente:
  // avvicinarsi da SOTTO va benissimo (anzi, più bassa è meglio, se non costa troppo tempo),
  // il problema è solo superarlo.
  //
  // SCOPERTA CHIAVE: il motore dinamico è puramente tempo-ottimo rispetto al vincolo di media —
  // su un percorso con salite/discese marcate, la strategia tempo-ottima "naturale" concentra
  // MOLTA più potenza in salita e MOLTO meno altrove rispetto alla media (fisicamente corretto:
  // il tempo guadagnato spingendo in salita, dove la resistenza aerodinamica pesa poco, supera
  // quello perso rilasciando dove pesa molto) — un profilo naturalmente ad alta varianza, quindi
  // NP naturalmente molto più alta della media anche senza alcun bug.
  //
  // DUE TENTATIVI SCARTATI prima di questo, entrambi basati su trasferimenti a COPPIA (sposta
  // potenza fra 2 tratti alla volta): (1) coppia argmax/argmin globale — su una salita a
  // pendenza costante decine di tratti finiscono quasi alla stessa potenza di picco (un
  // plateau, non un singolo picco isolato), quindi l'argmax deterministico ritentava la STESSA
  // coppia respinta per centinaia di trial di fila; (2) coppia scelta a caso dentro i quartili
  // estremi — evita di bloccarsi su una coppia fissa, ma resta troppo LOCALE: su un percorso
  // senza discese vere (es. salita seguita da pianura, non da discesa) spostare pochi watt alla
  // volta fra due tratti cambia l'NP (media alla QUARTA potenza, un aggregato sull'INTERO
  // percorso) di una quantità infinitesimale ad ogni singolo trasferimento — servirebbero
  // decine di migliaia di trasferimenti accettati per sommare a una riduzione di NP
  // significativa, troppi per un budget interattivo.
  //
  // FIX ADOTTATO (prima iterazione, D46): invece di trasferimenti locali, una ricerca binaria
  // su un fattore di "appiattimento" GLOBALE — quanto comprimere la potenza di OGNI tratto
  // verso la media, in un colpo solo su tutto il percorso. Fattore 1 = profilo invariato,
  // fattore 0 = potenza perfettamente costante (NP = media, il minimo teorico). Bisezione per
  // il fattore più alto (meno invasivo) per cui l'NP resta entro il limite.
  //
  // BUG SUCCESSIVO (D47): la bisezione partiva dal SEED GEOMETRICO grezzo (basato solo sulla
  // pendenza, mai passato da una vera ricerca a costo-tempo), non dall'allocazione VERAMENTE
  // tempo-ottima. Risultato osservato dall'utente: NP target 260 (limite) → NP calcolata 243,
  // un sottoutilizzo di 17W di margine — il piano risultava "estremamente piatto", più lento
  // del necessario. Confrontando con come lavora Best Bike Split (che parte dal target NP/IF e
  // lo usa per intero per massimizzare la velocità, non lo tratta come qualcosa da evitare da
  // lontano): il limite NP va SPESO, non solo rispettato. Appiattire un seed già mediocre
  // produce un risultato più piatto ancora, ben sotto il limite anche quando ci sarebbe
  // margine per andare più forte. Fix: calcolare PRIMA l'allocazione libera vera (tempo-ottima
  // rispetto al solo vincolo di media, via lo stesso `refinePacingWithDynamicSimulation` del
  // ramo senza NP target) e appiattire QUELLA se necessario, non il seed grezzo — se la sua NP
  // è già sotto il limite, va benissimo così com'è (nessun appiattimento, tempo pienamente
  // ottimo); se la supera, la bisezione parte dalla forma migliore possibile e la comprime solo
  // quanto strettamente necessario per rientrare, sfruttando il margine disponibile invece di
  // sprecarlo.
  const npToleranceW = 3;
  const npCeiling = targetNormalizedPower!;
  const distances = distancesOf(plainBoundaries);

  const freeOptimalTrials = options.maxTrials ?? Math.min(6000, Math.max(150, n * 20));
  const freeOptimal = refinePacingWithDynamicSimulation(plainBoundaries, seed, routePoints, params, {
    minPower, maxPower, windZones: options.windZones, plannedStartMinuteOfDay: options.plannedStartMinuteOfDay, maxTrials: freeOptimalTrials, seed: options.seed
  }).powers;

  // `flattenTowardAvg(s)`: per ogni tratto, `avg + s*(potenza-avg)` — s=1 lascia invariato,
  // s=0 appiattisce del tutto — poi ri-clampa su [minPower,maxPower] preservando la media
  // pesata sulla distanza (stesso water-filling di `buildGradientWeightedSeed`).
  const flattenTowardAvg = (basePowers: number[], s: number): number[] => {
    const flattened = basePowers.map(p => targetAvgPower + s * (p - targetAvgPower));
    return clampPreservingWeightedMean(flattened, distances, minPower, maxPower);
  };

  let powers = freeOptimal.slice();
  let current = evalFor(powers);

  if (current.np > npCeiling + npToleranceW) {
    // Bisezione: troviamo il fattore di appiattimento più alto (meno invasivo, quindi più
    // vicino possibile all'allocazione tempo-ottima libera) che rispetta il limite. 18
    // iterazioni bastano abbondantemente (converge più che linearmente, ogni iterazione costa
    // una sola simulazione).
    let lo = 0;
    let hi = 1;
    let bestFeasible = flattenTowardAvg(freeOptimal, 0); // fallback: s=0 è SEMPRE fattibile (potenza ~costante ⇒ NP≈media)
    for (let iter = 0; iter < 18; iter++) {
      const mid = (lo + hi) / 2;
      const candidate = flattenTowardAvg(freeOptimal, mid);
      const evalC = evalFor(candidate);
      if (evalC.np > npCeiling + npToleranceW) {
        hi = mid;
      } else {
        lo = mid;
        bestFeasible = candidate;
      }
    }
    powers = bestFeasible;
    current = evalFor(powers);
  }

  // Raffinamento leggero a trasferimenti (budget ridotto: la bisezione ha già fatto il grosso
  // del lavoro sull'NP, qui si tratta solo di recuperare un po' di tempo senza violare il
  // limite) — stesso costo con penalità solo-sopra-limite, stessa euristica a quartili per
  // dare priorità ai tratti che contano quando l'NP è ancora sopra soglia.
  const trialsPerSegment = options.trialsPerSegment ?? 15;
  const maxTrials = options.maxTrials ?? Math.min(6000, Math.max(150, n * trialsPerSegment));
  const rand = mulberry32(options.seed ?? 20260902);
  const npPenaltyPerWattSec = 40; // alto apposta: sopra al limite, ridurre NP conta più del tempo
  const costOf = (timeHours: number, np: number) =>
    timeHours * 3600 + npPenaltyPerWattSec * Math.max(0, np - npCeiling - npToleranceW);

  const numPhases = 3;
  const trialsPerPhase = Math.max(1, Math.ceil(maxTrials / numPhases));
  let bestCost = costOf(current.timeHours, current.np);

  for (let phase = 0; phase < numPhases; phase++) {
    for (let t = 0; t < trialsPerPhase; t++) {
      const trial = phase * trialsPerPhase + t;
      const progress = trial / maxTrials;
      const step = Math.max(1, Math.round(6 * (1 - progress)));

      let i: number;
      let j: number;
      if (current.np > npCeiling + npToleranceW && rand() < 0.7) {
        const sortedIdx = Array.from({ length: n }, (_, k) => k).sort((a, b) => powers[b]! - powers[a]!);
        const quartile = Math.max(1, Math.floor(n / 4));
        i = sortedIdx[Math.floor(rand() * quartile)]!;
        j = sortedIdx[n - 1 - Math.floor(rand() * quartile)]!;
        if (i === j) j = (j + 1) % n;
      } else {
        i = Math.floor(rand() * n);
        j = Math.floor(rand() * n);
        if (j === i) j = (j + 1) % n;
      }

      if (powers[i]! - step < minPower || powers[j]! + step > maxPower) continue;
      const candidate = powers.slice();
      candidate[i]! -= step;
      candidate[j]! += step;
      const evalC = evalFor(candidate);
      const cost = costOf(evalC.timeHours, evalC.np);
      if (cost < bestCost - 1e-7) {
        powers = candidate;
        bestCost = cost;
        current = evalC;
      }
    }
    // Ricentra ESATTAMENTE la media prima della fase successiva (o prima di restituire il
    // risultato, all'ultima iterazione).
    powers = rescalePowersToTargetAvg(powers, plainBoundaries, routePoints, params, simOpts, targetAvgPower, minPower, maxPower);
    current = evalFor(powers);
    bestCost = costOf(current.timeHours, current.np);
  }

  const correctedPowers = powers;
  return correctedPowers;
  }
}
