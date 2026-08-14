import type { Route } from '@shared-schema';
import type { SectionResult } from '@physics-core';
import { formatTime } from '../lib/formatTime.js';

interface StatsRowProps {
  route: Route;
  sections: SectionResult[];
}

export function StatsRow({ route, sections }: StatsRowProps) {
  const last = sections[sections.length - 1];
  const totalTime = last?.cumTimeHours ?? 0;
  const finalAvgSpeed = last?.cumAvgSpeedKmh ?? 0;

  return (
    <div className="stats-row">
      <div className="stat-card stat-dist">
        <div className="stat-label">Distanza totale</div>
        <div className="stat-value">{route.distanceKm.toFixed(2)} km</div>
      </div>
      <div className="stat-card stat-gain">
        <div className="stat-label">Dislivello +</div>
        <div className="stat-value">{Math.round(route.elevationGain)} m</div>
      </div>
      <div className="stat-card stat-loss">
        <div className="stat-label">Dislivello −</div>
        <div className="stat-value">{Math.round(route.elevationLoss)} m</div>
      </div>
      <div className="stat-card stat-time">
        <div className="stat-label">Tempo previsto</div>
        <div className="stat-value">{formatTime(totalTime)}</div>
      </div>
      <div className="stat-card stat-avgspeed">
        <div className="stat-label">Vel. media finale</div>
        <div className="stat-value">{finalAvgSpeed.toFixed(1)} km/h</div>
      </div>
    </div>
  );
}
