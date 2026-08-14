interface SmoothingControlProps {
  radiusMeters: number;
  onChange: (radiusMeters: number) => void;
}

export function SmoothingControl({ radiusMeters, onChange }: SmoothingControlProps) {
  return (
    <label className="smoothing-control">
      <span>Smoothing (solo grafico):</span>
      <input
        type="range"
        min={0}
        max={120}
        step={10}
        value={radiusMeters}
        onChange={e => onChange(Number(e.target.value))}
        onWheel={e => {
          const delta = e.deltaY < 0 ? 10 : -10;
          onChange(Math.max(0, Math.min(120, radiusMeters + delta)));
        }}
      />
      <span className="smoothing-value">{radiusMeters} m</span>
    </label>
  );
}
