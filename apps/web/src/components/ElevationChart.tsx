import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  smoothByDistance,
  lttb,
  computeGainLossBetween,
  getInterpolatedPoint,
  windAtDistKm,
  routeBearingAtDistKm,
  effectiveHeadwindKmh,
  type ProcessedPoint,
  type ChartPoint,
  type SectionBreakpoint,
  type SectionResult
} from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';
import { getGradientColor } from '../lib/gradientColor.js';
import { formatTime } from '../lib/formatTime.js';
import { headwindColor, headwindOpacity } from '../lib/windDisplay.js';
import { SmoothingControl } from './SmoothingControl.js';

interface HoverInfo {
  lat: number;
  lon: number;
  ele: number;
  distKm: number;
  gradient: number;
}

interface SelectionStats {
  distKm: number;
  gain: number;
  loss: number;
  avgGrade: number;
}

interface ElevationChartProps {
  points: ProcessedPoint[];
  smoothingRadiusMeters: number;
  onSmoothingChange: (radiusMeters: number) => void;
  onHoverPoint?: (info: HoverInfo | null) => void;
  breakpoints: SectionBreakpoint[];
  sections: SectionResult[];
  addMode: boolean;
  onAddBreakpoint: (distKm: number) => void;
  onRemoveBreakpoint: (id: string) => void;
  windZones?: WindZoneBoundary[];
}

interface ChartDatum extends ChartPoint {
  gradient: number;
  lat: number;
  lon: number;
}

const MARGIN = { top: 20, right: 30, bottom: 40, left: 55 };
const TOTAL_W = 900;
const TOTAL_H = 290;
const W = TOTAL_W - MARGIN.left - MARGIN.right;
const H = TOTAL_H - MARGIN.top - MARGIN.bottom;

export function ElevationChart({
  points,
  smoothingRadiusMeters,
  onSmoothingChange,
  onHoverPoint,
  breakpoints,
  sections,
  addMode,
  onAddBreakpoint,
  onRemoveBreakpoint,
  windZones = []
}: ElevationChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  const [selectionStats, setSelectionStats] = useState<SelectionStats | null>(null);

  // I callback passati da fuori cambiano identità ad ogni render del genitore (sono
  // funzioni inline). Tenerli in un ref invece che nelle dipendenze dell'effetto D3
  // sotto evita di RICOSTRUIRE L'INTERO GRAFICO ad ogni hover — è esattamente il bug
  // segnalato ("l'hover appare muovendo il mouse, sparisce appena ci si ferma"): ogni
  // chiamata a onHoverPoint faceva ri-renderizzare il genitore, che passava una nuova
  // funzione, che faceva ripartire l'intero effetto (container.innerHTML = ''), che
  // ridisegnava il grafico da zero con l'hover di nuovo invisibile.
  const onHoverPointRef = useRef(onHoverPoint);
  const onAddBreakpointRef = useRef(onAddBreakpoint);
  const onRemoveBreakpointRef = useRef(onRemoveBreakpoint);
  useEffect(() => {
    onHoverPointRef.current = onHoverPoint;
    onAddBreakpointRef.current = onAddBreakpoint;
    onRemoveBreakpointRef.current = onRemoveBreakpoint;
  }, [onHoverPoint, onAddBreakpoint, onRemoveBreakpoint]);

  // Serie completa: distanza in km, elevazione/gradiente SMUSSATI (solo per la resa
  // grafica — le statistiche altrove nell'app restano sempre sul dato grezzo).
  const fullData = useMemo<ChartDatum[]>(() => {
    if (points.length < 2) return [];
    const distances = points.map(p => p.dist);
    const eleSmooth = smoothByDistance(
      points.map(p => p.ele),
      distances,
      smoothingRadiusMeters
    );
    const gradSmooth = smoothByDistance(
      points.map(p => p.gradient),
      distances,
      smoothingRadiusMeters
    );
    return points.map((p, i) => ({
      dist: p.dist / 1000,
      ele: eleSmooth[i]!,
      gradient: gradSmooth[i]!,
      lat: p.lat,
      lon: p.lon
    }));
  }, [points, smoothingRadiusMeters]);

  // Massimo assoluto della componente di vento efficace sull'INTERO percorso (non solo la
  // porzione zoomata): tiene la scala colore/opacità della fascia vento stabile quando si
  // zooma, altrimenti "rosso pieno" cambierebbe significato ad ogni zoom-in.
  const windMaxAbs = useMemo(() => {
    if (windZones.length < 2 || points.length < 2) return 0;
    const totalKm = points[points.length - 1]!.dist / 1000;
    if (totalKm <= 0) return 0;
    let max = 0;
    const coarseSamples = 150;
    for (let i = 0; i <= coarseSamples; i++) {
      const km = (totalKm * i) / coarseSamples;
      const wind = windAtDistKm(windZones, km);
      if (!wind) continue;
      const bearing = routeBearingAtDistKm(points, km);
      max = Math.max(max, Math.abs(effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing)));
    }
    return Math.max(max, 3);
  }, [points, windZones]);

  // Reset dello zoom quando cambia il percorso (non quando cambia solo lo smoothing:
  // in quel caso ha senso restare sulla stessa porzione che si stava guardando).
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

    // Scala Y identica al prototipo originale: un forte padding verticale (300m sopra,
    // fino a 80m sotto) fa sì che il profilo non risulti esageratamente "drammatico" —
    // è una scelta estetica deliberata dell'originale, non un dettaglio arbitrario.
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

    const svg = d3
      .select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${TOTAL_W} ${TOTAL_H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('width', '100%')
      .style('height', 'auto')
      .style('display', 'block');

    svg.append('defs').append('clipPath').attr('id', 'elev-clip').append('rect').attr('width', W).attr('height', H);

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

    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6).tickSize(-W).tickFormat(() => ''))
      .selectAll('line')
      .style('stroke', '#e5e7eb')
      .style('stroke-dasharray', '3,3');
    g.selectAll('.domain').style('stroke', '#d1d5db');

    // ── Fascia vento (testa/coda), allineata pixel-per-pixel con xScale: prima viveva in
    // un componente separato (WindRibbon) sopra il grafico, a piena larghezza del suo
    // contenitore — quindi FUORI SCALA rispetto ai margini dell'SVG sottostante e cieca
    // allo zoom (mostrava sempre l'intero percorso anche col grafico zoomato su un tratto).
    // Disegnandola qui, nello stesso <g> e con la stessa xScale(d0,d1), il colore sotto un
    // punto del profilo corrisponde SEMPRE esattamente a quel punto, zoom incluso.
    if (windZones.length >= 2 && windMaxAbs > 0) {
      const bandH = 7;
      const bandY = -bandH - 5;
      const bandSamples = 110;
      const windG = g.append('g').attr('class', 'wind-band');
      const stepKm = (d1 - d0) / bandSamples;
      for (let i = 0; i < bandSamples; i++) {
        const kmStart = d0 + i * stepKm;
        const kmMid = kmStart + stepKm / 2;
        const wind = windAtDistKm(windZones, kmMid);
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

    // Area + linea colorate per pendenza: un segmento per ogni coppia di punti visualizzati
    // (già ridotti con LTTB quando il percorso è molto lungo — non migliaia di elementi grezzi).
    const chartG = g.append('g').attr('clip-path', 'url(#elev-clip)');
    for (let i = 1; i < displayData.length; i++) {
      const p1 = displayData[i - 1]!;
      const p2 = displayData[i]!;
      if (p2.dist < d0 || p1.dist > d1) continue;
      const color = getGradientColor(p2.gradient);
      const x1 = xScale(p1.dist);
      const x2 = xScale(p2.dist);
      const y1 = yScale(p1.ele);
      const y2 = yScale(p2.ele);
      chartG
        .append('path')
        .attr('d', `M${x1},${y1} L${x2},${y2} L${x2},${H} L${x1},${H} Z`)
        .attr('fill', color)
        .attr('opacity', 0.65);
      chartG
        .append('line')
        .attr('x1', x1)
        .attr('y1', y1)
        .attr('x2', x2)
        .attr('y2', y2)
        .attr('stroke', color)
        .attr('stroke-width', 1.5);
    }

    if (isZoomed) {
      const hint = document.createElement('div');
      hint.textContent = 'Doppio clic per reset zoom';
      hint.style.cssText =
        'position:absolute;top:6px;right:8px;font-size:10px;color:#9ca3af;font-family:JetBrains Mono,monospace;pointer-events:none;';
      container.style.position = 'relative';
      container.appendChild(hint);
    }

    // ── Marker delle sezioni (breakpoint) ──
    const bpG = chartG.append('g');
    const markerY = 18;
    breakpoints.forEach((bp, i) => {
      if (bp.distKm < d0 || bp.distKm > d1) return;
      const x = xScale(bp.distKm);
      const color = bp.fixed === 'start' ? '#22c55e' : bp.fixed === 'finish' ? '#fc5200' : '#3b82f6';
      const grp = bpG.append('g').attr('transform', `translate(${x},0)`);
      grp
        .append('line')
        .attr('y1', 0)
        .attr('y2', H)
        .attr('stroke', color)
        .attr('stroke-dasharray', '4,3')
        .attr('stroke-width', 1.3)
        .attr('opacity', 0.8);
      grp
        .append('circle')
        .attr('cy', markerY)
        .attr('r', 8)
        .attr('fill', color)
        .attr('stroke', '#fff')
        .attr('stroke-width', 2)
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

    // ── Card riassuntive per sezione (indice, distanza, tempo, potenza, velocità) ──
    const segG = chartG.append('g');
    const segLabelY = 46;
    for (const s of sections) {
      if (s.to.distKm <= d0 || s.from.distKm >= d1) continue;
      const segFrom = Math.max(s.from.distKm, d0);
      const segTo = Math.min(s.to.distKm, d1);
      const xMid = (xScale(segFrom) + xScale(segTo)) / 2;
      if (xScale(segTo) - xScale(segFrom) < 46) continue;
      const lg = segG.append('g').attr('transform', `translate(${xMid},${segLabelY})`);
      lg.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 0)
        .attr('font-size', '12px')
        .attr('font-weight', '800')
        .style('fill', '#475569')
        .style('pointer-events', 'none')
        .text(s.index);
      lg.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 12)
        .attr('font-size', '9.5px')
        .attr('font-weight', '600')
        .style('fill', '#94a3b8')
        .style('pointer-events', 'none')
        .text(`${s.distanceKm.toFixed(1)} km`);
      lg.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 23)
        .attr('font-size', '9.5px')
        .attr('font-weight', '600')
        .style('fill', '#94a3b8')
        .style('pointer-events', 'none')
        .text(formatTime(s.timeHours));
      lg.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 34)
        .attr('font-size', '9.5px')
        .attr('font-weight', '600')
        .style('fill', '#94a3b8')
        .style('pointer-events', 'none')
        .text(`${Math.round(s.powerWatts)} W`);
      lg.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 45)
        .attr('font-size', '9.5px')
        .attr('font-weight', '600')
        .style('fill', '#94a3b8')
        .style('pointer-events', 'none')
        .text(`${s.speedKmh.toFixed(1)} km/h`);
      const bbox = (lg.node() as SVGGElement).getBBox();
      lg.insert('rect', 'text')
        .attr('x', bbox.x - 6)
        .attr('y', bbox.y - 3)
        .attr('width', bbox.width + 12)
        .attr('height', bbox.height + 6)
        .attr('rx', 7)
        .attr('fill', '#ffffff')
        .attr('fill-opacity', 0.82)
        .attr('stroke', '#e5e7eb')
        .attr('stroke-width', 1);
    }

    // ── Hover ──
    let tooltip = document.getElementById('elev-hover-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'elev-hover-tooltip';
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
      .attr('opacity', 0);
    const hoverDot = g.append('circle').attr('r', 5).attr('fill', '#fc5200').attr('stroke', '#fff').attr('stroke-width', 2).attr('opacity', 0);

    const bisectDist = d3.bisector<ChartDatum, number>(d => d.dist).left;

    function updateHover(clientX: number, clientY: number, svgX: number) {
      const dist = xScale.invert(svgX);
      const idx = bisectDist(fullData, dist);
      const a = fullData[Math.max(0, idx - 1)];
      const b = fullData[Math.min(fullData.length - 1, idx)];
      if (!a || !b) return;
      const point = Math.abs(a.dist - dist) < Math.abs(b.dist - dist) ? a : b;
      if (point.dist < d0 || point.dist > d1) return;

      const cx = xScale(point.dist);
      const cy = yScale(point.ele);
      hoverLine.attr('x1', cx).attr('x2', cx).attr('opacity', 0.7);
      hoverDot.attr('cx', cx).attr('cy', cy).attr('opacity', 1);

      const color = getGradientColor(point.gradient);
      const sign = point.gradient > 0.05 ? '+' : '';
      tooltip!.innerHTML =
        `↑ <b>${point.ele.toFixed(0)} m</b> &nbsp;·&nbsp; ${point.dist.toFixed(2)} km` +
        `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${color};color:#fff;font-size:11px;font-weight:700;margin-left:6px;">${sign}${point.gradient.toFixed(1)}%</span>`;
      tooltip!.style.display = 'block';
      let tx = clientX + 16;
      let ty = clientY - 38;
      if (tx + 200 > window.innerWidth) tx = clientX - 210;
      if (ty < 0) ty = clientY + 12;
      tooltip!.style.left = `${tx}px`;
      tooltip!.style.top = `${ty}px`;

      onHoverPointRef.current?.({ lat: point.lat, lon: point.lon, ele: point.ele, distKm: point.dist, gradient: point.gradient });
    }

    function clearHover() {
      hoverLine.attr('opacity', 0);
      hoverDot.attr('opacity', 0);
      tooltip!.style.display = 'none';
      onHoverPointRef.current?.(null);
    }

    // ── Brush: drag = zoom (+ statistiche live della selezione), doppio clic = reset ──
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
    // onHoverPoint/onAddBreakpoint/onRemoveBreakpoint sono letti via ref apposta (vedi sopra):
    // includerli qui farebbe ricostruire l'intero grafico ad ogni hover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullData, zoomDomain, breakpoints, sections, addMode, points, windZones, windMaxAbs]);

  if (points.length < 2) return null;

  return (
    <>
      <div className="gradient-legend">
        <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap', width: '100%', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '1.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {selectionStats ? (
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
            ) : (
              <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>Trascina sul grafico per selezionare una sezione</span>
            )}
          </div>
          <SmoothingControl radiusMeters={smoothingRadiusMeters} onChange={onSmoothingChange} />
        </div>
      </div>
      <div ref={containerRef} className="elevation-chart" />
      {windZones.length >= 2 && (
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
