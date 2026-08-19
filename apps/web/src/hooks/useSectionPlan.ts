import { useCallback, useEffect, useState } from 'react';
import { useDataStore } from '../lib/DataStoreContext.js';
import type { SectionPlan, Breakpoint, CreateSectionPlanInput, WindZoneBoundary } from '@shared-schema';

const MIN_BREAKPOINT_SEP_KM = 0.005; // 5 m
const MIN_WIND_ZONE_SEP_KM = 0.05; // 50 m — zone vento più larghe dei breakpoint di sezione

function makeDefaultBreakpoints(distanceKm: number, defaultSpeedKmh: number, defaultPowerWatts: number): Breakpoint[] {
  return [
    { id: 'start', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
    { id: 'finish', distKm: distanceKm, fixed: 'finish', sectionLabel: 'S1', speedKmh: defaultSpeedKmh, powerWatts: defaultPowerWatts }
  ];
}

function generateBreakpointId(): string {
  return `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateWindZoneId(): string {
  return `wz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Riassegna le etichette "S1", "S2"... alle sezioni senza nome personalizzato, in ordine di distanza. */
function renumberSections(breakpoints: Breakpoint[]): Breakpoint[] {
  let n = 1;
  return breakpoints.map(bp => {
    if (bp.fixed === 'start') return bp;
    const isAutoLabel = bp.sectionLabel == null || /^S\d+$/.test(bp.sectionLabel);
    const label = isAutoLabel ? `S${n}` : bp.sectionLabel;
    n += 1;
    return { ...bp, sectionLabel: label };
  });
}

export function useSectionPlan(routeId: string | null, distanceKm: number) {
  const store = useDataStore();
  const [plan, setPlan] = useState<SectionPlan | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!routeId || distanceKm <= 0) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const existing = await store.sectionPlans.listByRoute(routeId);
      if (cancelled) return;
      if (existing.length > 0) {
        setPlan(existing.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]!);
      } else {
        const created = await store.sectionPlans.create({
          routeId,
          name: 'Piano sezioni',
          calcMode: 'speed',
          defaultSpeedKmh: 40,
          defaultPowerWatts: 250,
          breakpoints: makeDefaultBreakpoints(distanceKm, 40, 250)
        });
        if (!cancelled) setPlan(created);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, distanceKm, store]);

  const save = useCallback(
    async (patch: Partial<CreateSectionPlanInput>) => {
      if (!plan) return;
      const updated = await store.sectionPlans.update(plan.id, patch);
      setPlan(updated);
    },
    [plan, store]
  );

  const addBreakpoint = useCallback(
    async (distKm: number) => {
      if (!plan) return;
      const clamped = Math.max(0, Math.min(distanceKm, distKm));
      const tooClose = plan.breakpoints.some(b => Math.abs(b.distKm - clamped) < MIN_BREAKPOINT_SEP_KM);
      if (tooClose) return;
      const newBp: Breakpoint = {
        id: generateBreakpointId(),
        distKm: clamped,
        fixed: false,
        sectionLabel: 'Sezione',
        speedKmh: plan.defaultSpeedKmh,
        powerWatts: plan.defaultPowerWatts
      };
      const merged = renumberSections([...plan.breakpoints, newBp].sort((a, b) => a.distKm - b.distKm));
      await save({ breakpoints: merged });
    },
    [plan, save, distanceKm]
  );

  const removeBreakpoint = useCallback(
    async (id: string) => {
      if (!plan) return;
      const filtered = plan.breakpoints.filter(b => b.id !== id);
      await save({ breakpoints: renumberSections(filtered) });
    },
    [plan, save]
  );

  /** Aggiunge punti ogni stepKm lungo il percorso, in un solo salvataggio. */
  const addBreakpointsEvery = useCallback(
    async (stepKm: number) => {
      if (!plan || stepKm < 0.05) return;
      const newBreakpoints: Breakpoint[] = [];
      for (let d = stepKm; d < distanceKm - 1e-6; d += stepKm) {
        const rounded = Math.round(d * 1000) / 1000;
        const tooClose =
          plan.breakpoints.some(b => Math.abs(b.distKm - rounded) < 0.01) ||
          newBreakpoints.some(b => Math.abs(b.distKm - rounded) < 0.01);
        if (tooClose) continue;
        newBreakpoints.push({
          id: generateBreakpointId(),
          distKm: rounded,
          fixed: false,
          sectionLabel: 'Sezione',
          speedKmh: plan.defaultSpeedKmh,
          powerWatts: plan.defaultPowerWatts
        });
      }
      if (newBreakpoints.length === 0) return 0;
      const merged = renumberSections([...plan.breakpoints, ...newBreakpoints].sort((a, b) => a.distKm - b.distKm));
      await save({ breakpoints: merged });
      return newBreakpoints.length;
    },
    [plan, save, distanceKm]
  );

  const updateBreakpoint = useCallback(
    async (id: string, patch: Partial<Breakpoint>) => {
      if (!plan) return;
      const updated = plan.breakpoints.map(b => (b.id === id ? { ...b, ...patch } : b));
      await save({ breakpoints: updated });
    },
    [plan, save]
  );

  const setCalcMode = useCallback(
    async (calcMode: 'speed' | 'power') => {
      await save({ calcMode });
    },
    [save]
  );

  const setDefaultSpeedKmh = useCallback(
    async (defaultSpeedKmh: number) => {
      await save({ defaultSpeedKmh });
    },
    [save]
  );

  const setDefaultPowerWatts = useCallback(
    async (defaultPowerWatts: number) => {
      await save({ defaultPowerWatts });
    },
    [save]
  );

  /**
   * Applica più aggiornamenti di potenza in un solo salvataggio (usato dall'ottimizzatore
   * di pacing). Farlo con N chiamate sequenziali a updateBreakpoint rischierebbe di perdersi
   * aggiornamenti a vicenda, perché ognuna catturerebbe uno stato `plan` non ancora
   * sincronizzato con la precedente.
   */
  const applyPowerUpdates = useCallback(
    async (updates: Map<string, number>) => {
      if (!plan) return;
      const updatedBreakpoints = plan.breakpoints.map(b => (updates.has(b.id) ? { ...b, powerWatts: updates.get(b.id)! } : b));
      await save({ breakpoints: updatedBreakpoints, calcMode: 'power' });
    },
    [plan, save]
  );

  const resetBreakpoints = useCallback(async () => {
    if (!plan) return;
    await save({ breakpoints: makeDefaultBreakpoints(distanceKm, plan.defaultSpeedKmh, plan.defaultPowerWatts) });
  }, [plan, save, distanceKm]);

  /** Sostituisce integralmente i breakpoint (usato dall'import JSON delle sezioni). */
  const replaceBreakpoints = useCallback(
    async (breakpoints: Breakpoint[], patch?: Partial<CreateSectionPlanInput>) => {
      if (!plan) return;
      await save({ ...patch, breakpoints });
    },
    [plan, save]
  );

  /**
   * Divide la zona vento che copre distKm in due, inserendo un nuovo confine con lo STESSO
   * vento della zona che sta dividendo (così l'utente parte da un valore coerente e poi lo
   * personalizza, invece di trovarsi improvvisamente una zona a vento zero in mezzo al percorso).
   * Se non c'è ancora nessuna zona vento, la crea uniforme (0 km/h) su tutto il percorso.
   */
  const addWindZoneBoundary = useCallback(
    async (distKm: number) => {
      if (!plan) return;
      const clamped = Math.max(0, Math.min(distanceKm, distKm));
      if (plan.windZones.length < 2) {
        await save({
          windZones: [
            { id: generateWindZoneId(), distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
            { id: generateWindZoneId(), distKm: distanceKm, fixed: 'finish', speedKmh: 0, directionDeg: 0 }
          ]
        });
        return;
      }
      const tooClose = plan.windZones.some(z => Math.abs(z.distKm - clamped) < MIN_WIND_ZONE_SEP_KM);
      if (tooClose) return;
      const sorted = [...plan.windZones].sort((a, b) => a.distKm - b.distKm);
      let covering = sorted[sorted.length - 1]!;
      for (let i = 1; i < sorted.length; i++) {
        if (clamped <= sorted[i]!.distKm) {
          covering = sorted[i]!;
          break;
        }
      }
      const newZone: WindZoneBoundary = {
        id: generateWindZoneId(),
        distKm: clamped,
        fixed: false,
        speedKmh: covering.speedKmh ?? 0,
        directionDeg: covering.directionDeg ?? 0
      };
      const merged = [...plan.windZones, newZone].sort((a, b) => a.distKm - b.distKm);
      await save({ windZones: merged });
    },
    [plan, save, distanceKm]
  );

  const removeWindZoneBoundary = useCallback(
    async (id: string) => {
      if (!plan) return;
      const filtered = plan.windZones.filter(z => z.id !== id);
      await save({ windZones: filtered });
    },
    [plan, save]
  );

  const updateWindZone = useCallback(
    async (id: string, patch: Partial<Pick<WindZoneBoundary, 'speedKmh' | 'directionDeg'>>) => {
      if (!plan) return;
      const updated = plan.windZones.map(z => (z.id === id ? { ...z, ...patch } : z));
      await save({ windZones: updated });
    },
    [plan, save]
  );

  /** Torna a una singola zona vento uniforme su tutto il percorso, mantenendo l'ultimo valore impostato. */
  const resetWindZones = useCallback(async () => {
    if (!plan) return;
    const last = plan.windZones[plan.windZones.length - 1];
    await save({
      windZones: [
        { id: generateWindZoneId(), distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
        { id: generateWindZoneId(), distKm: distanceKm, fixed: 'finish', speedKmh: last?.speedKmh ?? 0, directionDeg: last?.directionDeg ?? 0 }
      ]
    });
  }, [plan, save, distanceKm]);

  /** Azzera del tutto le zone vento (equivalente a "vento non configurato"). */
  const clearWindZones = useCallback(async () => {
    if (!plan) return;
    await save({ windZones: [] });
  }, [plan, save]);

  return {
    plan,
    loading,
    addBreakpoint,
    addBreakpointsEvery,
    removeBreakpoint,
    updateBreakpoint,
    setCalcMode,
    setDefaultSpeedKmh,
    setDefaultPowerWatts,
    resetBreakpoints,
    applyPowerUpdates,
    replaceBreakpoints,
    addWindZoneBoundary,
    removeWindZoneBoundary,
    updateWindZone,
    resetWindZones,
    clearWindZones
  };
}
