import { useEffect, useRef } from 'react';

interface SmoothingControlProps {
  radiusMeters: number;
  onChange: (radiusMeters: number) => void;
  /** Testo dell'etichetta — default pensato per l'uso "solo display" (Tab 1, profilo
   * altimetrico del percorso pianificato). Tab 2 passa un testo diverso perché lì lo
   * stesso raggio alimenta anche `estimateTheoreticalPower` (non è più "solo grafico"). */
  label?: string;
}

/**
 * La rotella sul range regola lo smoothing, ma senza `preventDefault` (esplicito, non
 * automatico con un listener React `onWheel`: da React 17 i listener wheel sono passivi di
 * default sul nodo radice, quindi `event.preventDefault()` dentro un `onWheel` React non è
 * garantito che blocchi lo scroll) la pagina scorre insieme allo slider. Serve un listener
 * nativo con `{ passive: false }` via ref.
 *
 * In più: ogni variazione rifà da capo l'intero grafico a valle (nessun update
 * incrementale) — con la rotella che spara molti eventi in rapida sequenza durante uno
 * scroll, aggiornare lo stato ad ogni singolo evento genera più rebuild completi al secondo
 * di quanti il browser possa disegnare, percepiti come scatti. Si accumulano i delta e si
 * applica un solo `onChange` per frame con `requestAnimationFrame`.
 */
export function SmoothingControl({ radiusMeters, onChange, label = 'Smoothing (solo grafico):' }: SmoothingControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const radiusRef = useRef(radiusMeters);
  const rafRef = useRef<number | null>(null);
  radiusRef.current = radiusMeters;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 10 : -10;
      const next = Math.max(0, Math.min(120, radiusRef.current + delta));
      radiusRef.current = next;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => onChange(radiusRef.current));
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [onChange]);

  return (
    <label className="smoothing-control">
      <span>{label}</span>
      <input ref={inputRef} type="range" min={0} max={120} step={10} value={radiusMeters} onChange={e => onChange(Number(e.target.value))} />
      <span className="smoothing-value">{radiusMeters} m</span>
    </label>
  );
}
