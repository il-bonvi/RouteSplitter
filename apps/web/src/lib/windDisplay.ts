const CARDINAL_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/** Nome cardinale italiano più vicino per una direzione in gradi bussola [0,360). */
export function cardinalName(directionDeg: number): string {
  const normalized = ((directionDeg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return CARDINAL_NAMES[index]!;
}

/**
 * Colore rosso(testa)/verde(coda)/grigio(traverso) per una componente di vento efficace,
 * normalizzata su maxAbs (tipicamente il massimo assoluto lungo l'intero percorso, così il
 * colore resta comparabile fra la fascia in altimetria, le frecce sulla mappa e i badge
 * tabella). Condiviso fra `ElevationChart`, `WindArrowsLayer` e `SectionsTable`.
 */
export function headwindColor(headwindKmh: number, maxAbs: number): string {
  const t = maxAbs > 0 ? Math.max(-1, Math.min(1, headwindKmh / maxAbs)) : 0;
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

/**
 * Opacità (0..1) proporzionale all'intensità del vento efficace rispetto al massimo del
 * percorso: vento quasi nullo → quasi invisibile, vento massimo → pieno. Un minimo (0.22)
 * evita che le frecce a bassa intensità spariscano del tutto ("soffuse" ma sempre leggibili).
 */
export function headwindOpacity(headwindKmh: number, maxAbs: number): number {
  if (maxAbs <= 0) return 0.35;
  const t = Math.min(1, Math.abs(headwindKmh) / maxAbs);
  return 0.22 + t * 0.68;
}
