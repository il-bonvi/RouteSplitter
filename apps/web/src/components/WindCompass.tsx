import { useCallback, useRef } from 'react';

interface WindCompassProps {
  /** Direzione DA cui soffia il vento, gradi bussola [0,360). */
  directionDeg: number;
  onChange: (directionDeg: number) => void;
  size?: number;
}

const CARDINALS: Array<{ label: string; deg: number }> = [
  { label: 'N', deg: 0 },
  { label: 'E', deg: 90 },
  { label: 'S', deg: 180 },
  { label: 'O', deg: 270 }
];

function angleFromPointer(cx: number, cy: number, px: number, py: number): number {
  const dx = px - cx;
  const dy = py - cy;
  const rad = Math.atan2(dx, -dy);
  return ((rad * 180) / Math.PI + 360) % 360;
}

export function WindCompass({ directionDeg, onChange, size = 96 }: WindCompassProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);
  const center = size / 2;
  const radius = size / 2 - 10;

  // L'utente trascina la freccia nella direzione in cui il vento SOFFIA (più intuitivo,
  // "spingi da questa parte"); internamente si salva la direzione DA cui viene (convenzione
  // meteo, +180°), usata per il calcolo fisico in physics-core/wind.ts.
  const blowingToDeg = (directionDeg + 180) % 360;

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const blowingTo = angleFromPointer(cx, cy, clientX, clientY);
      const from = (blowingTo + 180) % 360;
      onChange(Math.round(from));
    },
    [onChange]
  );

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    updateFromPointer(e.clientX, e.clientY);
  };
  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    updateFromPointer(e.clientX, e.clientY);
  };
  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const arrowRad = (blowingToDeg * Math.PI) / 180;
  const tipX = center + Math.sin(arrowRad) * radius;
  const tipY = center - Math.cos(arrowRad) * radius;
  const tailX = center - Math.sin(arrowRad) * radius * 0.55;
  const tailY = center + Math.cos(arrowRad) * radius * 0.55;

  return (
    <svg
      ref={svgRef}
      className="wind-compass"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role="slider"
      aria-label="Direzione del vento"
      aria-valuenow={Math.round(directionDeg)}
      aria-valuemin={0}
      aria-valuemax={359}
    >
      <circle cx={center} cy={center} r={radius} className="wind-compass-ring" />
      {CARDINALS.map(c => {
        const rad = (c.deg * Math.PI) / 180;
        const lx = center + Math.sin(rad) * (radius + 9);
        const ly = center - Math.cos(rad) * (radius + 9);
        return (
          <text key={c.label} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className="wind-compass-label">
            {c.label}
          </text>
        );
      })}
      <line x1={tailX} y1={tailY} x2={tipX} y2={tipY} className="wind-compass-arrow" />
      <polygon
        points={`0,-7 16,0 0,7`}
        transform={`translate(${tipX},${tipY}) rotate(${blowingToDeg})`}
        className="wind-compass-arrowhead"
      />
      <circle cx={center} cy={center} r={4} className="wind-compass-hub" />
    </svg>
  );
}
