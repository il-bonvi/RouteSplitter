import { useMemo } from 'react';
import type { ProcessedPoint } from '@physics-core';
import { effectiveHeadwindKmh, routeBearingAtDistKm, windAtDistKm } from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';
import { headwindColor } from '../lib/windDisplay.js';

interface WindRibbonProps {
  points: ProcessedPoint[];
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
}

const SAMPLES = 180;

export function WindRibbon({ points, windZones, totalDistanceKm }: WindRibbonProps) {
  const samples = useMemo(() => {
    if (windZones.length < 2 || totalDistanceKm <= 0 || points.length < 2) return null;
    const out: { km: number; headwindKmh: number }[] = [];
    let maxAbs = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const km = (totalDistanceKm * i) / SAMPLES;
      const wind = windAtDistKm(windZones, km);
      if (!wind) {
        out.push({ km, headwindKmh: 0 });
        continue;
      }
      const bearing = routeBearingAtDistKm(points, km);
      const headwindKmh = effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing);
      maxAbs = Math.max(maxAbs, Math.abs(headwindKmh));
      out.push({ km, headwindKmh });
    }
    return { out, maxAbs: Math.max(maxAbs, 3) };
  }, [points, windZones, totalDistanceKm]);

  if (!samples) return null;

  return (
    <div className="wind-ribbon">
      <div className="wind-ribbon-bar">
        {samples.out.map((s, i) => (
          <div
            key={i}
            className="wind-ribbon-cell"
            style={{ background: headwindColor(s.headwindKmh, samples.maxAbs) }}
            title={`${s.km.toFixed(1)} km · ${s.headwindKmh >= 0 ? '+' : ''}${s.headwindKmh.toFixed(1)} km/h ${s.headwindKmh >= 0.5 ? '(testa)' : s.headwindKmh <= -0.5 ? '(coda)' : '(traverso)'}`}
          />
        ))}
      </div>
      <div className="wind-ribbon-legend">
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
    </div>
  );
}
