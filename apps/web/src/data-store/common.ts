/** ISO 8601, stesso formato validato da IsoDateTimeSchema in shared-schema. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Genera un id locale. Usa crypto.randomUUID() se disponibile (browser moderni, Node 19+);
 * altrimenti un fallback non crittograficamente robusto ma sufficiente per id locali
 * (nessuna garanzia di unicità globale richiesta finché non esiste un backend condiviso).
 */
export function generateId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
