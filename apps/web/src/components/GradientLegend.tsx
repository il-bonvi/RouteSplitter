import { useMemo } from 'react';
import { getGradientColor } from '../lib/gradientColor.js';

const SAMPLE_GRADES = [-15, -10, -5, 0, 5, 8, 11, 15, 20];

export function GradientLegend() {
  const gradientCss = useMemo(() => {
    const stops = SAMPLE_GRADES.map((g, i) => {
      const pct = (i / (SAMPLE_GRADES.length - 1)) * 100;
      return `${getGradientColor(g)} ${pct}%`;
    });
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }, []);

  return (
    <div className="gradient-legend" aria-hidden="true">
      <span className="gradient-legend-label">−15%</span>
      <span className="gradient-legend-bar" style={{ background: gradientCss }} />
      <span className="gradient-legend-label">+20%</span>
    </div>
  );
}
