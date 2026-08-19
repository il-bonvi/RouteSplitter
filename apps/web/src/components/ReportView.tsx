import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProcessedPoint, SectionBreakpoint, SectionResult } from '@physics-core';
import type { Route } from '@shared-schema';
import { buildStaticMapImage } from '../lib/staticMapImage.js';
import { formatTime } from '../lib/formatTime.js';
import { getGradientColor } from '../lib/gradientColor.js';
import { ReportElevationChart } from './ReportElevationChart.js';

interface ReportViewProps {
  route: Route;
  sections: SectionResult[];
  points: ProcessedPoint[];
  breakpoints: SectionBreakpoint[];
  smoothingRadiusMeters: number;
  startTime: string;
  exporting: boolean;
  onDonePrinting: () => void;
}

function gradeText(gradient: number) {
  const color = getGradientColor(gradient);
  const sign = gradient >= 0 ? '+' : '';
  return (
    <span style={{ color, fontWeight: 700 }}>
      {sign}
      {gradient.toFixed(1)}%
    </span>
  );
}

function windText(headwindKmh: number) {
  if (Math.abs(headwindKmh) < 0.5) return <span style={{ color: '#9ca3af' }}>—</span>;
  const isHeadwind = headwindKmh > 0;
  return (
    <span style={{ color: isHeadwind ? '#ef4444' : '#22c55e', fontWeight: 700 }}>
      {isHeadwind ? '↑' : '↓'} {Math.abs(headwindKmh).toFixed(1)}
    </span>
  );
}

function clockTimeAfter(startTime: string, hoursFromStart: number): string | null {
  if (!startTime) return null;
  const [sh, sm] = startTime.split(':').map(Number);
  if (sh == null || sm == null) return null;
  const totalMin = sh * 60 + sm + Math.round(hoursFromStart * 60);
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function ReportView({ route, sections, points, breakpoints, smoothingRadiusMeters, startTime, exporting, onDonePrinting }: ReportViewProps) {
  const [mapImage, setMapImage] = useState<string | null>(null);
  const [mapStatus, setMapStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const printedRef = useRef(false);

  useEffect(() => {
    if (!exporting) return;
    printedRef.current = false;
    setMapStatus('loading');
    setMapImage(null);

    let cancelled = false;
    const rect = mapWrapRef.current?.getBoundingClientRect();
    const scale = 3;
    const targetW = Math.round((rect?.width || 668) * scale);
    const targetH = Math.round((rect?.height || 260) * scale);

    buildStaticMapImage({ points, breakpoints, smoothingRadiusMeters, isDark: false, pxWidth: targetW, pxHeight: targetH })
      .then(dataUrl => {
        if (cancelled) return;
        setMapImage(dataUrl);
        setMapStatus(dataUrl ? 'done' : 'error');
        // Doppio rAF: assicura che il browser abbia effettivamente dipinto l'<img>/il grafico
        // prima di invocare print() — altrimenti su alcuni browser la stampa parte con il
        // contenuto ancora bianco (layout appena calcolato ma non ancora renderizzato).
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (cancelled || printedRef.current) return;
            printedRef.current = true;
            // Rimuoviamo la classe "exporting" (position:fixed fuori schermo, usata solo per
            // permettere a canvas/SVG di calcolare le dimensioni prima di stampare) PRIMA di
            // chiamare print(): quella regola non è scoped a @media screen, quindi se restasse
            // applicata durante la stampa il report continuerebbe a trovarsi a -10000px dal
            // bordo pagina → PDF completamente bianco. Rimuoviamo la classe direttamente sul
            // nodo DOM (non via setState) per avere il cambiamento garantito PRIMA di print(),
            // che è sincrono e non aspetta un giro di render React.
            rootRef.current?.classList.remove('exporting');
            window.print();
          });
        });
      })
      .catch(() => {
        if (cancelled) return;
        setMapStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [exporting, points, breakpoints, smoothingRadiusMeters]);

  useEffect(() => {
    const handler = () => {
      if (printedRef.current) onDonePrinting();
    };
    window.addEventListener('afterprint', handler);
    return () => window.removeEventListener('afterprint', handler);
  }, [onDonePrinting]);

  const last = sections[sections.length - 1];
  const totalGain = sections.reduce((s, x) => s + x.gain, 0);
  const totalLoss = sections.reduce((s, x) => s + x.loss, 0);
  const totalTime = last?.cumTimeHours ?? 0;
  const finalAvgSpeed = last?.cumAvgSpeedKmh ?? 0;

  return createPortal(
    <div ref={rootRef} className={`report-view${exporting ? ' exporting' : ''}`}>
      <div className="report-header">
        <div>
          <h1>{route.name}</h1>
        </div>
        <div className="report-date">
          Created {new Date().toLocaleDateString('it-IT')}
          {startTime && (
            <>
              <br />
              Partenza ore {startTime}
            </>
          )}
        </div>
      </div>
      <div className="report-stats">
        <span className="rs-item">
          <span className="rs-label">dist</span>
          <span className="rs-value">{route.distanceKm.toFixed(2)}km</span>
        </span>
        <span className="rs-sep">·</span>
        <span className="rs-item">
          <span className="rs-label">D+</span>
          <span className="rs-value">{Math.round(totalGain)}m</span>
        </span>
        <span className="rs-sep">·</span>
        <span className="rs-item">
          <span className="rs-label">D−</span>
          <span className="rs-value">{Math.round(totalLoss)}m</span>
        </span>
        <span className="rs-sep">·</span>
        <span className="rs-item">
          <span className="rs-label">tempo</span>
          <span className="rs-value">{formatTime(totalTime)}</span>
        </span>
        <span className="rs-sep">·</span>
        <span className="rs-item">
          <span className="rs-label">avg spd</span>
          <span className="rs-value">{finalAvgSpeed.toFixed(1)}km/h</span>
        </span>
      </div>
      <div id="reportMap" ref={mapWrapRef}>
        {mapStatus === 'loading' && <div className="report-map-placeholder">Generazione mappa…</div>}
        {mapStatus === 'error' && <div className="report-map-placeholder">Mappa non disponibile</div>}
        {mapImage && <img src={mapImage} alt="" />}
      </div>
      <div id="reportChart">
        <ReportElevationChart points={points} smoothingRadiusMeters={smoothingRadiusMeters} breakpoints={breakpoints} />
      </div>
      <table className="report-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Sezione</th>
            <th>Da → A</th>
            <th>Distanza</th>
            <th>Pend. media</th>
            <th>Vento</th>
            <th>Dislivello</th>
            <th>VAM</th>
            <th>Vel. media</th>
            <th>Vel. media cum.</th>
            <th>Tempo</th>
            <th>Tempo cum.{startTime ? ' (orario)' : ''}</th>
          </tr>
        </thead>
        <tbody>
          {sections.map(s => {
            const name = s.to.sectionLabel || `S${s.index}`;
            const clock = clockTimeAfter(startTime, s.cumTimeHours);
            return (
              <tr key={s.to.id}>
                <td>{s.index}</td>
                <td className="rt-name">{name}</td>
                <td>
                  {s.from.distKm.toFixed(2)} → {s.to.distKm.toFixed(2)} km
                </td>
                <td>{s.distanceKm.toFixed(2)} km</td>
                <td>{gradeText(s.gradient)}</td>
                <td>{windText(s.windHeadwindKmh)}</td>
                <td>
                  +{Math.round(s.gain)} / −{Math.round(s.loss)} m
                </td>
                <td>{s.timeHours > 0 ? `${s.vam >= 0 ? '+' : ''}${Math.round(s.vam)} m/h` : '—'}</td>
                <td>{s.speedKmh.toFixed(1)} km/h</td>
                <td>{s.cumAvgSpeedKmh.toFixed(1)} km/h</td>
                <td>{formatTime(s.timeHours)}</td>
                <td>
                  {formatTime(s.cumTimeHours)}
                  {clock && <span style={{ color: '#6b7280' }}> ({clock})</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Totale</td>
            <td>{route.distanceKm.toFixed(2)} km</td>
            <td />
            <td />
            <td>
              +{Math.round(totalGain)} / −{Math.round(totalLoss)} m
            </td>
            <td />
            <td />
            <td>{finalAvgSpeed.toFixed(1)} km/h</td>
            <td>{formatTime(totalTime)}</td>
            <td>
              {formatTime(totalTime)}
              {clockTimeAfter(startTime, totalTime) && <span> ({clockTimeAfter(startTime, totalTime)})</span>}
            </td>
          </tr>
        </tfoot>
      </table>
      <div className="report-footer">Generated by RouteSplitter — © 2026 Andrea Bonvicin</div>
    </div>,
    document.body
  );
}
