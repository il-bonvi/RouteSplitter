import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { getInterpolatedPoint, speedFromPower, type PhysicsParams, type ProcessedPoint } from '@physics-core';
import type { FineSegment } from '../lib/pacingActions.js';
import { formatTime } from '../lib/formatTime.js';

interface PowerPlanModalProps {
  open: boolean;
  onClose: () => void;
  segs: FineSegment[];
  powers: number[];
  physicsParams: PhysicsParams;
  processedPoints: ProcessedPoint[];
}

interface PowerSample {
  tSec: number;
  power: number;
  distKm: number;
  ele: number;
}

const ROLL_OPTIONS = [30, 60, 120, 300, 720, 1200];

function clampRollSec(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1200, Math.max(30, v));
}

/** Serie a ~1s: potenza costante a tratti dalla griglia fine, con distanza/elevazione medie del campione. */
function buildPowerTimeSeries(segs: FineSegment[], powers: number[], params: PhysicsParams, points: ProcessedPoint[]): PowerSample[] {
  const samples: PowerSample[] = [];
  let tSec = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const power = powers[i]!;
    // Se il segmento porta la propria componente di vento (zone vento definite), usarla al
    // posto del params.windKmh scalare — stesso pattern di paramsForSegment in
    // pacingOptimizer.ts/normalizedPower.ts: il grafico previsto deve riflettere lo stesso
    // vento con cui l'ottimizzatore ha calcolato questi watt, altrimenti tempo/velocità
    // mostrati qui non corrisponderebbero al piano appena generato.
    const segParams = seg.windKmh === undefined ? params : { ...params, windKmh: seg.windKmh };
    const v = speedFromPower(power, seg.gradient, segParams) * 3.6;
    const durSec = v > 0.1 ? (seg.distanceKm / v) * 3600 : 0;
    const n = Math.max(1, Math.round(durSec));
    const dt = durSec / n;
    const dd = seg.distanceKm / n;
    for (let k = 0; k < n; k++) {
      const dMid = seg.d0Km + dd * (k + 0.5);
      const ele = getInterpolatedPoint(points, dMid * 1000).ele;
      samples.push({ tSec, power, distKm: dMid, ele });
      tSec += dt;
    }
  }
  return samples;
}

function rollingAvgPower(samples: PowerSample[], windowSec: number): number[] {
  const out = new Array<number>(samples.length);
  let sum = 0;
  let left = 0;
  for (let right = 0; right < samples.length; right++) {
    sum += samples[right]!.power;
    while (left < right && samples[right]!.tSec - samples[left]!.tSec > windowSec) {
      sum -= samples[left]!.power;
      left++;
    }
    out[right] = sum / (right - left + 1);
  }
  return out;
}

export function PowerPlanModal({ open, onClose, segs, powers, physicsParams, processedPoints }: PowerPlanModalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [selectA, setSelectA] = useState(120);
  const [selectB, setSelectB] = useState(300);
  const [customA, setCustomA] = useState('');
  const [customB, setCustomB] = useState('');

  const winA = customA.trim() !== '' && Number.isFinite(parseFloat(customA)) ? clampRollSec(parseFloat(customA), 120) : selectA;
  const winB = customB.trim() !== '' && Number.isFinite(parseFloat(customB)) ? clampRollSec(parseFloat(customB), 300) : selectB;

  const samples = useMemo(
    () => (open ? buildPowerTimeSeries(segs, powers, physicsParams, processedPoints) : []),
    [open, segs, powers, physicsParams, processedPoints]
  );

  const [stats, setStats] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (!host || samples.length === 0) return;
    host.innerHTML = '';

    const rollA = rollingAvgPower(samples, winA);
    const rollB = rollingAvgPower(samples, winB);

    const W = host.clientWidth || 1000;
    const H = 420;
    const margin = { top: 24, right: 56, bottom: 40, left: 52 };
    const width = W - margin.left - margin.right;
    const height = H - margin.top - margin.bottom;

    const svg = d3.select(host).append('svg').attr('width', W).attr('height', H);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, d3.max(samples, d => d.distKm) ?? 0]).range([0, width]);
    const yEle = d3
      .scaleLinear()
      .domain([(d3.min(samples, d => d.ele) ?? 0) - 5, (d3.max(samples, d => d.ele) ?? 0) + 5])
      .nice()
      .range([height, 0]);
    const maxPow = Math.max(
      50,
      (d3.max(samples, d => d.power) ?? 0) * 1.15,
      (d3.max(rollA) ?? 0) * 1.15,
      (d3.max(rollB) ?? 0) * 1.15
    );
    const yPow = d3.scaleLinear().domain([0, maxPow]).nice().range([height, 0]);

    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(10).tickSize(-height).tickFormat(() => ''))
      .selectAll('line')
      .attr('stroke', '#e2e8f0');
    g.append('g')
      .call(d3.axisLeft(yEle).ticks(6).tickSize(-width).tickFormat(() => ''))
      .selectAll('line')
      .attr('stroke', '#e2e8f0');

    const area = d3
      .area<PowerSample>()
      .x(d => x(d.distKm))
      .y0(height)
      .y1(d => yEle(d.ele))
      .curve(d3.curveMonotoneX);
    g.append('path').datum(samples).attr('fill', 'rgba(148,163,184,0.25)').attr('d', area);
    g.append('path')
      .datum(samples)
      .attr('fill', 'none')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1.5)
      .attr(
        'd',
        d3
          .line<PowerSample>()
          .x(d => x(d.distKm))
          .y(d => yEle(d.ele))
          .curve(d3.curveMonotoneX)
      );

    g.append('path')
      .datum(samples)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 1.2)
      .attr('opacity', 0.75)
      .attr(
        'd',
        d3
          .line<PowerSample>()
          .x(d => x(d.distKm))
          .y(d => yPow(d.power))
          .curve(d3.curveStepAfter)
      );

    const rollDataA = samples.map((d, i) => ({ distKm: d.distKm, p: rollA[i]! }));
    const rollDataB = samples.map((d, i) => ({ distKm: d.distKm, p: rollB[i]! }));
    g.append('path')
      .datum(rollDataA)
      .attr('fill', 'none')
      .attr('stroke', '#a646e6')
      .attr('stroke-width', 2.5)
      .attr(
        'd',
        d3
          .line<{ distKm: number; p: number }>()
          .x(d => x(d.distKm))
          .y(d => yPow(d.p))
          .curve(d3.curveMonotoneX)
      );
    g.append('path')
      .datum(rollDataB)
      .attr('fill', 'none')
      .attr('stroke', '#00e5ff')
      .attr('stroke-width', 2.5)
      .attr(
        'd',
        d3
          .line<{ distKm: number; p: number }>()
          .x(d => x(d.distKm))
          .y(d => yPow(d.p))
          .curve(d3.curveMonotoneX)
      );

    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(10).tickFormat(d => `${(d as number).toFixed(1)} km`))
      .selectAll('text')
      .attr('fill', '#64748b');
    g.append('g')
      .call(d3.axisLeft(yEle).ticks(6).tickFormat(d => `${Math.round(d as number)} m`))
      .selectAll('text')
      .attr('fill', '#64748b');
    g.append('g')
      .attr('transform', `translate(${width},0)`)
      .call(d3.axisRight(yPow).ticks(6).tickFormat(d => `${Math.round(d as number)} W`))
      .selectAll('text')
      .attr('fill', '#a646e6');

    const focus = g.append('g').style('display', 'none');
    focus.append('line').attr('y1', 0).attr('y2', height).attr('stroke', '#64748b').attr('stroke-dasharray', '4,4');
    const fRollA = focus.append('circle').attr('r', 4).attr('fill', '#a646e6');
    const fRollB = focus.append('circle').attr('r', 4).attr('fill', '#00e5ff');
    const fPow = focus.append('circle').attr('r', 3).attr('fill', '#f59e0b');

    const tip = d3
      .select(host)
      .append('div')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('display', 'none')
      .style('background', 'rgba(15,15,15,0.92)')
      .style('color', '#fff')
      .style('padding', '6px 10px')
      .style('border-radius', '6px')
      .style('font-size', '12px')
      .style('font-family', 'Inter,sans-serif');

    host.style.position = 'relative';
    svg
      .append('rect')
      .attr('transform', `translate(${margin.left},${margin.top})`)
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .on('mouseenter', () => {
        focus.style('display', null);
        tip.style('display', 'block');
      })
      .on('mouseleave', () => {
        focus.style('display', 'none');
        tip.style('display', 'none');
      })
      .on('mousemove', function (event) {
        const [mx] = d3.pointer(event, this);
        const dist = x.invert(mx);
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < samples.length; i++) {
          const dd = Math.abs(samples[i]!.distKm - dist);
          if (dd < bestD) {
            bestD = dd;
            best = i;
          }
        }
        const s = samples[best]!;
        focus.attr('transform', `translate(${x(s.distKm)},0)`);
        fRollA.attr('cy', yPow(rollA[best]!));
        fRollB.attr('cy', yPow(rollB[best]!));
        fPow.attr('cy', yPow(s.power));
        tip
          .style('left', `${margin.left + x(s.distKm) + 12}px`)
          .style('top', '20px')
          .html(
            `<strong>${s.distKm.toFixed(2)} km</strong> · ${Math.round(s.ele)} m · t=${formatTime(s.tSec / 3600)}<br>` +
              `Potenza: <strong>${Math.round(s.power)} W</strong><br>` +
              `Media ${winA}s: <strong>${Math.round(rollA[best]!)} W</strong><br>` +
              `Media ${winB}s: <strong>${Math.round(rollB[best]!)} W</strong>`
          );
      });

    const meanA = rollA.reduce((a, b) => a + b, 0) / rollA.length;
    const meanB = rollB.reduce((a, b) => a + b, 0) / rollB.length;
    setStats(
      `A ${winA}s ≈ ${meanA.toFixed(0)} W · B ${winB}s ≈ ${meanB.toFixed(0)} W · durata ${formatTime(samples[samples.length - 1]!.tSec / 3600)}`
    );

    return () => {
      tip.remove();
    };
  }, [open, samples, winA, winB]);

  const exportPng = async () => {
    const host = hostRef.current;
    if (!host) return;
    const svgEl = host.querySelector('svg');
    if (!svgEl) return;

    const svgW = parseInt(svgEl.getAttribute('width') || '0') || host.clientWidth;
    const svgH = parseInt(svgEl.getAttribute('height') || '0') || 420;
    const legH = 56;
    const pad = 16;
    const titleH = 36;
    const canvas = document.createElement('canvas');
    canvas.width = svgW + pad * 2;
    canvas.height = titleH + svgH + legH + pad * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 16px Outfit, Inter, sans-serif';
    ctx.fillText('Piano potenza · altimetria', pad, pad + 18);

    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', '#f8fafc');
    clone.insertBefore(bg, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, pad, pad + titleH, svgW, svgH);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });

    const items = [
      { color: '#94a3b8', label: 'Altimetria' },
      { color: '#f59e0b', label: 'Potenza istantanea' },
      { color: '#a646e6', label: `Media ${winA}s` },
      { color: '#00e5ff', label: `Media ${winB}s` }
    ];
    let lx = pad;
    const ly = pad + titleH + svgH + 22;
    ctx.font = '500 12px Inter, sans-serif';
    for (const it of items) {
      ctx.fillStyle = it.color;
      ctx.fillRect(lx, ly - 6, 18, 3);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(it.label, lx + 24, ly);
      lx += ctx.measureText(it.label).width + 48;
    }
    ctx.fillStyle = '#34d399';
    ctx.font = '500 11px JetBrains Mono, monospace';
    ctx.fillText(stats ?? '', pad, ly + 22);

    canvas.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `power-plan-${winA}s-${winB}s.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  };

  if (!open) return null;

  return (
    <div className="power-modal-overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="power-modal">
        <div className="power-modal-header">
          <h2>📈 Piano potenza · altimetria</h2>
          <div className="power-modal-controls">
            <label>Media A</label>
            <select value={selectA} onChange={e => setSelectA(Number(e.target.value))}>
              {ROLL_OPTIONS.map(v => (
                <option key={v} value={v}>
                  {v} s
                </option>
              ))}
            </select>
            <label>Media B</label>
            <select value={selectB} onChange={e => setSelectB(Number(e.target.value))}>
              {ROLL_OPTIONS.map(v => (
                <option key={v} value={v}>
                  {v} s
                </option>
              ))}
            </select>
            <label>custom A/B (s)</label>
            <input type="number" min={30} max={1200} step={10} placeholder="A" style={{ width: 70 }} value={customA} onChange={e => setCustomA(e.target.value)} />
            <input type="number" min={30} max={1200} step={10} placeholder="B" style={{ width: 70 }} value={customB} onChange={e => setCustomB(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => void exportPng()}>
              ⬇ PNG
            </button>
            <button type="button" className="btn btn-sm ghost" onClick={onClose}>
              Chiudi
            </button>
          </div>
        </div>
        <div id="powerPlanChart" ref={hostRef} />
        <div className="power-modal-legend">
          <span>
            <i style={{ background: '#94a3b8' }} />
            Altimetria
          </span>
          <span>
            <i style={{ background: '#f59e0b' }} />
            Potenza istantanea
          </span>
          <span>
            <i style={{ background: '#a646e6' }} />
            Media {winA}s
          </span>
          <span>
            <i style={{ background: '#00e5ff' }} />
            Media {winB}s
          </span>
          {stats && <span style={{ color: 'var(--accent4)' }}>{stats}</span>}
        </div>
      </div>
    </div>
  );
}
