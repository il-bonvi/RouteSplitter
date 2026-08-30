import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  smoothByDistance,
  smoothByTime,
  lttb,
  computeGainLossBetween,
  getInterpolatedPoint,
  windAtDistKm,
  routeBearingAtDistKm,
  effectiveHeadwindKmh,
  type SectionBreakpoint,
  type ChartPoint
} from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';
import { getGradientColor } from '../lib/gradientColor.js';
import { headwindColor, headwindOpacity } from '../lib/windDisplay.js';
import { SmoothingControl } from './SmoothingControl.js';
import { NumberField } from './NumberField.js';
import type { ActivityDisplayPoint } from '../activity/buildActivityDisplay.js';

interface HoverInfo {
  lat: number;
  lon: number;
}

interface SelectionStats {
  distKm: number;
  gain: number;
  loss: number;
  avgGrade: number;
}

interface ActivityElevationChartProps {
  points: ActivityDisplayPoint[];
  smoothingRadiusMeters: number;
  onSmoothingChange: (radiusMeters: number) => void;
  onHoverPoint?: (info: HoverInfo | null) => void;
  breakpoints: SectionBreakpoint[];
  addMode: boolean;
  onAddBreakpoint: (distKm: number) => void;
  onRemoveBreakpoint: (id: string) => void;
  windZones?: WindZoneBoundary[];
  /** Confronto pianificato-vs-reale (F3.3): se presente, disegna una seconda linea di
   * potenza (tratteggiata) sullo stesso asse destro, per sovrapporre "cosa prevedeva il
   * piano" a "cosa mostrano i dati". Opzionale — assente/vuoto = comportamento identico a
   * prima (nessuna riga aggiuntiva), così F3.1 non cambia. */
  plannedPowerSeries?: Array<{ distKm: number; powerWatts: number }>;
  /** Stesso principio di plannedPowerSeries, ma per la velocità pianificata (asse destro
   * dedicato, colore diverso dalla potenza). Opzionale — assente/vuoto = nessuna riga. */
  plannedSpeedSeries?: Array<{ distKm: number; speedKmh: number }>;
  /** Testo della legenda/checkbox per la linea tratteggiata di potenza — default "pianificata".
   * Permette a un chiamante (es. "Verifica dati" a livello di microsezione in Tab 3) di
   * rietichettarla come "verificata (da potenza reale)" quando la serie passata in
   * plannedPowerSeries non è più il piano ma un valore derivato dalla potenza reale — il
   * grafico non deve mai mostrare un'etichetta che non descrive più cosa sta disegnando. */
  plannedPowerLabel?: string;
  /** Stesso principio di plannedPowerLabel, per la velocità. */
  plannedSpeedLabel?: string;
  /** Distanze (km) delle microsezioni automatiche (griglia fine F3.3), disegnate come tacche
   * verticali leggere. Vuoto/assente = nessuna tacca (comportamento invariato per F3.1). */
  microBoundariesKm?: number[];
}

interface ChartDatum extends ChartPoint {
  gradient: number;
  lat: number;
  lon: number;
  powerW: number | null;
  speedKmh: number | null;
}

// Margine destro ulteriormente allargato (46 -> 82): deve ospitare DUE assi destri quando sia
// potenza che velocità sono visibili insieme (F3.4/streams), non solo quello della potenza.
const MARGIN = { top: 20, right: 82, bottom: 40, left: 55 };

// Colori degli stream dati (assi, linee, legenda, checkbox) — un'unica definizione condivisa.
// Richiesta precisa: la potenza reale/pianificata avevano due tinte ben DIVERSE (arancio/blu)
// — quello il problema, non il contrario — mentre velocità reale/pianificata avevano già due
// tinte SIMILI (due verdi) ed erano corrette così. Fix: potenza ora due tinte della STESSA
// famiglia (blu scuro/chiaro, come lo era già la velocità), arancio sostituito su richiesta;
// velocità invariata rispetto a prima di questa correzione.
const COLOR_POWER_REAL = '#4338ca';
const COLOR_POWER_PLANNED = '#7c9cff';
const COLOR_SPEED_REAL = '#10b981';
const COLOR_SPEED_PLANNED = '#6ee7b7';
const TOTAL_W = 900;
const TOTAL_H = 290;
const W = TOTAL_W - MARGIN.left - MARGIN.right;
const H = TOTAL_H - MARGIN.top - MARGIN.bottom;

// Oltre questa densità di punti grezzi, lo smoothing e il rebuild D3 a valle iniziano a
// farsi sentire -- un'uscita di più ore a 1 Hz può avere svariate migliaia di punti, molti
// più di un GPX pianificato (da cui questo problema non esiste in ElevationChart). Si
// riduce con lo stesso LTTB già usato per il disegno finale, ma PRIMA di smussare.
const MAX_SOURCE_POINTS = 4000;

/**
 * Grafico altimetria di un'attività reale -- stesso motore, stesso HUD, stessa logica di
 * ElevationChart (vento, breakpoint/sezioni manuali, zoom, hover): non una versione
 * "semplificata", lo stesso strumento applicato a un'uscita registrata invece che a un
 * percorso da pianificare. Uniche differenze deliberate: la linea di potenza (asse destro,
 * assente nell'originale perché lì non c'è potenza registrata da mostrare), nessuna card di
 * sezione con potenza/tempo target (qui le sezioni servono solo a isolare un tratto per la
 * stima CdA, non a pianificare un ritmo), e un downsampling più aggressivo prima dello
 * smoothing per la maggiore densità di punti di un'uscita reale.
 */
export function ActivityElevationChart({
  points,
  smoothingRadiusMeters,
  onSmoothingChange,
  onHoverPoint,
  breakpoints,
  addMode,
  onAddBreakpoint,
  onRemoveBreakpoint,
  windZones,
  plannedPowerSeries,
  plannedSpeedSeries,
  plannedPowerLabel = 'pianificata',
  plannedSpeedLabel = 'pianificata',
  microBoundariesKm
}: ActivityElevationChartProps) {
  // BUG REALE TROVATO (causa vera dell'hover che sparisce da fermo, mai davvero chiusa nei
  // giri precedenti): un default-parameter tipo `windZones = []` nella destrutturazione crea
  // un array NUOVO a ogni singola esecuzione della funzione componente quando il chiamante
  // OMETTE la prop — e infatti il grafico "confronto con uscita reale" non passava affatto
  // `microBoundariesKm`. Essendo questi array nel dependency array dell'effetto D3 qui sotto
  // (quello che fa `container.innerHTML = ''` e ridisegna tutto), una nuova identità ad ogni
  // render — cioè ad OGNI movimento del mouse, dato che l'hover aggiorna lo stato del
  // genitore per sincronizzare il marker sulla mappa — smontava e ricostruiva l'intero
  // grafico in continuazione: l'hover restava sempre "appena resettato e invisibile" un
  // istante dopo essere apparso, indistinguibile da "sparisce quando il mouse è fermo".
  // Fix a livello di COMPONENTE (non di singolo chiamante, che è come si era già rotto una
  // volta): un riferimento stabile via useRef, mai ricreato, usato solo se il chiamante non
  // fornisce l'array. Protegge anche da futuri call site che dimenticassero di passarli.
  const stableEmptyArrayRef = useRef<never[]>([]);
  const safeWindZones = windZones ?? stableEmptyArrayRef.current;
  const safePlannedPowerSeries = plannedPowerSeries ?? stableEmptyArrayRef.current;
  const safePlannedSpeedSeries = plannedSpeedSeries ?? stableEmptyArrayRef.current;
  const safeMicroBoundariesKm = microBoundariesKm ?? stableEmptyArrayRef.current;
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  const [selectionStats, setSelectionStats] = useState<SelectionStats | null>(null);
  // Le 4 linee (potenza/velocità × reale/pianificata) sono TUTTE indipendentemente
  // disattivabili — non due gruppi ("Potenza"/"Velocità") come nella prima versione: un
  // gruppo unico non permetteva di nascondere ad es. solo "velocità pianificata" tenendo
  // "velocità reale" visibile. Tutte visibili di default (comportamento storico).
  const [showPowerReal, setShowPowerReal] = useState(true);
  const [showPowerPlanned, setShowPowerPlanned] = useState(true);
  const [showSpeedReal, setShowSpeedReal] = useState(true);
  const [showSpeedPlanned, setShowSpeedPlanned] = useState(true);
  // Media mobile aggiuntiva, in SECONDI, applicata solo a potenza e velocità REALI — del
  // tutto indipendente dallo smoothing a metri qui sopra (che resta invariato, tocca solo
  // elevazione/pendenza/potenza a distanza fissa) e dalle serie pianificate (mai toccate).
  // Default 0 = nessun cambiamento rispetto a oggi: dato grezzo dal file FIT finché l'utente
  // non scrive un valore nella casella.
  const [streamSmoothingSec, setStreamSmoothingSec] = useState(0);

  const onHoverPointRef = useRef(onHoverPoint);
  const onAddBreakpointRef = useRef(onAddBreakpoint);
  const onRemoveBreakpointRef = useRef(onRemoveBreakpoint);
  useEffect(() => {
    onHoverPointRef.current = onHoverPoint;
    onAddBreakpointRef.current = onAddBreakpoint;
    onRemoveBreakpointRef.current = onRemoveBreakpoint;
  }, [onHoverPoint, onAddBreakpoint, onRemoveBreakpoint]);

  const fullData = useMemo<ChartDatum[]>(() => {
    if (points.length < 2) return [];
    const sourcePoints = points.length > MAX_SOURCE_POINTS ? lttb(points, MAX_SOURCE_POINTS) : points;
    const distances = sourcePoints.map(p => p.dist);
    const eleSmooth = smoothByDistance(
      sourcePoints.map(p => p.ele),
      distances,
      smoothingRadiusMeters
    );
    const gradSmooth = smoothByDistance(
      sourcePoints.map(p => p.gradient),
      distances,
      smoothingRadiusMeters
    );
    let lastPower = sourcePoints.find(p => p.powerW != null)?.powerW ?? 0;
    const powerFilled = sourcePoints.map(p => {
      if (p.powerW != null) lastPower = p.powerW;
      return lastPower;
    });
    const powerSmooth = smoothByDistance(powerFilled, distances, smoothingRadiusMeters);

    let lastSpeed = sourcePoints.find(p => p.speedKmh != null)?.speedKmh ?? 0;
    const speedFilled = sourcePoints.map(p => {
      if (p.speedKmh != null) lastSpeed = p.speedKmh;
      return lastSpeed;
    });

    // Secondo passaggio, indipendente dai due sopra: media mobile in secondi (non metri),
    // solo su potenza e velocità reali — vedi commento sullo state `streamSmoothingSec` più
    // sopra. A 0 non altera nulla (stesso identico dato grezzo di prima di questa modifica).
    const timesSec = sourcePoints.map(p => p.timeSec);
    const powerStreamSmooth = streamSmoothingSec > 0 ? smoothByTime(powerSmooth, timesSec, streamSmoothingSec) : powerSmooth;
    const speedStreamSmooth = streamSmoothingSec > 0 ? smoothByTime(speedFilled, timesSec, streamSmoothingSec) : speedFilled;

    return sourcePoints.map((p, i) => ({
      dist: p.dist / 1000,
      ele: eleSmooth[i]!,
      gradient: gradSmooth[i]!,
      lat: p.lat,
      lon: p.lon,
      powerW: p.powerW != null ? powerStreamSmooth[i]! : null,
      speedKmh: p.speedKmh != null ? speedStreamSmooth[i]! : null
    }));
  }, [points, smoothingRadiusMeters, streamSmoothingSec]);

  const hasPower = useMemo(() => fullData.some(d => d.powerW != null), [fullData]);
  const hasSpeed = useMemo(() => fullData.some(d => d.speedKmh != null), [fullData]);

  const windMaxAbs = useMemo(() => {
    if (safeWindZones.length < 2 || points.length < 2) return 0;
    const totalKm = points[points.length - 1]!.dist / 1000;
    if (totalKm <= 0) return 0;
    let max = 0;
    const coarseSamples = 150;
    for (let i = 0; i <= coarseSamples; i++) {
      const km = (totalKm * i) / coarseSamples;
      const wind = windAtDistKm(safeWindZones, km);
      if (!wind) continue;
      const bearing = routeBearingAtDistKm(points, km);
      max = Math.max(max, Math.abs(effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing)));
    }
    return Math.max(max, 3);
  }, [points, safeWindZones]);

  const pointsKey = points.length > 0 ? `${points[0]!.dist}-${points[points.length - 1]!.dist}-${points.length}` : '';
  useEffect(() => {
    setZoomDomain(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || fullData.length < 2) return;
    container.innerHTML = '';
    setSelectionStats(null);

    const fullMaxDist = fullData[fullData.length - 1]!.dist;
    const isZoomed = !!zoomDomain;
    const [d0, d1] = zoomDomain ?? [0, fullMaxDist];
    const visibleData = fullData.filter(d => d.dist >= d0 && d.dist <= d1);
    if (visibleData.length < 2) return;

    const displayData = isZoomed ? fullData : fullData.length > 2000 ? lttb(fullData, 1800) : fullData;

    const xScale = d3.scaleLinear().domain([d0, d1]).range([0, W]);

    const elevations = visibleData.map(d => d.ele);
    const minEle = Math.min(...elevations);
    const maxEle = Math.max(...elevations);
    const elevationGain = maxEle - minEle;
    const paddingTop = 300;
    const paddingBottom = minEle >= 100 ? 80 : Math.max(0, minEle * 0.5);
    const rangeYBase = Math.max(elevationGain * 1.5, elevationGain + 300);
    const rangeYFinal = rangeYBase + paddingBottom + paddingTop;
    const roundTo = 50;
    const yMin = Math.floor((minEle - paddingBottom) / roundTo) * roundTo;
    const yMaxRaw = Math.ceil((yMin + rangeYFinal) / roundTo) * roundTo;
    const yMaxCap = Math.ceil((maxEle + paddingTop) / roundTo) * roundTo;
    const yMax = Math.min(yMaxRaw, yMaxCap);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([H, 0]);

    const powerValues = visibleData.map(d => d.powerW).filter((w): w is number => w != null);
    const plannedPowerValues = safePlannedPowerSeries.filter(p => p.distKm >= d0 && p.distKm <= d1).map(p => p.powerWatts);
    const hasPlannedPower = safePlannedPowerSeries.length > 1;
    const allPowerValues = [...powerValues, ...plannedPowerValues];
    const powerMax = allPowerValues.length > 0 ? Math.max(...allPowerValues) * 1.15 : 0;
    const yScalePower = d3.scaleLinear().domain([0, powerMax || 1]).range([H, 0]);
    // L'asse compare se ALMENO UNA delle due linee di potenza è attualmente sia disponibile
    // che attivata dal relativo toggle — non più un unico interruttore "Potenza" per entrambe.
    const powerAxisVisible = (showPowerReal && hasPower) || (showPowerPlanned && hasPlannedPower);

    const speedValues = visibleData.map(d => d.speedKmh).filter((s): s is number => s != null);
    const plannedSpeedValues = safePlannedSpeedSeries.filter(p => p.distKm >= d0 && p.distKm <= d1).map(p => p.speedKmh);
    const hasPlannedSpeed = safePlannedSpeedSeries.length > 1;
    const allSpeedValues = [...speedValues, ...plannedSpeedValues];
    const speedMax = allSpeedValues.length > 0 ? Math.max(...allSpeedValues) * 1.15 : 0;
    const yScaleSpeed = d3.scaleLinear().domain([0, speedMax || 1]).range([H, 0]);
    const speedAxisVisible = (showSpeedReal && hasSpeed) || (showSpeedPlanned && hasPlannedSpeed);
    // Se entrambi gli assi sono attivi, la potenza resta sulla posizione "interna" (subito
    // dopo il grafico) e la velocità su quella "esterna" (ulteriori ~34px): ordine arbitrario
    // ma stabile, altrimenti gli assi "salterebbero" di posizione ogni volta che l'utente
    // spegne/riaccende uno dei due toggle.
    const speedAxisOffset = powerAxisVisible ? 34 : 0;

    const svg = d3
      .select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${TOTAL_W} ${TOTAL_H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('width', '100%')
      .style('height', 'auto')
      .style('display', 'block');

    svg.append('defs').append('clipPath').attr('id', 'activity-elev-clip').append('rect').attr('width', W).attr('height', H);

    const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    g.append('g')
      .attr('transform', `translate(0,${H})`)
      .call(d3.axisBottom(xScale).ticks(8).tickFormat(d => `${(d as number).toFixed(1)} km`))
      .selectAll('text')
      .style('font-size', '10px')
      .style('fill', '#6b7280');
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6).tickFormat(d => `${d} m`))
      .selectAll('text')
      .style('font-size', '10px')
      .style('fill', '#6b7280');
    if (powerAxisVisible) {
      g.append('g')
        .attr('transform', `translate(${W},0)`)
        .call(d3.axisRight(yScalePower).ticks(6).tickFormat(d => `${d} W`))
        .selectAll('text')
        .style('font-size', '10px')
        .style('fill', COLOR_POWER_REAL);
    }
    if (speedAxisVisible) {
      g.append('g')
        .attr('transform', `translate(${W + speedAxisOffset},0)`)
        .call(d3.axisRight(yScaleSpeed).ticks(6).tickFormat(d => `${d} km/h`))
        .selectAll('text')
        .style('font-size', '10px')
        .style('fill', COLOR_SPEED_REAL);
    }

    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6).tickSize(-W).tickFormat(() => ''))
      .selectAll('line')
      .style('stroke', '#e5e7eb')
      .style('stroke-dasharray', '3,3');

    g.selectAll('.domain').style('stroke', '#d1d5db');

    if (safeMicroBoundariesKm.length > 0) {
      // Tacche sottili non interattive alle distanze delle microsezioni (griglia automatica
      // F3.3) — deliberatamente senza numeri/cerchi come i breakpoint veri (potrebbero
      // essere centinaia): solo un riferimento visivo di dove cade ogni bin.
      g.append('g')
        .attr('class', 'micro-boundaries')
        .attr('pointer-events', 'none')
        .selectAll('line')
        .data(safeMicroBoundariesKm.filter(km => km >= d0 && km <= d1))
        .join('line')
        .attr('x1', km => xScale(km))
        .attr('x2', km => xScale(km))
        .attr('y1', 0)
        .attr('y2', H)
        .attr('stroke', '#a78bfa')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,3')
        .attr('opacity', 0.55);
    }

    if (safeWindZones.length >= 2 && windMaxAbs > 0) {
      const bandH = 7;
      const bandY = -bandH - 5;
      const bandSamples = 110;
      const windG = g.append('g').attr('class', 'wind-band').attr('pointer-events', 'none');
      const stepKm = (d1 - d0) / bandSamples;
      for (let i = 0; i < bandSamples; i++) {
        const kmStart = d0 + i * stepKm;
        const kmMid = kmStart + stepKm / 2;
        const wind = windAtDistKm(safeWindZones, kmMid);
        const headwindKmh = wind ? effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, routeBearingAtDistKm(points, kmMid)) : 0;
        const x = xScale(kmStart);
        const wpx = Math.max(1, xScale(kmStart + stepKm) - x);
        windG
          .append('rect')
          .attr('x', x)
          .attr('y', bandY)
          .attr('width', wpx + 0.6)
          .attr('height', bandH)
          .attr('rx', 1.5)
          .attr('fill', headwindColor(headwindKmh, windMaxAbs))
          .attr('opacity', headwindOpacity(headwindKmh, windMaxAbs));
      }
    }

    // pointer-events:none su tutto il gruppo dati (segmenti colorati, linee breakpoint,
    // testo): senza questo, il mouse FERMO sopra una di queste forme "piene" (fill/stroke
    // non trasparenti al puntatore, default SVG) veniva considerato dal browser sopra
    // QUELLA forma invece che sopra l'overlay del brush sottostante — anche se il brush è
    // appeso dopo (quindi visivamente sopra), l'hit-test del browser per un punto fermo può
    // comunque risolvere sull'elemento con contenuto "dipinto" più vicino se le due aree si
    // sovrappongono esattamente; il risultato visibile era l'hover che spariva restando
    // fermi. Il cerchio dei breakpoint riabilita esplicitamente pointer-events (deve
    // restare cliccabile per la rimozione).
    const chartG = g.append('g').attr('clip-path', 'url(#activity-elev-clip)').attr('pointer-events', 'none');
    for (let i = 1; i < displayData.length; i++) {
      const p1 = displayData[i - 1]!;
      const p2 = displayData[i]!;
      if (p2.dist < d0 || p1.dist > d1) continue;
      const color = getGradientColor(p2.gradient);
      const x1 = xScale(p1.dist);
      const x2 = xScale(p2.dist);
      const y1 = yScale(p1.ele);
      const y2 = yScale(p2.ele);
      chartG.append('path').attr('d', `M${x1},${y1} L${x2},${y2} L${x2},${H} L${x1},${H} Z`).attr('fill', color).attr('opacity', 0.65);
      chartG.append('line').attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2).attr('stroke', color).attr('stroke-width', 1.5);
    }

    if (hasPower && showPowerReal) {
      const powerLine = d3
        .line<ChartDatum>()
        .defined(d => d.powerW != null)
        .x(d => xScale(d.dist))
        .y(d => yScalePower(d.powerW!))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(displayData)
        .attr('clip-path', 'url(#activity-elev-clip)')
        .attr('fill', 'none')
        .attr('stroke', COLOR_POWER_REAL)
        .attr('stroke-width', 1.6)
        .attr('opacity', 0.9)
        .attr('pointer-events', 'none')
        .attr('d', powerLine);
    }

    if (hasPlannedPower && showPowerPlanned) {
      const plannedLine = d3
        .line<{ distKm: number; powerWatts: number }>()
        .x(d => xScale(d.distKm))
        .y(d => yScalePower(d.powerWatts))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(safePlannedPowerSeries)
        .attr('clip-path', 'url(#activity-elev-clip)')
        .attr('fill', 'none')
        .attr('stroke', COLOR_POWER_PLANNED)
        .attr('stroke-width', 1.8)
        .attr('stroke-dasharray', '6,4')
        .attr('opacity', 0.95)
        .attr('pointer-events', 'none')
        .attr('d', plannedLine);
    }

    if (hasSpeed && showSpeedReal) {
      const speedLine = d3
        .line<ChartDatum>()
        .defined(d => d.speedKmh != null)
        .x(d => xScale(d.dist))
        .y(d => yScaleSpeed(d.speedKmh!))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(displayData)
        .attr('clip-path', 'url(#activity-elev-clip)')
        .attr('fill', 'none')
        .attr('stroke', COLOR_SPEED_REAL)
        .attr('stroke-width', 1.6)
        .attr('opacity', 0.9)
        .attr('pointer-events', 'none')
        .attr('d', speedLine);
    }

    if (hasPlannedSpeed && showSpeedPlanned) {
      const plannedSpeedLine = d3
        .line<{ distKm: number; speedKmh: number }>()
        .x(d => xScale(d.distKm))
        .y(d => yScaleSpeed(d.speedKmh))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(safePlannedSpeedSeries)
        .attr('clip-path', 'url(#activity-elev-clip)')
        .attr('fill', 'none')
        .attr('stroke', COLOR_SPEED_PLANNED)
        .attr('stroke-width', 1.8)
        .attr('stroke-dasharray', '6,4')
        .attr('opacity', 0.95)
        .attr('pointer-events', 'none')
        .attr('d', plannedSpeedLine);
    }

    if (isZoomed) {
      const hint = document.createElement('div');
      hint.textContent = 'Doppio clic per reset zoom';
      hint.style.cssText =
        'position:absolute;top:6px;right:8px;font-size:10px;color:#9ca3af;font-family:JetBrains Mono,monospace;pointer-events:none;';
      container.style.position = 'relative';
      container.appendChild(hint);
    }

    const bpG = chartG.append('g');
    const markerY = 18;
    breakpoints.forEach((bp, i) => {
      if (bp.distKm < d0 || bp.distKm > d1) return;
      const x = xScale(bp.distKm);
      const color = bp.fixed === 'start' ? '#22c55e' : bp.fixed === 'finish' ? '#fc5200' : '#3b82f6';
      const grp = bpG.append('g').attr('transform', `translate(${x},0)`);
      grp.append('line').attr('y1', 0).attr('y2', H).attr('stroke', color).attr('stroke-dasharray', '4,3').attr('stroke-width', 1.3).attr('opacity', 0.8);
      grp
        .append('circle')
        .attr('cy', markerY)
        .attr('r', 8)
        .attr('fill', color)
        .attr('stroke', '#fff')
        .attr('stroke-width', 2)
        .attr('pointer-events', 'auto')
        .style('cursor', bp.fixed ? 'default' : 'pointer')
        .on('click', event => {
          event.stopPropagation();
          if (!bp.fixed) onRemoveBreakpointRef.current(bp.id);
        });
      grp
        .append('text')
        .attr('y', markerY + 3)
        .attr('text-anchor', 'middle')
        .attr('font-size', '9px')
        .attr('font-weight', '700')
        .style('fill', '#fff')
        .style('pointer-events', 'none')
        .text(i + 1);
    });

    let tooltip = document.getElementById('activity-elev-hover-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'activity-elev-hover-tooltip';
      tooltip.style.cssText =
        'position:fixed;pointer-events:none;display:none;background:rgba(15,15,15,0.92);color:#fff;' +
        'padding:6px 12px;border-radius:6px;font-size:13px;font-family:JetBrains Mono,monospace;z-index:99999;' +
        'white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,0.35);border-left:3px solid #fc5200;';
      document.body.appendChild(tooltip);
    }
    tooltip.style.display = 'none';

    const hoverLine = g
      .append('line')
      .attr('y1', 0)
      .attr('y2', H)
      .attr('stroke', '#555')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,3')
      .attr('opacity', 0)
      // Stesso bug di chartG più sopra, mai corretto QUI: un cerchio pieno (fill non
      // trasparente al puntatore per default SVG) disegnato esattamente sotto il cursore —
      // per costruzione, è dove si trova il mouse — può "rubare" l'hit-test del browser a un
      // puntatore fermo, anche se l'overlay del brush è sopra nell'ordine di disegno. Risultato
      // visibile: l'hover sembra sparire solo quando il mouse resta fermo (mai mentre si
      // muove). Esplicitamente non interattivo, come già fatto per l'area colorata e le linee.
      .attr('pointer-events', 'none');
    const hoverDot = g
      .append('circle')
      .attr('r', 5)
      .attr('fill', '#fc5200')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .attr('opacity', 0)
      .attr('pointer-events', 'none');

    const bisectDist = d3.bisector<ChartDatum, number>(d => d.dist).left;

    function updateHover(clientX: number, clientY: number, svgX: number) {
      // Vedi commento nella stessa funzione in ElevationChart.tsx: clampato a [d0,d1] per
      // evitare che l'hover resti "bloccato" vicino ai bordi del grafico.
      const dist = Math.max(d0, Math.min(d1, xScale.invert(svgX)));
      const idx = bisectDist(fullData, dist);
      const a = fullData[Math.max(0, idx - 1)];
      const b = fullData[Math.min(fullData.length - 1, idx)];
      if (!a || !b) return;
      const point = Math.abs(a.dist - dist) < Math.abs(b.dist - dist) ? a : b;

      const cx = xScale(point.dist);
      const cy = yScale(point.ele);
      hoverLine.attr('x1', cx).attr('x2', cx).attr('opacity', 0.7);
      hoverDot.attr('cx', cx).attr('cy', cy).attr('opacity', 1);

      const color = getGradientColor(point.gradient);
      const sign = point.gradient > 0.05 ? '+' : '';
      const powerPart = point.powerW != null ? ` &nbsp;·&nbsp; ${Math.round(point.powerW)} W` : '';
      const speedPart = point.speedKmh != null ? ` &nbsp;·&nbsp; ${point.speedKmh.toFixed(1)} km/h` : '';
      tooltip!.innerHTML =
        `↑ <b>${point.ele.toFixed(0)} m</b> &nbsp;·&nbsp; ${point.dist.toFixed(2)} km` +
        `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${color};color:#fff;font-size:11px;font-weight:700;margin-left:6px;">${sign}${point.gradient.toFixed(1)}%</span>` +
        powerPart +
        speedPart;
      tooltip!.style.display = 'block';
      let tx = clientX + 16;
      let ty = clientY - 38;
      if (tx + 220 > window.innerWidth) tx = clientX - 230;
      if (ty < 0) ty = clientY + 12;
      tooltip!.style.left = `${tx}px`;
      tooltip!.style.top = `${ty}px`;

      onHoverPointRef.current?.({ lat: point.lat, lon: point.lon });
    }

    function clearHover() {
      hoverLine.attr('opacity', 0);
      hoverDot.attr('opacity', 0);
      tooltip!.style.display = 'none';
      onHoverPointRef.current?.(null);
    }

    const brushG = g.append('g').attr('class', 'brush');
    let isBrushing = false;

    const brush = d3
      .brushX()
      .extent([
        [0, 0],
        [W, H]
      ])
      .on('start', () => {
        isBrushing = true;
        tooltip!.style.display = 'none';
      })
      .on('brush', event => {
        if (!event.selection) return;
        const [x0, x1] = event.selection as [number, number];
        const selD0 = xScale.invert(Math.min(x0, x1));
        const selD1 = xScale.invert(Math.max(x0, x1));
        const { gain, loss } = computeGainLossBetween(points, selD0, selD1);
        const distKm = selD1 - selD0;
        const eleAtD0 = getInterpolatedPoint(points, selD0 * 1000).ele;
        const eleAtD1 = getInterpolatedPoint(points, selD1 * 1000).ele;
        const avgGrade = distKm > 0 ? ((eleAtD1 - eleAtD0) / (distKm * 1000)) * 100 : 0;
        setSelectionStats({ distKm, gain, loss, avgGrade });
      })
      .on('end', event => {
        isBrushing = false;
        if (!event.selection) {
          if (addMode && event.sourceEvent) {
            const [mx] = d3.pointer(event.sourceEvent, g.node());
            if (mx >= 0 && mx <= W) onAddBreakpointRef.current(xScale.invert(mx));
          }
          return;
        }
        const [x0, x1] = event.selection as [number, number];
        const newD0 = xScale.invert(x0);
        const newD1 = xScale.invert(x1);
        brushG.call(brush.move, null);
        if (newD1 - newD0 > 0.05) setZoomDomain([newD0, newD1]);
      });
    brushG.call(brush);
    brushG.select('.selection').style('fill', 'rgba(252,82,0,0.15)').style('stroke', '#fc5200');
    brushG.on('dblclick', () => setZoomDomain(null));
    if (addMode) brushG.style('cursor', 'crosshair');

    brushG
      .on('mousemove', event => {
        if (isBrushing) return;
        const [mx] = d3.pointer(event, g.node());
        updateHover(event.clientX, event.clientY, mx);
      })
      .on('mouseleave', () => clearHover());

    return () => {
      tooltip!.style.display = 'none';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fullData,
    zoomDomain,
    breakpoints,
    addMode,
    points,
    safeWindZones,
    windMaxAbs,
    hasPower,
    hasSpeed,
    safePlannedPowerSeries,
    safePlannedSpeedSeries,
    showPowerReal,
    showPowerPlanned,
    showSpeedReal,
    showSpeedPlanned,
    safeMicroBoundariesKm
  ]);

  if (points.length < 2) return null;

  const hasPlannedPower = safePlannedPowerSeries.length > 1;
  const hasPlannedSpeed = safePlannedSpeedSeries.length > 1;
  const canToggleAnything = hasPower || hasPlannedPower || hasSpeed || hasPlannedSpeed;

  return (
    <>
      <div className="gradient-legend">
        <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap', width: '100%', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '1.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {selectionStats && (
              <>
                <span>
                  📏 <strong>{selectionStats.distKm.toFixed(2)} km</strong>
                </span>
                <span>
                  ↑ <strong style={{ color: '#16a34a' }}>+{Math.round(selectionStats.gain)} m</strong>
                </span>
                <span>
                  ↓ <strong style={{ color: '#2563eb' }}>−{Math.round(selectionStats.loss)} m</strong>
                </span>
                <span>
                  ⛰{' '}
                  <strong>
                    {selectionStats.avgGrade >= 0 ? '+' : ''}
                    {selectionStats.avgGrade.toFixed(1)}%
                  </strong>{' '}
                  media
                </span>
              </>
            )}
            {canToggleAnything && (
              // 4 toggle indipendenti, non 2 gruppi ("Potenza"/"Velocità" uniti): altrimenti
              // non è possibile nascondere solo "velocità pianificata" tenendo "velocità
              // reale" visibile (o viceversa per la potenza) — ognuna delle 4 combinazioni
              // reale/pianificata × potenza/velocità va spenta/accesa per conto suo.
              <div className="stream-toggles">
                {hasPower && (
                  <label className="stream-toggle">
                    <input type="checkbox" checked={showPowerReal} onChange={e => setShowPowerReal(e.target.checked)} />
                    <i style={{ background: COLOR_POWER_REAL }} /> Potenza reale
                  </label>
                )}
                {hasPlannedPower && (
                  <label className="stream-toggle">
                    <input type="checkbox" checked={showPowerPlanned} onChange={e => setShowPowerPlanned(e.target.checked)} />
                    <i
                      style={{
                        background: `repeating-linear-gradient(to right, ${COLOR_POWER_PLANNED} 0 5px, transparent 5px 8px)`,
                        width: 16,
                        height: 3,
                        borderRadius: 0
                      }}
                    />{' '}
                    Potenza {plannedPowerLabel}
                  </label>
                )}
                {hasSpeed && (
                  <label className="stream-toggle">
                    <input type="checkbox" checked={showSpeedReal} onChange={e => setShowSpeedReal(e.target.checked)} />
                    <i style={{ background: COLOR_SPEED_REAL }} /> Velocità reale
                  </label>
                )}
                {hasPlannedSpeed && (
                  <label className="stream-toggle">
                    <input type="checkbox" checked={showSpeedPlanned} onChange={e => setShowSpeedPlanned(e.target.checked)} />
                    <i
                      style={{
                        background: `repeating-linear-gradient(to right, ${COLOR_SPEED_PLANNED} 0 5px, transparent 5px 8px)`,
                        width: 16,
                        height: 3,
                        borderRadius: 0
                      }}
                    />{' '}
                    Velocità {plannedSpeedLabel}
                  </label>
                )}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {(hasPower || hasSpeed) && (
              <label className="smoothing-control">
                <span>Media potenza/velocità (s):</span>
                <NumberField className="stream-smoothing-input" min={0} max={300} step={5} value={streamSmoothingSec} onCommit={v => setStreamSmoothingSec(Math.max(0, v))} />
              </label>
            )}
            <SmoothingControl radiusMeters={smoothingRadiusMeters} onChange={onSmoothingChange} />
          </div>
        </div>
      </div>
      <div ref={containerRef} className="elevation-chart" />
      {(showPowerReal && hasPower) || (showPowerPlanned && hasPlannedPower) ? (
        <div className="wind-ribbon-legend elevation-power-legend">
          {showPowerReal && hasPower && (
            <span>
              <i style={{ background: COLOR_POWER_REAL }} /> potenza reale
            </span>
          )}
          {showPowerPlanned && hasPlannedPower && (
            <span>
              <i
                style={{
                  background: `repeating-linear-gradient(to right, ${COLOR_POWER_PLANNED} 0 5px, transparent 5px 8px)`,
                  width: 16,
                  height: 3,
                  borderRadius: 0
                }}
              />{' '}
              potenza {plannedPowerLabel}
            </span>
          )}
        </div>
      ) : null}
      {(showSpeedReal && hasSpeed) || (showSpeedPlanned && hasPlannedSpeed) ? (
        <div className="wind-ribbon-legend elevation-speed-legend">
          {showSpeedReal && hasSpeed && (
            <span>
              <i style={{ background: COLOR_SPEED_REAL }} /> velocità reale
            </span>
          )}
          {showSpeedPlanned && hasPlannedSpeed && (
            <span>
              <i
                style={{
                  background: `repeating-linear-gradient(to right, ${COLOR_SPEED_PLANNED} 0 5px, transparent 5px 8px)`,
                  width: 16,
                  height: 3,
                  borderRadius: 0
                }}
              />{' '}
              velocità {plannedSpeedLabel}
            </span>
          )}
        </div>
      ) : null}
      {safeWindZones.length >= 2 && (
        <div className="wind-ribbon-legend elevation-wind-legend">
          <span>
            <i style={{ background: '#22c55e' }} /> in coda
          </span>
          <span>
            <i style={{ background: '#94a3b8' }} /> traverso
          </span>
          <span>
            <i style={{ background: '#ef4444' }} /> in testa
          </span>
        </div>
      )}
    </>
  );
}
