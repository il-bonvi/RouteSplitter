export function formatTime(hours: number): string {
  if (!isFinite(hours) || hours <= 0) return '—';
  const totalSec = Math.round(hours * 3600);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Come `formatTime`, ma per una DIFFERENZA con segno (es. "reale - pianificato") invece di
 * un tempo assoluto — usata nel confronto pianificato-vs-reale (F3.3). A differenza di
 * `formatTime`, non ritorna mai '—': una differenza di zero è un'informazione valida
 * ("perfettamente in linea col piano"), non un dato mancante. Format in h/m/s come le altre
 * tab, non minuti decimali — una differenza tipica di poche decine di secondi sarebbe
 * illeggibile come "+0.1 min".
 */
export function formatDeltaTime(hours: number): string {
  if (!isFinite(hours)) return '—';
  const totalSec = Math.round(Math.abs(hours) * 3600);
  const sign = hours > 0 ? '+' : hours < 0 ? '−' : '±';
  if (totalSec === 0) return '±0s';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let body: string;
  if (h > 0) body = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  else if (m > 0) body = `${m}m ${String(s).padStart(2, '0')}s`;
  else body = `${s}s`;
  return `${sign}${body}`;
}
