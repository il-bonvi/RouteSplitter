import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { smoothByDistance, type ProcessedPoint, type SectionBreakpoint } from '@physics-core';
import { getGradientColor } from '../lib/gradientColor.js';

interface ReportElevationChartProps {
  points: ProcessedPoint[];
  smoothingRadiusMeters: number;
  breakpoints: SectionBreakpoint[];
}

interface ChartDatum {
  dist: number;
  ele: number;
  gradient: number;
}

const MARGIN = { top: 14, right: 20, bottom: 30, left: 46 };
const TOTAL_W = 700;
const TOTAL_H = 230;
const W = TOTAL_W - MARGIN.left - MARGIN.right;
const H = TOTAL_H - MARGIN.top - MARGIN.bottom;

export function ReportElevationChart({ points, smoothingRadiusMeters, breakpoints }: ReportElevationChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || points.length < 2) return;
    container.innerHTML = '';

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
    const data: ChartDatum[] = points.map((p, i) => ({ dist: p.dist / 1000, ele: eleSmooth[i]!, gradient: gradSmooth[i]! }));
    const displayData = data.length > 1800 ? d3.range(0, data.length, Math.ceil(data.length / 1800)).map(i => data[i]!) : data;

    const maxDist = data[data.length - 1]!.dist;
    const xScale = d3.scaleLinear().domain([0, maxDist]).range([0, W]);

    const minEle = Math.min(...data.map(d => d.ele));
    const maxEle = Math.max(...data.map(d => d.ele));
    const elevationGain = maxEle - minEle;
    const paddingTop = 200;
    const paddingBottom = minEle >= 100 ? 60 : Math.max(0, minEle * 0.5);
    const rangeYBase = Math.max(elevationGain * 1.5, elevationGain + 200);
    const roundTo = 50;
    const yMin = Math.floor((minEle - paddingBottom) / roundTo) * roundTo;
    const yMaxRaw = Math.ceil((yMin + rangeYBase + paddingBottom + paddingTop) / roundTo) * roundTo;
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

    const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    g.append('g')
      .attr('transform', `translate(0,${H})`)
      .call(d3.axisBottom(xScale).ticks(6).tickFormat(d => `${(d as number).toFixed(1)} km`))
      .selectAll('text')
      .style('font-size', '9px')
      .style('fill', '#6b7280');
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(5).tickFormat(d => `${d} m`))
      .selectAll('text')
      .style('font-size', '9px')
      .style('fill', '#6b7280');
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(5).tickSize(-W).tickFormat(() => ''))
      .selectAll('line')
      .style('stroke', '#e5e7eb')
      .style('stroke-dasharray', '3,3');
    g.selectAll('.domain').style('stroke', '#d1d5db');

    const chartG = g.append('g');
    for (let i = 1; i < displayData.length; i++) {
      const p1 = displayData[i - 1]!;
      const p2 = displayData[i]!;
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
      chartG.append('line').attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2).attr('stroke', color).attr('stroke-width', 1.3);
    }

    const bpG = chartG.append('g');
    breakpoints.forEach((bp, i) => {
      const x = xScale(bp.distKm);
      const color = bp.fixed === 'start' ? '#22c55e' : bp.fixed === 'finish' ? '#fc5200' : '#3b82f6';
      const grp = bpG.append('g').attr('transform', `translate(${x},0)`);
      grp.append('line').attr('y1', 0).attr('y2', H).attr('stroke', color).attr('stroke-dasharray', '3,2').attr('stroke-width', 1).attr('opacity', 0.8);
      grp.append('circle').attr('cy', 14).attr('r', 7).attr('fill', color).attr('stroke', '#fff').attr('stroke-width', 1.5);
      grp
        .append('text')
        .attr('y', 17)
        .attr('text-anchor', 'middle')
        .attr('font-size', '8px')
        .attr('font-weight', '700')
        .style('fill', '#fff')
        .text(i + 1);
    });
  }, [points, smoothingRadiusMeters, breakpoints]);

  return <div ref={containerRef} className="report-elevation-chart" />;
}
