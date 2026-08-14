/**
 * Media mobile su una finestra fisica in metri (non su un numero fisso di punti).
 * I punti GPX non sono equidistanti: una finestra a metri garantisce uno smussamento
 * coerente lungo tutto il percorso, indipendentemente da quanto sono fitti/radi i punti
 * in un dato tratto. `distances` deve essere crescente e allineata per indice a `values`.
 *
 * USO: solo per la resa grafica (profilo altimetria, colore pendenza su mappa/grafico).
 * Non deve mai alimentare D+/D-, VAM o il gradiente usato dall'ottimizzatore — vedi geo.ts.
 *
 * Nota: la LARGHEZZA della finestra è fisica (metri), ma la media al suo interno resta
 * una media aritmetica dei punti presenti — quindi tratti con punti GPX più fitti pesano
 * comunque leggermente di più nel risultato rispetto a tratti più radi nella stessa finestra.
 * Corregge il bias principale (finestra a punti fissi su percorsi non equidistanti) ma non
 * elimina del tutto la sensibilità alla densità locale di campionamento.
 */
export function smoothByDistance(values: number[], distances: number[], radiusMeters: number): number[] {
  const n = values.length;
  if (!(radiusMeters > 0)) return values.slice();
  const smoothed = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const center = distances[i]!;
    while (hi < n && distances[hi]! <= center + radiusMeters) {
      sum += values[hi]!;
      count++;
      hi++;
    }
    while (lo < n && distances[lo]! < center - radiusMeters) {
      sum -= values[lo]!;
      count--;
      lo++;
    }
    smoothed[i] = count > 0 ? sum / count : values[i]!;
  }
  return smoothed;
}

export interface ChartPoint {
  dist: number;
  ele: number;
}

/** Downsampling LTTB (Largest-Triangle-Three-Buckets): riduce i punti preservando la forma visiva del profilo. */
export function lttb<T extends ChartPoint>(data: T[], threshold = 1800): T[] {
  if (threshold >= data.length || threshold <= 2) return data.slice();
  const bucketSize = (data.length - 2) / (threshold - 2);
  const sampled: T[] = [data[0]!];
  for (let i = 0; i < threshold - 2; i++) {
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
    const avgRangeLength = avgRangeEnd - avgRangeStart;
    let avgX = 0;
    let avgY = 0;
    for (let j = avgRangeStart; j < avgRangeEnd && j < data.length; j++) {
      avgX += data[j]!.dist;
      avgY += data[j]!.ele;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    let maxArea = -1;
    let maxAreaPoint = -1;
    const p1 = sampled[sampled.length - 1]!;
    for (let j = rangeStart; j < rangeEnd && j < data.length; j++) {
      const point = data[j]!;
      const area =
        Math.abs((p1.dist - point.dist) * (avgY - p1.ele) - (p1.dist - avgX) * (point.ele - p1.ele)) / 2;
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = j;
      }
    }
    if (maxAreaPoint !== -1) sampled.push(data[maxAreaPoint]!);
  }
  sampled.push(data[data.length - 1]!);
  return sampled;
}
