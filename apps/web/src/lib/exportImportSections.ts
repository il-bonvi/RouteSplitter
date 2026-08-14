import type { Breakpoint, CalcMode, SectionPlan } from '@shared-schema';

export interface SectionsExportPayload {
  type: 'routesplitter-sections';
  version: 1;
  exportedAt: string;
  routeName: string;
  routeDistanceKm: number;
  defaultSpeed: number;
  points: Array<{ distKm: number; fixed: Breakpoint['fixed']; sectionLabel: string | null; speed: number | null; power: number | null }>;
  calcMode: CalcMode;
}

/** Stesso formato del prototipo originale (chiavi `speed`/`power`, non `speedKmh`/`powerWatts`). */
export function buildSectionsExportPayload(routeName: string, routeDistanceKm: number, plan: SectionPlan): SectionsExportPayload {
  return {
    type: 'routesplitter-sections',
    version: 1,
    exportedAt: new Date().toISOString(),
    routeName,
    routeDistanceKm,
    defaultSpeed: plan.defaultSpeedKmh,
    points: plan.breakpoints.map(p => ({
      distKm: p.distKm,
      fixed: p.fixed,
      sectionLabel: p.sectionLabel,
      speed: p.speedKmh,
      power: p.powerWatts
    })),
    calcMode: plan.calcMode
  };
}

export interface ParsedSectionsImport {
  breakpoints: Breakpoint[];
  calcMode: CalcMode | null;
  defaultSpeedKmh: number | null;
  routeName: string | null;
  routeDistanceKm: number | null;
}

/**
 * Legge un file esportato da questa app (o dal prototipo originale, stesso formato).
 * Garantisce sempre un punto 'start' a 0 km e un 'finish' alla fine del percorso
 * corrente, clampando eventuali punti fuori range — stessa logica del prototipo.
 */
export function parseSectionsImport(jsonText: string, currentDistanceKm: number, fallbackDefaultSpeed: number): ParsedSectionsImport {
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error('File non valido: non è un JSON leggibile.');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('File non valido: struttura sezioni mancante o incompleta.');
  }
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.points) || p.points.length < 2) {
    throw new Error('File non valido: struttura sezioni mancante o incompleta.');
  }

  const defaultSpeed = typeof p.defaultSpeed === 'number' ? p.defaultSpeed : fallbackDefaultSpeed;
  const rawPoints = p.points as Array<Record<string, unknown>>;

  const imported: Breakpoint[] = rawPoints
    .map((raw, i) => {
      const distKm = Math.min(Math.max(0, Number(raw.distKm) || 0), currentDistanceKm);
      const fixedRaw = raw.fixed;
      const fixed: Breakpoint['fixed'] = fixedRaw === 'start' || fixedRaw === 'finish' ? fixedRaw : false;
      const sectionLabel = raw.sectionLabel != null ? String(raw.sectionLabel) : 'Sezione';
      const speedVal = Number(raw.speed);
      const speedKmh = raw.speed != null && Number.isFinite(speedVal) ? speedVal : defaultSpeed;
      const powerVal = Number(raw.power);
      const powerWatts = raw.power != null && Number.isFinite(powerVal) ? powerVal : 250;
      return {
        id: `bp-import-${i}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        distKm,
        fixed,
        sectionLabel,
        speedKmh,
        powerWatts
      };
    })
    .sort((a, b) => a.distKm - b.distKm);

  if (imported.length === 0 || imported[0]!.fixed !== 'start') {
    imported.unshift({
      id: `bp-import-start-${Date.now().toString(36)}`,
      distKm: 0,
      fixed: 'start',
      sectionLabel: null,
      speedKmh: null,
      powerWatts: null
    });
  } else {
    imported[0]!.distKm = 0;
    imported[0]!.sectionLabel = null;
    imported[0]!.speedKmh = null;
  }

  const lastIdx = imported.length - 1;
  if (imported[lastIdx]!.fixed !== 'finish') {
    imported.push({
      id: `bp-import-finish-${Date.now().toString(36)}`,
      distKm: currentDistanceKm,
      fixed: 'finish',
      sectionLabel: imported[lastIdx]!.sectionLabel || 'Sezione',
      speedKmh: imported[lastIdx]!.speedKmh ?? defaultSpeed,
      powerWatts: imported[lastIdx]!.powerWatts ?? 250
    });
  } else {
    imported[lastIdx]!.distKm = currentDistanceKm;
  }

  return {
    breakpoints: imported,
    calcMode: p.calcMode === 'power' || p.calcMode === 'speed' ? (p.calcMode as CalcMode) : null,
    defaultSpeedKmh: typeof p.defaultSpeed === 'number' ? p.defaultSpeed : null,
    routeName: typeof p.routeName === 'string' && p.routeName.trim() ? p.routeName.trim() : null,
    routeDistanceKm: typeof p.routeDistanceKm === 'number' ? p.routeDistanceKm : null
  };
}
