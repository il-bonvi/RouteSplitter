import { useMemo } from 'react';
import type { ProcessedPoint } from '@physics-core';
import { effectiveHeadwindKmh, routeBearingAtDistKm, windAtDistKm } from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';

interface WindRibbonProps {
  points: ProcessedPoint[];
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
}

const SAMPLES = 180;

function headwindColor(headwindKmh: number, maxAbs: number): string {
  const t = maxAbs > 0 ? Math.max(-1, Math.min(1, headwindKmh / maxAbs)) : 0;
  // t>0 = testa (rosso), t<0 = coda (verde), 0 = grigio neutro (traverso o vento nullo)
  if (t >= 0) {
    // grigio (#94a3b8) -> rosso (#ef4444)
    const r = Math.round(148 + (239 - 148) * t);
    const g = Math.round(163 + (68 - 163) * t);
    const b = Math.round(184 + (68 - 184) * t);
    return `rgb(${r},${g},${b})`;
  }
  const s = -t;
  // grigio (#94a3b8) -> verde (#22c55e)
  const r = Math.round(148 + (34 - 148) * s);
  const g = Math.round(163 + (197 - 163) * s);
  const b = Math.round(184 + (94 - 184) * s);
  return `rgb(${r},${g},${b})`;
}

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
