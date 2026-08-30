import { useEffect, useMemo, useRef, useState } from 'react';
import { processRoute, computeSections, parseClockTimeToMinutes, type PhysicsParams, type ProcessedPoint, type SectionBreakpoint } from '@physics-core';
import type { Route } from '@shared-schema';
import { useDataStore } from '../lib/DataStoreContext.js';
import { useSectionPlan } from '../hooks/useSectionPlan.js';
import { parseActivityText, type ActivityTrackPoint } from '../activity/parseActivityFile.js';
import { buildActivityDisplay, remapElevationFromRoute } from '../activity/buildActivityDisplay.js';
import { buildCdaSamples } from '../activity/activitySamples.js';
import { computePlanVsActualSections, computePlanVsActualFineGrid, padSeriesToRouteEdges, type PlanVsActualSectionRow } from '../lib/planVsActual.js';
import { formatTime, formatDeltaTime } from '../lib/formatTime.js';
import { planVsActualSectionsToCsv, planVsActualFineGridToCsv, downloadTextFile } from '../lib/exportCsv.js';
import { RouteMap, type MapWindControlData } from './RouteMap.js';
import { ActivityElevationChart } from './ActivityElevationChart.js';
import { ElevationChart } from './ElevationChart.js';
import { StatsRow } from './StatsRow.js';
import { WindZonesPanel } from './WindZonesPanel.js';
import { PacingOptimizerPanel } from './PacingOptimizerPanel.js';
import { SectionsTable } from './SectionsTable.js';
import { NumberField } from './NumberField.js';
import { PhysicsParamsPanel } from './PhysicsParamsPanel.js';
import { CollapsibleSection } from './CollapsibleSection.js';

interface PlanVsActualViewProps {
  physicsParams: PhysicsParams;
  onPhysicsParamsChange: (params: PhysicsParams) => void;
}

// Riferimento stabile per "nessun breakpoint" nel pannello microsezioni: un literal `[]`
// inline verrebbe ricreato a ogni render, e siccome ActivityElevationChart ha `breakpoints`
// nel dependency array del suo useEffect di disegno, una nuova identità ad ogni render
// forzava lo smontaggio/ricostruzione COMPLETA del grafico (incl. l'hover) a ogni singolo
// movimento del mouse — proprio nel pannello dove l'hover doveva restare stabile.
const NO_BREAKPOINTS: SectionBreakpoint[] = [];

// Stesso principio di NO_BREAKPOINTS: il grafico principale "confronto con uscita reale" non
// ha una vera griglia di microsezioni da mostrare (quella è solo nel pannello dedicato), ma
// passarla esplicitamente qui evita di appoggiarsi al default-parameter del componente — che
// è già stato reso sicuro (vedi ActivityElevationChart.tsx), ma un riferimento esplicito e
// stabile è comunque più chiaro da leggere a chi apre questo file in futuro.
const NO_MICRO_BOUNDARIES: number[] = [];

function noop() {}

function windBadge(headwindKmh: number) {
  if (Math.abs(headwindKmh) < 0.5) return <span className="wind-badge wind-badge-neutral">— </span>;
  const isHeadwind = headwindKmh > 0;
  return (
    <span className={`wind-badge ${isHeadwind ? 'wind-badge-head' : 'wind-badge-tail'}`}>
      {isHeadwind ? '↑' : '↓'} {Math.abs(headwindKmh).toFixed(1)} km/h
    </span>
  );
}

function deltaBadge(value: number | null, unit: string, goodIsNegative = false) {
  if (value == null) return <span className="pva-delta pva-delta-na">—</span>;
  const isGood = goodIsNegative ? value <= 0 : value >= 0;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`pva-delta ${isGood ? 'pva-delta-good' : 'pva-delta-bad'}`}>
      {sign}
      {value.toFixed(1)}
      {unit}
    </span>
  );
}

function deltaTimeBadge(hours: number | null) {
  if (hours == null) return <span className="pva-delta pva-delta-na">—</span>;
  const isGood = hours <= 0;
  return <span className={`pva-delta ${isGood ? 'pva-delta-good' : 'pva-delta-bad'}`}>{formatDeltaTime(hours)}</span>;
}

/**
 * Confronto pacing pianificato vs uscita reale (F3.3) — ora anche editor completo del piano,
 * non solo visualizzazione: stessi pannelli della tab "Percorso" (zone vento con campioni
 * orari, ottimizzatore automatico, mappa/grafico con aggiunta punti, tabella sezioni
 * editabile). Modificare qui il piano lo modifica per davvero (stesso piano, stesso store) —
 * comodo per iterare rapidamente su un piano guardando in tempo reale come si comporta contro
 * un'uscita reale, invece di andare avanti e indietro fra due tab.
 *
 * Mappa e altimetria dell'uscita reale RIUSANO DIRETTAMENTE `RouteMap`/`ActivityElevationChart`
 * (F3.1): stesso hover sincronizzato mappa↔grafico, stesso zoom/brush, stesso overlay vento a
 * bande. La stessa coppia si ripete, collassata di default, per il confronto a MICROSEZIONI
 * (griglia fine automatica, passo configurabile) più sotto — con tacche leggere (non i
 * marker numerati dei breakpoint veri, sarebbero centinaia) a segnare ogni microsezione.
 *
 * Il vento reale non è un dato misurato ma stimato a ritroso dai dati di potenza (vedi
 * `estimateWindFromSamples` in physics-core) — la card "Affidabilità vento" è pensata per
 * costruire fiducia (o diffidenza) su questa stima prima di un'eventuale integrazione
 * forecast automatica.
 */
export function PlanVsActualView({ physicsParams, onPhysicsParamsChange }: PlanVsActualViewProps) {
  const store = useDataStore();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [routePoints, setRoutePoints] = useState<ProcessedPoint[] | null>(null);

  const selectedRoute = routes.find(r => r.id === selectedRouteId) ?? null;
  // Nome file sicuro per gli export CSV (F3.3): stessa sanificazione usata per l'export JSON
  // del piano in RouteSplitterApp.tsx, per coerenza fra i vari export dell'app.
  const safeRouteName = (selectedRoute?.name.trim().replace(/[^a-z0-9\-_]+/gi, '_') || 'percorso').toLowerCase();

  const {
    plan,
    addBreakpoint,
    addBreakpointsEvery,
    removeBreakpoint,
    updateBreakpoint,
    resetBreakpoints,
    applyPowerUpdates,
    setCalcMode,
    setDefaultSpeedKmh,
    setDefaultPowerWatts,
    addWindZoneBoundary,
    removeWindZoneBoundary,
    updateWindZone,
    addWindTimeSample,
    removeWindTimeSample,
    resetWindZones,
    setPlannedStartTime,
    setPacingStepMeters
  } = useSectionPlan(selectedRouteId || null, selectedRoute?.distanceKm ?? 0);

  // Editing del piano pianificato (percorso) — stessi controlli della tab "Percorso", ma
  // ripiegati di default: usati raramente in questa vista, che serve principalmente per
  // il confronto con l'uscita reale.
  const [addMode, setAddMode] = useState(false);
  const [manualKm, setManualKm] = useState(0);
  const [everyKm, setEveryKm] = useState(0.25);
  const [selectedWindZoneId, setSelectedWindZoneId] = useState<string | null>(null);
  const [smoothingRadiusMeters, setSmoothingRadiusMeters] = useState(50);
  const [hoverPoint, setHoverPoint] = useState<{ lat: number; lon: number } | null>(null);

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [activityPoints, setActivityPoints] = useState<ActivityTrackPoint[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sorgente quota dell'ATTIVITÀ REALE: il barometro/GPS del device è spesso impreciso
  // (rumore visibile in altimetria e nei dati derivati — pendenza, D+/D-, e quindi anche le
  // stime CdA/vento). "route" riusa la quota del GPX del percorso pianificato (di solito più
  // pulita) alla stessa distanza percorsa — vedi `remapElevationFromRoute`.
  const [elevationSource, setElevationSource] = useState<'device' | 'route'>('device');

  const [activityHoverPoint, setActivityHoverPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [activitySmoothingRadiusMeters, setActivitySmoothingRadiusMeters] = useState(50);

  const [microOpen, setMicroOpen] = useState(false);
  // Non più uno stato indipendente: il passo delle microsezioni DEVE coincidere con quello su
  // cui lavora l'ottimizzatore di pacing ("Ottimizza completo"), altrimenti il grafico non
  // dimostrerebbe le sezioni realmente scelte. Unica fonte di verità: plan.pacingStepMeters.
  const microStepKm = (plan?.pacingStepMeters ?? 100) / 1000;
  const [microHoverPoint, setMicroHoverPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [microSmoothingRadiusMeters, setMicroSmoothingRadiusMeters] = useState(50);

  useEffect(() => {
    void store.routes.listByAthlete(null).then(setRoutes);
  }, [store]);

  useEffect(() => {
    if (!selectedRouteId) {
      setRoutePoints(null);
      return;
    }
    void store.routes.getPoints(selectedRouteId).then(pts => setRoutePoints(pts ? processRoute(pts).points : null));
  }, [store, selectedRouteId]);

  const defaultPowerWatts = plan?.defaultPowerWatts ?? 250;

  // Sezioni del PIANO (non del confronto) — servono a ElevationChart/StatsRow, esattamente
  // come nella tab "Percorso".
  const sections = useMemo(() => {
    if (!plan || !routePoints || routePoints.length < 2) return [];
    return computeSections(
      plan.breakpoints,
      routePoints,
      physicsParams,
      plan.calcMode,
      defaultPowerWatts,
      plan.windZones,
      parseClockTimeToMinutes(plan.plannedStartTime)
    );
  }, [plan, routePoints, physicsParams, defaultPowerWatts]);

  const sortedWindZones = useMemo(() => [...(plan?.windZones ?? [])].sort((a, b) => a.distKm - b.distKm), [plan?.windZones]);
  const activeWindZoneIndex = useMemo(() => {
    if (sortedWindZones.length < 2) return -1;
    const idx = sortedWindZones.findIndex(z => z.id === selectedWindZoneId && z.fixed !== 'start');
    return idx > 0 ? idx : sortedWindZones.length - 1;
  }, [sortedWindZones, selectedWindZoneId]);
  const windControl: MapWindControlData | null = useMemo(() => {
    if (activeWindZoneIndex < 1 || !plan) return null;
    const zone = sortedWindZones[activeWindZoneIndex]!;
    const fromKm = sortedWindZones[activeWindZoneIndex - 1]!.distKm;
    return {
      rangeLabel: `${fromKm.toFixed(1)} → ${zone.distKm.toFixed(1)} km`,
      speedKmh: zone.speedKmh ?? 0,
      directionDeg: zone.directionDeg ?? 0,
      onChangeSpeed: (speedKmh: number) => void updateWindZone(zone.id, { speedKmh }),
      onChangeDirection: (directionDeg: number) => void updateWindZone(zone.id, { directionDeg })
    };
  }, [activeWindZoneIndex, sortedWindZones, plan, updateWindZone]);

  const handleFile = async (file: File) => {
    setBusy(true);
    setErrorMsg(null);
    setActivityPoints(null);
    setFileName(file.name);
    try {
      const parsed = /\.fit$/i.test(file.name)
        ? await (await import('../activity/parseFitFile.js')).parseFitFile(file)
        : parseActivityText(await file.text());
      if (parsed.points.length < 2) {
        setErrorMsg('File troppo corto: servono almeno 2 punti con coordinate e orario validi.');
        return;
      }
      if (!parsed.hasPower) {
        setErrorMsg('Il file non contiene dati di potenza: il confronto pianificato-vs-reale richiede la potenza registrata.');
        return;
      }
      setActivityPoints(parsed.points);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Errore durante la lettura del file.');
    } finally {
      setBusy(false);
    }
  };

  const effectiveActivityPoints = useMemo(() => {
    if (!activityPoints) return null;
    if (elevationSource === 'route' && routePoints) return remapElevationFromRoute(activityPoints, routePoints);
    return activityPoints;
  }, [activityPoints, elevationSource, routePoints]);

  const display = useMemo(() => (effectiveActivityPoints ? buildActivityDisplay(effectiveActivityPoints) : null), [effectiveActivityPoints]);
  const cdaBuilt = useMemo(() => (effectiveActivityPoints ? buildCdaSamples(effectiveActivityPoints) : null), [effectiveActivityPoints]);

  const rows = useMemo<PlanVsActualSectionRow[]>(() => {
    if (!plan || !routePoints || !display || !cdaBuilt) return [];
    return computePlanVsActualSections(
      plan.breakpoints,
      routePoints,
      physicsParams,
      plan.calcMode,
      plan.defaultPowerWatts,
      plan.windZones,
      plan.plannedStartTime,
      display.points,
      cdaBuilt.samples
    );
  }, [plan, routePoints, physicsParams, display, cdaBuilt]);

  // "Verifica dati" per le sezioni custom (piano manuale): toggle non distruttivo, esattamente
  // come per le microsezioni più sotto — NON sovrascrive il piano persistito. Quando attivo,
  // sostituisce ovunque "pianificata" con "verificata" (velocità che il modello predice dalla
  // potenza REALE media della sezione, stessa fisica di `plannedSpeedKmh` — vedi
  // `PlanVsActualSectionRow.verifiedSpeedKmh` in lib/planVsActual.ts). Un'unica sorgente di
  // stato per restare coerente sia nella tabella "Confronto per sezione" sia nel grafico
  // "Mappa e altimetria uscita reale" qui sotto (entrambi derivano dalle stesse sezioni).
  const [sectionsVerifyMode, setSectionsVerifyMode] = useState(false);
  const sectionsWithRealPower = useMemo(() => rows.filter(r => r.actualPowerWatts != null).length, [rows]);

  // Righe "effettive" per la tabella "Confronto per sezione" — unica fonte per tabella E
  // riepilogo (`summary` sotto), così non possono disallinearsi fra loro (bug segnalato: la
  // tabella non si aggiornava con la verifica dati). Quando sectionsVerifyMode è attivo E la
  // sezione ha un campione di potenza reale, "pianificata" diventa "verificata" (potenza
  // reale, velocità che il modello ne deriva) e i delta sono ricalcolati di conseguenza;
  // altrimenti resta il valore del piano originale (nulla da verificare per quella sezione).
  const displayRows = useMemo(() => {
    return rows.map(r => {
      const hasVerified = sectionsVerifyMode && r.actualPowerWatts != null && r.verifiedSpeedKmh != null;
      const plannedSpeedKmh = hasVerified ? r.verifiedSpeedKmh! : r.plannedSpeedKmh;
      const plannedPowerWatts = hasVerified ? r.actualPowerWatts! : r.plannedPowerWatts;
      const plannedTimeHours = hasVerified && plannedSpeedKmh > 0 ? r.distanceKm / plannedSpeedKmh : r.plannedTimeHours;
      const deltaSpeedPct = r.actualSpeedKmh != null && plannedSpeedKmh > 0 ? ((r.actualSpeedKmh - plannedSpeedKmh) / plannedSpeedKmh) * 100 : null;
      const deltaPowerPct = r.actualPowerWatts != null && plannedPowerWatts > 0 ? ((r.actualPowerWatts - plannedPowerWatts) / plannedPowerWatts) * 100 : null;
      const deltaTimeHours = r.actualTimeHours != null ? r.actualTimeHours - plannedTimeHours : null;
      return { ...r, plannedSpeedKmh, plannedPowerWatts, plannedTimeHours, deltaSpeedPct, deltaPowerPct, deltaTimeHours, isVerified: hasVerified };
    });
  }, [rows, sectionsVerifyMode]);

  const plannedFineGrid = useMemo(() => {
    if (!plan || !routePoints || !display || !cdaBuilt) return [];
    return computePlanVsActualFineGrid(
      plan.breakpoints,
      routePoints,
      physicsParams,
      plan.calcMode,
      plan.defaultPowerWatts,
      plan.windZones,
      display.distanceKm,
      cdaBuilt.samples
    );
  }, [plan, routePoints, physicsParams, display, cdaBuilt]);

  const plannedPowerSeries = useMemo(() => {
    if (!display) return [];
    return padSeriesToRouteEdges(
      plannedFineGrid.map(p => ({ distKm: p.distKm, powerWatts: p.plannedPowerWatts })),
      display.distanceKm
    );
  }, [plannedFineGrid, display]);

  // Stessa griglia fine di plannedPowerSeries qui sopra (nessun ricalcolo): la velocità
  // pianificata è già disponibile per ogni bin, va solo estratta e proiettata sul bordo del
  // percorso come per la potenza.
  const plannedSpeedSeries = useMemo(() => {
    if (!display) return [];
    return padSeriesToRouteEdges(
      plannedFineGrid.map(p => ({ distKm: p.distKm, speedKmh: p.plannedSpeedKmh })),
      display.distanceKm
    );
  }, [plannedFineGrid, display]);

  // "Verifica dati" per le sezioni custom (toggle `sectionsVerifyMode` sopra): stessa griglia
  // fine di plannedPowerSeries/plannedSpeedSeries, filtrata ai bin con un campione di potenza
  // reale — analogo esatto di microVerifiedPowerSeries/microVerifiedSpeedSeries più sotto.
  const verifiedPowerSeries = useMemo(() => {
    if (!display) return [];
    return padSeriesToRouteEdges(
      plannedFineGrid.filter(p => p.actualPowerWatts != null).map(p => ({ distKm: p.distKm, powerWatts: p.actualPowerWatts! })),
      display.distanceKm
    );
  }, [plannedFineGrid, display]);
  const verifiedSpeedSeries = useMemo(() => {
    if (!display) return [];
    return padSeriesToRouteEdges(
      plannedFineGrid.filter(p => p.verifiedSpeedKmh != null).map(p => ({ distKm: p.distKm, speedKmh: p.verifiedSpeedKmh! })),
      display.distanceKm
    );
  }, [plannedFineGrid, display]);
  const displayPowerSeries = sectionsVerifyMode ? verifiedPowerSeries : plannedPowerSeries;
  const displaySpeedSeries = sectionsVerifyMode ? verifiedSpeedSeries : plannedSpeedSeries;

  // Griglia a microsezioni: stessa funzione, stesso passo dell'ottimizzatore di pacing
  // (plan.pacingStepMeters) — calcolata solo quando il pannello è aperto (nessun costo se
  // non richiesta).
  const microGrid = useMemo(() => {
    if (!microOpen || !plan || !routePoints || !display || !cdaBuilt) return [];
    return computePlanVsActualFineGrid(
      plan.breakpoints,
      routePoints,
      physicsParams,
      plan.calcMode,
      plan.defaultPowerWatts,
      plan.windZones,
      display.distanceKm,
      cdaBuilt.samples,
      microStepKm
    );
  }, [microOpen, plan, routePoints, physicsParams, display, cdaBuilt, microStepKm]);

  const microPlannedPowerSeries = useMemo(
    () => padSeriesToRouteEdges(microGrid.map(p => ({ distKm: p.distKm, powerWatts: p.plannedPowerWatts })), display?.distanceKm ?? 0),
    [microGrid, display]
  );
  // Stessa griglia fine (a passo microsezioni) di microPlannedPowerSeries qui sopra.
  const microPlannedSpeedSeries = useMemo(
    () => padSeriesToRouteEdges(microGrid.map(p => ({ distKm: p.distKm, speedKmh: p.plannedSpeedKmh })), display?.distanceKm ?? 0),
    [microGrid, display]
  );
  const microBoundariesKm = useMemo(() => microGrid.map(p => p.distKm), [microGrid]);

  // "Verifica dati" a livello di MICROSEZIONE — equivalente del bottone omonimo sopra, ma per
  // le microsezioni: qui NON si può sovrascrivere il piano persistito (centinaia di micro-bin
  // non possono diventare breakpoint), quindi è un semplice TOGGLE di visualizzazione, non
  // un'azione distruttiva. Filtra ai soli bin con un campione di potenza reale (altrove non
  // c'è nulla da "verificare"); `verifiedSpeedKmh` è già calcolato dalla libreria con la
  // STESSA fisica (pendenza, vento, CdA) della velocità pianificata, sostituendo solo la
  // potenza in ingresso con quella reale di quel bin.
  const [microVerifyMode, setMicroVerifyMode] = useState(false);
  const microVerifiedPowerSeries = useMemo(
    () =>
      padSeriesToRouteEdges(
        microGrid.filter(p => p.actualPowerWatts != null).map(p => ({ distKm: p.distKm, powerWatts: p.actualPowerWatts! })),
        display?.distanceKm ?? 0
      ),
    [microGrid, display]
  );
  const microVerifiedSpeedSeries = useMemo(
    () =>
      padSeriesToRouteEdges(
        microGrid.filter(p => p.verifiedSpeedKmh != null).map(p => ({ distKm: p.distKm, speedKmh: p.verifiedSpeedKmh! })),
        display?.distanceKm ?? 0
      ),
    [microGrid, display]
  );
  const microDisplayPowerSeries = microVerifyMode ? microVerifiedPowerSeries : microPlannedPowerSeries;
  const microDisplaySpeedSeries = microVerifyMode ? microVerifiedSpeedSeries : microPlannedSpeedSeries;
  const microSectionsWithRealPower = useMemo(() => microGrid.filter(p => p.actualPowerWatts != null).length, [microGrid]);
  // BUG SEGNALATO: la tabella delle microsezioni leggeva `microGrid` direttamente
  // (plannedSpeedKmh/plannedPowerWatts sempre del PIANO), quindi non si aggiornava affatto
  // quando si attivava "Verifica dati" — il grafico sopra cambiava, la tabella sotto no.
  // Stesso principio di displayRows più sopra (sezioni custom): un'unica trasformazione
  // "effettiva" applicata PRIMA sia al grafico (le serie microDisplay*Series qui sopra) sia
  // alla tabella, così i due non possono più disallinearsi.
  const microDisplayGrid = useMemo(() => {
    return microGrid.map(p => {
      const hasVerified = microVerifyMode && p.actualPowerWatts != null && p.verifiedSpeedKmh != null;
      const plannedSpeedKmh = hasVerified ? p.verifiedSpeedKmh! : p.plannedSpeedKmh;
      const plannedPowerWatts = hasVerified ? p.actualPowerWatts! : p.plannedPowerWatts;
      return { ...p, plannedSpeedKmh, plannedPowerWatts, isVerified: hasVerified };
    });
  }, [microGrid, microVerifyMode]);

  // Riepilogo compatto per le microsezioni — stesso identico layout/calcolo del riepilogo
  // "Confronto per sezione" sopra (media pesata sul tempo, non aritmetica sulle sezioni):
  // mancava, mentre la tabella di dettaglio sotto già c'era — le due viste devono avere lo
  // stesso layout, non solo la stessa tabella. Il "tempo" per bin è ricavato da
  // distanza/velocità (i bin non hanno già un campo tempo pianificato/reale come le sezioni).
  const microSummary = useMemo(() => {
    if (microDisplayGrid.length === 0) return null;
    let plannedDistKm = 0;
    let plannedTimeH = 0;
    let plannedPowerTimeWeighted = 0;
    let actualDistKm = 0;
    let actualTimeH = 0;
    let actualPowerTimeWeighted = 0;
    let hasActual = false;
    for (const p of microDisplayGrid) {
      const binDistKm = p.toKm - p.fromKm;
      const plannedTimeHoursBin = p.plannedSpeedKmh > 0 ? binDistKm / p.plannedSpeedKmh : 0;
      plannedDistKm += binDistKm;
      plannedTimeH += plannedTimeHoursBin;
      plannedPowerTimeWeighted += p.plannedPowerWatts * plannedTimeHoursBin;
      if (p.actualSpeedKmh != null && p.actualSpeedKmh > 0) {
        hasActual = true;
        const actualTimeHoursBin = binDistKm / p.actualSpeedKmh;
        actualTimeH += actualTimeHoursBin;
        actualDistKm += p.actualSpeedKmh * actualTimeHoursBin;
        if (p.actualPowerWatts != null) actualPowerTimeWeighted += p.actualPowerWatts * actualTimeHoursBin;
      }
    }
    const plannedSpeedKmh = plannedTimeH > 0 ? plannedDistKm / plannedTimeH : 0;
    const plannedPowerWatts = plannedTimeH > 0 ? plannedPowerTimeWeighted / plannedTimeH : 0;
    const actualSpeedKmh = hasActual && actualTimeH > 0 ? actualDistKm / actualTimeH : null;
    const actualPowerWatts = hasActual && actualTimeH > 0 ? actualPowerTimeWeighted / actualTimeH : null;
    const actualTimeHoursTotal = hasActual ? actualTimeH : null;
    return {
      plannedSpeedKmh,
      actualSpeedKmh,
      deltaSpeedPct: actualSpeedKmh != null && plannedSpeedKmh > 0 ? ((actualSpeedKmh - plannedSpeedKmh) / plannedSpeedKmh) * 100 : null,
      plannedPowerWatts,
      actualPowerWatts,
      deltaPowerPct: actualPowerWatts != null && plannedPowerWatts > 0 ? ((actualPowerWatts - plannedPowerWatts) / plannedPowerWatts) * 100 : null,
      plannedTimeH,
      actualTimeHoursTotal,
      deltaTimeHours: actualTimeHoursTotal != null ? actualTimeHoursTotal - plannedTimeH : null
    };
  }, [microDisplayGrid]);

  const windRows = rows.filter(r => r.actualWindHeadwindKmh != null);

  // Riepilogo compatto (3 righe: velocità/potenza/tempo) sopra la tabella di confronto —
  // medie pesate sul tempo pianificato/reale di ciascuna sezione, non una semplice media
  // aritmetica fra sezioni di lunghezza diversa. Usa displayRows (non rows) per restare
  // coerente col toggle "Verifica dati" qui sopra.
  const summary = useMemo(() => {
    if (displayRows.length === 0) return null;
    let plannedDistKm = 0;
    let plannedTimeH = 0;
    let plannedPowerTimeWeighted = 0;
    let actualDistKm = 0;
    let actualTimeH = 0;
    let actualPowerTimeWeighted = 0;
    let hasActual = false;
    for (const r of displayRows) {
      plannedDistKm += r.distanceKm;
      plannedTimeH += r.plannedTimeHours;
      plannedPowerTimeWeighted += r.plannedPowerWatts * r.plannedTimeHours;
      if (r.actualTimeHours != null && r.actualSpeedKmh != null) {
        hasActual = true;
        actualTimeH += r.actualTimeHours;
        actualDistKm += r.actualSpeedKmh * r.actualTimeHours;
        if (r.actualPowerWatts != null) actualPowerTimeWeighted += r.actualPowerWatts * r.actualTimeHours;
      }
    }
    const plannedSpeedKmh = plannedTimeH > 0 ? plannedDistKm / plannedTimeH : 0;
    const plannedPowerWatts = plannedTimeH > 0 ? plannedPowerTimeWeighted / plannedTimeH : 0;
    const actualSpeedKmh = hasActual && actualTimeH > 0 ? actualDistKm / actualTimeH : null;
    const actualPowerWatts = hasActual && actualTimeH > 0 ? actualPowerTimeWeighted / actualTimeH : null;
    const actualTimeHoursTotal = hasActual ? actualTimeH : null;
    return {
      plannedSpeedKmh,
      actualSpeedKmh,
      deltaSpeedPct: actualSpeedKmh != null && plannedSpeedKmh > 0 ? ((actualSpeedKmh - plannedSpeedKmh) / plannedSpeedKmh) * 100 : null,
      plannedPowerWatts,
      actualPowerWatts,
      deltaPowerPct: actualPowerWatts != null && plannedPowerWatts > 0 ? ((actualPowerWatts - plannedPowerWatts) / plannedPowerWatts) * 100 : null,
      plannedTimeH,
      actualTimeHoursTotal,
      deltaTimeHours: actualTimeHoursTotal != null ? actualTimeHoursTotal - plannedTimeH : null
    };
  }, [displayRows]);

  return (
    <div className="activity-analysis-view">
      <div className="activity-analysis-header">
        <h2 className="physics-panel-title">Confronto Pianificato vs Reale</h2>
        <p className="physics-hint">
          Modifica il piano di pacing (sezioni, vento, ottimizzatore — stessi controlli della tab "Percorso") e
          confrontalo subito con un'uscita reale registrata: tempo, velocità, potenza e vento sezione per sezione. Il
          vento reale non è misurato ma stimato dai dati di potenza — utile per capire quanto fidarsi di un vento
          pianificato manualmente prima di un'eventuale integrazione forecast.
        </p>
      </div>

      <div className="physics-panel pva-selectors-panel">
        <div className="pva-selectors">
          <label>
            Percorso
            <select value={selectedRouteId} onChange={e => setSelectedRouteId(e.target.value)}>
              <option value="">— seleziona —</option>
              {routes.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.distanceKm.toFixed(1)} km)
                </option>
              ))}
            </select>
          </label>
          <label>
            Fonte quota uscita reale
            <select value={elevationSource} onChange={e => setElevationSource(e.target.value as 'device' | 'route')} disabled={!routePoints}>
              <option value="device">Reale (registrata dal device)</option>
              <option value="route">Percorso (dal GPX del piano)</option>
            </select>
          </label>
          {plan && (
            <label>
              Ora partenza piano (opz.)
              <input type="time" value={plan.plannedStartTime ?? ''} onChange={e => void setPlannedStartTime(e.target.value || null)} />
            </label>
          )}
        </div>

        <div className="pacing-actions pva-upload-row">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? 'Elaborazione…' : fileName ? `📄 ${fileName}` : '📄 Carica uscita reale (FIT/TCX/GPX)'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".fit,.tcx,.gpx"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
        </div>
        {errorMsg && <p className="app-error">{errorMsg}</p>}
        {!selectedRoute && <p className="wind-panel-hint">Seleziona un percorso per iniziare a modificare il piano.</p>}
      </div>

      {selectedRoute && plan && routePoints && routePoints.length > 1 && (
        <>
          <CollapsibleSection title="📈 Statistiche percorso">
            <StatsRow route={selectedRoute} sections={sections} />
          </CollapsibleSection>

          <CollapsibleSection title="⚙️ Parametri fisici">
            <PhysicsParamsPanel params={physicsParams} onChange={onPhysicsParamsChange} calcMode={plan.calcMode} onCalcModeChange={mode => void setCalcMode(mode)} />
          </CollapsibleSection>

          {plan.windZones.length >= 2 && (
            <CollapsibleSection title="💨 Zone vento">
              <WindZonesPanel
                windZones={plan.windZones}
                totalDistanceKm={selectedRoute.distanceKm}
                selectedZoneId={selectedWindZoneId}
                onSelectZone={setSelectedWindZoneId}
                onAddBoundary={distKm => void addWindZoneBoundary(distKm)}
                onRemoveBoundary={id => void removeWindZoneBoundary(id)}
                onReset={() => void resetWindZones()}
                plannedStartTime={plan.plannedStartTime}
                onAddTimeSample={(zoneId, minuteOfDay, speedKmh, directionDeg) => void addWindTimeSample(zoneId, minuteOfDay, speedKmh, directionDeg)}
                onRemoveTimeSample={(zoneId, sampleId) => void removeWindTimeSample(zoneId, sampleId)}
              />
            </CollapsibleSection>
          )}

          <CollapsibleSection title="🎯 Ottimizzatore di pacing">
            <PacingOptimizerPanel
              breakpoints={plan.breakpoints}
              processedPoints={routePoints}
              physicsParams={physicsParams}
              totalDistanceKm={selectedRoute.distanceKm}
              windZones={plan.windZones}
              onApplyPowers={updates => void applyPowerUpdates(updates)}
              stepMeters={plan.pacingStepMeters}
              onStepMetersChange={v => void setPacingStepMeters(v)}
            />
          </CollapsibleSection>

          <CollapsibleSection
            title="🛠️ Modifica piano (mappa, altimetria, sezioni)"
            defaultOpen={false}
            collapsedHint="Ripiegato di default — apri solo se devi ritoccare punti/potenza del piano."
          >
            <>
                <div className="gara-zone">
                  <RouteMap
                    points={routePoints}
                    smoothingRadiusMeters={smoothingRadiusMeters}
                    hoverPoint={hoverPoint}
                    breakpoints={plan.breakpoints}
                    addMode={addMode}
                    onAddBreakpoint={distKm => void addBreakpoint(distKm)}
                    onRemoveBreakpoint={id => void removeBreakpoint(id)}
                    windControl={windControl}
                    windZones={plan.windZones}
                    totalDistanceKm={selectedRoute.distanceKm}
                  />

                  <div className="top-controls-row">
                    <p className="sv-hint">
                      👆 "Aggiungi punto" poi clicca su mappa/grafico per posizionarlo (clic su un punto per rimuoverlo).
                      Trascina il grafico per zoomare, doppio clic per resettare.
                    </p>
                    <button type="button" className={`btn btn-sm addmode-btn${addMode ? ' active' : ''}`} onClick={() => setAddMode(v => !v)}>
                      ✛ Aggiungi punto
                    </button>
                    <div className="manual-add">
                      <span>km</span>
                      <NumberField min={0} step={0.1} value={manualKm} onCommit={setManualKm} placeholder="0.0" />
                      <button
                        type="button"
                        className="btn btn-sm ghost"
                        onClick={() => {
                          void addBreakpoint(manualKm);
                          setManualKm(0);
                        }}
                      >
                        Aggiungi
                      </button>
                    </div>
                    <div className="manual-add">
                      <span>ogni</span>
                      <NumberField min={0.05} step={0.05} value={everyKm} onCommit={setEveryKm} />
                      <span>km</span>
                      <button type="button" className="btn btn-sm ghost" onClick={() => void addBreakpointsEvery(everyKm)}>
                        Sezioni ogni
                      </button>
                    </div>
                    <button type="button" className="btn btn-sm ghost" onClick={() => void resetBreakpoints()}>
                      ↺ Reset punti
                    </button>
                    <label className="default-value-field">
                      {plan.calcMode === 'power' ? 'Potenza default nuove sezioni' : 'Velocità default nuove sezioni'}
                      {plan.calcMode === 'power' ? (
                        <NumberField step={1} value={plan.defaultPowerWatts} onCommit={v => void setDefaultPowerWatts(v)} />
                      ) : (
                        <NumberField step={0.1} value={plan.defaultSpeedKmh} onCommit={v => void setDefaultSpeedKmh(v)} />
                      )}
                      <span>{plan.calcMode === 'power' ? 'W' : 'km/h'}</span>
                    </label>
                    <button
                      type="button"
                      className={`btn btn-sm ghost${plan.calcMode === 'power' ? ' active' : ''}`}
                      onClick={() => void setCalcMode(plan.calcMode === 'power' ? 'speed' : 'power')}
                    >
                      Modalità: {plan.calcMode === 'power' ? 'Potenza' : 'Velocità'}
                    </button>
                  </div>

                  <div className="panel">
                    <ElevationChart
                      points={routePoints}
                      smoothingRadiusMeters={smoothingRadiusMeters}
                      onSmoothingChange={setSmoothingRadiusMeters}
                      onHoverPoint={info => setHoverPoint(info ? { lat: info.lat, lon: info.lon } : null)}
                      breakpoints={plan.breakpoints}
                      sections={sections}
                      addMode={addMode}
                      onAddBreakpoint={distKm => void addBreakpoint(distKm)}
                      onRemoveBreakpoint={id => void removeBreakpoint(id)}
                      windZones={plan.windZones}
                    />
                  </div>
                </div>

                <div className="physics-panel">
                  <div className="physics-panel-title">📋 Sezioni del piano</div>
                  <SectionsTable
                    sections={sections}
                    calcMode={plan.calcMode}
                    showCda={(physicsParams.cdaTiers?.length ?? 0) > 0}
                    onUpdateLabel={(id, label) => void updateBreakpoint(id, { sectionLabel: label })}
                    onUpdateSpeed={(id, speedKmh) => void updateBreakpoint(id, { speedKmh })}
                    onUpdatePower={(id, powerWatts) => void updateBreakpoint(id, { powerWatts })}
                    onRemove={id => void removeBreakpoint(id)}
                  />
                </div>
            </>
          </CollapsibleSection>
        </>
      )}

      {plan && display && rows.length > 0 && (
        <>
          <div className="physics-panel-title pva-section-divider">🆚 Confronto con l'uscita reale</div>

          <CollapsibleSection title="📊 Confronto per sezione (piano manuale)">
            <div className="physics-panel pva-micro-panel">
              {sectionsWithRealPower > 0 && (
                <label
                  className="stream-toggle"
                  style={{ marginBottom: '0.6rem', display: 'inline-flex' }}
                  title="Mostra, al posto della linea/colonna pianificata, la velocità che il modello predice usando la potenza REALE media di ogni sezione — per vedere dove il modello fisico sovrastima/sottostima, isolato dalla scelta di pacing."
                >
                  <input type="checkbox" checked={sectionsVerifyMode} onChange={e => setSectionsVerifyMode(e.target.checked)} />
                  🔍 Verifica dati ({sectionsWithRealPower} sezioni con potenza reale)
                </label>
              )}

              {summary && (
                <div className="pva-summary-grid">
                  <div className="pva-summary-header">
                    <span></span>
                    <span>{sectionsVerifyMode ? 'Verif.' : 'Pian.'}</span>
                    <span>Reale</span>
                    <span>Δ</span>
                  </div>
                  <div className="pva-summary-row">
                    <span className="pva-summary-label">Velocità</span>
                    <span className="pva-summary-val">{summary.plannedSpeedKmh.toFixed(1)} km/h</span>
                    <span className="pva-summary-val">{summary.actualSpeedKmh != null ? `${summary.actualSpeedKmh.toFixed(1)} km/h` : '—'}</span>
                    {deltaBadge(summary.deltaSpeedPct, '%')}
                  </div>
                  <div className="pva-summary-row">
                    <span className="pva-summary-label">Potenza</span>
                    <span className="pva-summary-val">{Math.round(summary.plannedPowerWatts)} W</span>
                    <span className="pva-summary-val">{summary.actualPowerWatts != null ? `${Math.round(summary.actualPowerWatts)} W` : '—'}</span>
                    {deltaBadge(summary.deltaPowerPct, '%')}
                  </div>
                  <div className="pva-summary-row">
                    <span className="pva-summary-label">Tempo</span>
                    <span className="pva-summary-val">{formatTime(summary.plannedTimeH)}</span>
                    <span className="pva-summary-val">{summary.actualTimeHoursTotal != null ? formatTime(summary.actualTimeHoursTotal) : '—'}</span>
                    {deltaTimeBadge(summary.deltaTimeHours)}
                  </div>
                </div>
              )}

              <div className="gara-zone">
                <RouteMap
                  points={display.points}
                  smoothingRadiusMeters={activitySmoothingRadiusMeters}
                  hoverPoint={activityHoverPoint}
                  breakpoints={plan.breakpoints}
                  addMode={false}
                  onAddBreakpoint={noop}
                  onRemoveBreakpoint={noop}
                  windControl={null}
                  windZones={plan.windZones}
                  totalDistanceKm={display.distanceKm}
                />
                <div className="panel">
                  <ActivityElevationChart
                    points={display.points}
                    smoothingRadiusMeters={activitySmoothingRadiusMeters}
                    onSmoothingChange={setActivitySmoothingRadiusMeters}
                    onHoverPoint={setActivityHoverPoint}
                    breakpoints={plan.breakpoints}
                    addMode={false}
                    onAddBreakpoint={noop}
                    onRemoveBreakpoint={noop}
                    windZones={plan.windZones}
                    plannedPowerSeries={displayPowerSeries}
                    plannedSpeedSeries={displaySpeedSeries}
                    plannedPowerLabel={sectionsVerifyMode ? 'verificata (potenza reale)' : 'pianificata'}
                    plannedSpeedLabel={sectionsVerifyMode ? 'verificata (potenza reale)' : 'pianificata'}
                    microBoundariesKm={NO_MICRO_BOUNDARIES}
                  />
                </div>
              </div>

              <div className="pva-export-row">
                <button
                  type="button"
                  className="btn btn-sm ghost"
                  onClick={() => downloadTextFile(`confronto_sezioni_${safeRouteName}.csv`, planVsActualSectionsToCsv(rows), 'text/csv')}
                  title="Esporta questa tabella (dati grezzi, non filtrati da 'Verifica dati') in CSV"
                >
                  ⬇️ Esporta CSV
                </button>
              </div>

              <div className="sections-table-wrap">
                <table className="sections-table pva-sections-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Sezione</th>
                      <th>Distanza</th>
                      <th>Velocità {sectionsVerifyMode ? 'verif.' : 'pian.'}</th>
                      <th>Velocità reale</th>
                      <th>Δ vel.</th>
                      <th>Potenza {sectionsVerifyMode ? 'verif.' : 'pian.'}</th>
                      <th>Potenza reale</th>
                      <th>Δ pot.</th>
                      <th>Tempo {sectionsVerifyMode ? 'verif.' : 'pian.'}</th>
                      <th>Tempo reale</th>
                      <th>Δ tempo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map(r => (
                      <tr key={r.index}>
                        <td>{r.index}</td>
                        <td>{r.label ?? `Sezione ${r.index}`}</td>
                        <td>{r.distanceKm.toFixed(1)} km</td>
                        <td>{r.plannedSpeedKmh.toFixed(1)} km/h</td>
                        <td>{r.actualSpeedKmh != null ? `${r.actualSpeedKmh.toFixed(1)} km/h` : '—'}</td>
                        <td>{deltaBadge(r.deltaSpeedPct, '%')}</td>
                        <td>{Math.round(r.plannedPowerWatts)} W</td>
                        <td>{r.actualPowerWatts != null ? `${Math.round(r.actualPowerWatts)} W` : '—'}</td>
                        <td>{deltaBadge(r.deltaPowerPct, '%')}</td>
                        <td>{formatTime(r.plannedTimeHours)}</td>
                        <td>{r.actualTimeHours != null ? formatTime(r.actualTimeHours) : '—'}</td>
                        <td>{deltaTimeBadge(r.deltaTimeHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="💨 Affidabilità vento pianificato">
            <div className="physics-panel pva-wind-card">
            {windRows.length === 0 ? (
              <p className="wind-panel-hint">
                Nessuna stima di vento reale disponibile (servono almeno ~20 campioni validi per sezione con potenza e
                velocità sopra soglia).
              </p>
            ) : (
              <div className="sections-table-wrap">
                <table className="sections-table pva-wind-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Sezione</th>
                      <th>Vento pianificato</th>
                      <th>Vento reale (stimato)</th>
                      <th>Delta</th>
                      <th>Campioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {windRows.map(r => {
                      const signFlip =
                        Math.sign(r.plannedWindHeadwindKmh) !== 0 &&
                        Math.sign(r.actualWindHeadwindKmh!) !== 0 &&
                        Math.sign(r.plannedWindHeadwindKmh) !== Math.sign(r.actualWindHeadwindKmh!);
                      return (
                        <tr key={r.index}>
                          <td>{r.index}</td>
                          <td>{r.label ?? `Sezione ${r.index}`}</td>
                          <td>{windBadge(r.plannedWindHeadwindKmh)}</td>
                          <td>{windBadge(r.actualWindHeadwindKmh!)}</td>
                          <td>
                            {deltaBadge(r.deltaWindKmh, ' km/h')}
                            {signFlip && (
                              <span className="pva-flip-badge" title="Il segno testa/coda si inverte rispetto al piano">
                                🔄 invertito
                              </span>
                            )}
                          </td>
                          <td>{r.actualWindUsedSamples}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="🔬 Confronto a microsezioni (griglia automatica)"
            defaultOpen={false}
            open={microOpen}
            onToggle={setMicroOpen}
            collapsedHint="Lo stesso confronto sopra, ma sulla griglia fine dell'ottimizzatore di pacing (stesso passo in metri) invece che sulle sezioni del piano — utile per individuare punti precisi dove la previsione si discosta dai dati reali."
          >
            <div className="physics-panel pva-micro-panel">
                <div className="pva-micro-controls">
                  <span className="pva-micro-active-label">
                    Passo: {microStepKm < 1 ? `${Math.round(microStepKm * 1000)} m` : `${microStepKm} km`} (dall'ottimizzatore di pacing, sezione sopra) · {microGrid.length} microsezioni
                  </span>
                  {microSectionsWithRealPower > 0 && (
                    <label className="stream-toggle" style={{ marginLeft: '1rem' }} title="Mostra, al posto della linea pianificata, la velocità che il modello predice usando la potenza REALE registrata in ogni microsezione — per vedere dove il modello fisico sovrastima/sottostima, isolato dalla scelta di pacing.">
                      <input type="checkbox" checked={microVerifyMode} onChange={e => setMicroVerifyMode(e.target.checked)} />
                      🔍 Verifica dati ({microSectionsWithRealPower} microsezioni con potenza reale)
                    </label>
                  )}
                </div>

                {microSummary && (
                  <div className="pva-summary-grid">
                    <div className="pva-summary-header">
                      <span></span>
                      <span>{microVerifyMode ? 'Verif.' : 'Pian.'}</span>
                      <span>Reale</span>
                      <span>Δ</span>
                    </div>
                    <div className="pva-summary-row">
                      <span className="pva-summary-label">Velocità</span>
                      <span className="pva-summary-val">{microSummary.plannedSpeedKmh.toFixed(1)} km/h</span>
                      <span className="pva-summary-val">{microSummary.actualSpeedKmh != null ? `${microSummary.actualSpeedKmh.toFixed(1)} km/h` : '—'}</span>
                      {deltaBadge(microSummary.deltaSpeedPct, '%')}
                    </div>
                    <div className="pva-summary-row">
                      <span className="pva-summary-label">Potenza</span>
                      <span className="pva-summary-val">{Math.round(microSummary.plannedPowerWatts)} W</span>
                      <span className="pva-summary-val">{microSummary.actualPowerWatts != null ? `${Math.round(microSummary.actualPowerWatts)} W` : '—'}</span>
                      {deltaBadge(microSummary.deltaPowerPct, '%')}
                    </div>
                    <div className="pva-summary-row">
                      <span className="pva-summary-label">Tempo</span>
                      <span className="pva-summary-val">{formatTime(microSummary.plannedTimeH)}</span>
                      <span className="pva-summary-val">{microSummary.actualTimeHoursTotal != null ? formatTime(microSummary.actualTimeHoursTotal) : '—'}</span>
                      {deltaTimeBadge(microSummary.deltaTimeHours)}
                    </div>
                  </div>
                )}

                <div className="gara-zone">
                  <RouteMap
                    points={display.points}
                    smoothingRadiusMeters={microSmoothingRadiusMeters}
                    hoverPoint={microHoverPoint}
                    breakpoints={NO_BREAKPOINTS}
                    addMode={false}
                    onAddBreakpoint={noop}
                    onRemoveBreakpoint={noop}
                    windControl={null}
                    windZones={plan.windZones}
                    totalDistanceKm={display.distanceKm}
                    microBoundariesKm={microBoundariesKm}
                  />
                  <div className="panel">
                    <ActivityElevationChart
                      points={display.points}
                      smoothingRadiusMeters={microSmoothingRadiusMeters}
                      onSmoothingChange={setMicroSmoothingRadiusMeters}
                      onHoverPoint={setMicroHoverPoint}
                      breakpoints={NO_BREAKPOINTS}
                      addMode={false}
                      onAddBreakpoint={noop}
                      onRemoveBreakpoint={noop}
                      windZones={plan.windZones}
                      plannedPowerSeries={microDisplayPowerSeries}
                      plannedSpeedSeries={microDisplaySpeedSeries}
                      plannedPowerLabel={microVerifyMode ? 'verificata (potenza reale)' : 'pianificata'}
                      plannedSpeedLabel={microVerifyMode ? 'verificata (potenza reale)' : 'pianificata'}
                      microBoundariesKm={microBoundariesKm}
                    />
                  </div>
                </div>

                <div className="pva-export-row">
                  <button
                    type="button"
                    className="btn btn-sm ghost"
                    onClick={() => downloadTextFile(`confronto_microsezioni_${safeRouteName}.csv`, planVsActualFineGridToCsv(microGrid), 'text/csv')}
                    title="Esporta questa tabella (dati grezzi, non filtrati da 'Verifica dati', include pendenza e quota per bin) in CSV"
                  >
                    ⬇️ Esporta CSV
                  </button>
                </div>

                <div className="sections-table-wrap pva-micro-table-wrap">
                  <table className="sections-table pva-micro-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Tratto (km)</th>
                        <th>Pend.</th>
                        <th>Vel. {microVerifyMode ? 'verif.' : 'pian.'}</th>
                        <th>Vel. reale</th>
                        <th>Δ vel.</th>
                        <th>Pot. {microVerifyMode ? 'verif.' : 'pian.'}</th>
                        <th>Pot. reale</th>
                        <th>Δ pot.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {microDisplayGrid.map((p, i) => {
                        const deltaSpeedPct = p.actualSpeedKmh != null && p.plannedSpeedKmh > 0 ? ((p.actualSpeedKmh - p.plannedSpeedKmh) / p.plannedSpeedKmh) * 100 : null;
                        const deltaPowerPct =
                          p.actualPowerWatts != null && p.plannedPowerWatts > 0 ? ((p.actualPowerWatts - p.plannedPowerWatts) / p.plannedPowerWatts) * 100 : null;
                        return (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            <td>
                              {p.fromKm.toFixed(2)} – {p.toKm.toFixed(2)}
                            </td>
                            <td>{p.gradientPct.toFixed(1)}%</td>
                            <td>{p.plannedSpeedKmh.toFixed(1)} km/h</td>
                            <td>{p.actualSpeedKmh != null ? `${p.actualSpeedKmh.toFixed(1)} km/h` : '—'}</td>
                            <td>{deltaBadge(deltaSpeedPct, '%')}</td>
                            <td>{Math.round(p.plannedPowerWatts)} W</td>
                            <td>{p.actualPowerWatts != null ? `${Math.round(p.actualPowerWatts)} W` : '—'}</td>
                            <td>{deltaBadge(deltaPowerPct, '%')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
            </div>
          </CollapsibleSection>
        </>
      )}
    </div>
  );
}
