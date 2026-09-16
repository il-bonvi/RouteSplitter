import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processRoute, computeDynamicSections, parseClockTimeToMinutes, computeAirDensity, distanceWeightedMeanBearingDeg, effectiveHeadwindKmh, makeUniformWindZones, type PhysicsParams, type ProcessedPoint, type SectionBreakpoint, type FatigueParams } from '@physics-core';
import type { Route } from '@shared-schema';
import { useDataStore } from '../lib/DataStoreContext.js';
import { useSectionPlan } from '../hooks/useSectionPlan.js';
import { parseActivityText, type ActivityTrackPoint } from '../activity/parseActivityFile.js';
import { buildActivityDisplay, remapElevationFromRoute, fillMissingElevation } from '../activity/buildActivityDisplay.js';
import { buildCdaSamples } from '../activity/activitySamples.js';
import { computePlanVsActualSections, computePlanVsActualFineGrid, padSeriesToRouteEdges, isLikelyBraking, type PlanVsActualSectionRow } from '../lib/planVsActual.js';
import type { FineSegment } from '../lib/pacingActions.js';
import { formatTime, formatDeltaTime } from '../lib/formatTime.js';
import { planVsActualSectionsToCsv, planVsActualFineGridToCsv, planVsActualFineGridComparisonToCsv, energyBalanceToCsv, energyBalanceComparisonToCsv, downloadTextFile } from '../lib/exportCsv.js';
import { computeActivityEnergyBalance, summarizeEnergyBalanceComparison } from '../lib/energyBalance.js';
import { WeatherPanel } from './WeatherPanel.js';
import { HistoricalWindImport } from './HistoricalWindImport.js';
import { hourlyToWindTimeSamples, type WeatherAverageWindow, type OpenMeteoHourlyPoint } from '../lib/openMeteo.js';
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
  /** CP/W' (D48), sollevati a livello di app — vedi nota in `RouteSplitterApp.tsx`. Servono sia
   * al pannello microsezioni qui sotto (stesso `PacingOptimizerPanel` di Tab 1) sia ai due
   * `ActivityElevationChart` di questa vista (curva W'bal sullo stream di potenza reale). */
  criticalPowerW: number | '';
  onCriticalPowerWChange: (v: number | '') => void;
  wPrimeJ: number | '';
  onWPrimeJChange: (v: number | '') => void;
}

// Riferimento stabile per "nessun breakpoint" nel pannello microsezioni: un literal `[]`
// inline verrebbe ricreato a ogni render, e siccome ActivityElevationChart ha `breakpoints`
// nel dependency array del suo useEffect di disegno, una nuova identità ad ogni render
// forzava lo smontaggio/ricostruzione COMPLETA del grafico (incl. l'hover) a ogni singolo
// movimento del mouse — proprio nel pannello dove l'hover doveva restare stabile.
const NO_BREAKPOINTS: SectionBreakpoint[] = [];

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
export function PlanVsActualView({ physicsParams, onPhysicsParamsChange, criticalPowerW, onCriticalPowerWChange, wPrimeJ, onWPrimeJChange }: PlanVsActualViewProps) {
  const store = useDataStore();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [routePoints, setRoutePoints] = useState<ProcessedPoint[] | null>(null);

  // Vedi nota nei props: CP/W' sono sollevati a livello di app (RouteSplitterApp), qui solo
  // derivati nella forma che serve a `optimizePacingDynamic`/`ActivityElevationChart`.
  const fatigue: FatigueParams | undefined = useMemo(
    () =>
      criticalPowerW !== '' && wPrimeJ !== '' && criticalPowerW > 0 && wPrimeJ > 0
        ? { criticalPowerW, wPrimeJ }
        : undefined,
    [criticalPowerW, wPrimeJ]
  );

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
    importWindTimeSamples,
    updateWindTimeSample,
    removeWindTimeSample,
    resetWindZones,
    setPlannedStartTime,
    setSmoothingWindowMeters
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
  // Istante reale di partenza dell'attività (D55) — serve solo per interrogare Open-Meteo
  // (D57) con la data giusta, nessun altro uso in questa vista.
  const [activityStartIso, setActivityStartIso] = useState<string | null>(null);
  const [weatherResult, setWeatherResult] = useState<WeatherAverageWindow | null>(null);
  // Serie oraria grezza dell'ultimo fetch riuscito (D61) — usata SOLO per importare il vento
  // come veri WindTimeSample nella zona selezionata; il confronto api on/off sotto usa invece
  // `weatherResult` (già mediato) e non ha bisogno della serie completa.
  const [weatherHourly, setWeatherHourly] = useState<OpenMeteoHourlyPoint[] | null>(null);
  // Snapshot di densità aria + vento (scalare, D57/D58) "di partenza", congelato nell'ISTANTE
  // del fetch meteo riuscito — NON letto in diretta da `physicsParams` al momento del
  // confronto/export: se nel frattempo si preme "Applica densità", quel valore diventerebbe
  // uguale a quello meteo e il confronto collasserebbe a "0 di differenza ovunque" (bug reale,
  // scoperto da un CSV esportato con densità identiche su tutte le 1284 righe, 2026-09-11).
  // Congelandolo qui il confronto resta valido "prima vs dopo" indipendentemente da cosa si fa
  // più tardi con i pulsanti "Applica".
  const [preWeatherSnapshot, setPreWeatherSnapshot] = useState<{ airDensity: number; windKmh: number } | null>(null);
  // Toggle "vedi confronto riga per riga" (D58) — stesso principio di "Verifica dati" per le
  // altre tabelle: spento di default, la tabella (fino a migliaia di righe, una per secondo)
  // si costruisce solo quando l'atleta la chiede davvero.
  const [showWeatherComparisonTable, setShowWeatherComparisonTable] = useState(false);
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
  // dimostrerebbe le sezioni realmente scelte. Unica fonte di verità: plan.smoothingWindowMeters.
  const microStepKm = Math.max(10, plan?.smoothingWindowMeters ?? 50) / 1000;
  const [microHoverPoint, setMicroHoverPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [microSmoothingRadiusMeters, setMicroSmoothingRadiusMeters] = useState(50);

  // Bilancio energetico secondo-per-secondo (ipotesi inerzia, 2026-08-30): a differenza del
  // confronto a bin sopra, qui NON si assume equilibrio stazionario — si verifica se potenza
  // pedalata meno resistenze note spiega la variazione di velocità REALE misurata a cadenza
  // nativa. Calcolato solo a pannello aperto (stesso gating di microGrid: nessun costo se
  // non richiesto), indipendente dal passo microsezioni (qui la "griglia" è temporale, non
  // spaziale). Vedi `src/lib/energyBalance.ts` per il perché dei default.
  const [energyOpen, setEnergyOpen] = useState(false);
  const [energySmoothingSeconds, setEnergySmoothingSeconds] = useState(3);

  // Notifica informativa (non un errore) dopo "Crea percorso da questo file", per il caso di
  // deduplica sotto — niente a che fare con `errorMsg`, che ha un altro stile visivo e un
  // altro significato (qualcosa è andato storto).
  const [createRouteNotice, setCreateRouteNotice] = useState<string | null>(null);

  const refreshRoutes = useCallback(() => store.routes.listByAthlete(null).then(setRoutes), [store]);

  useEffect(() => {
    void refreshRoutes();
  }, [refreshRoutes]);
  useEffect(() => {
    if (!selectedRouteId) {
      setRoutePoints(null);
      return;
    }
    void store.routes.getPoints(selectedRouteId).then(pts => setRoutePoints(pts ? processRoute(pts).points : null));
  }, [store, selectedRouteId]);

  const defaultPowerWatts = plan?.defaultPowerWatts ?? 250;

  // Sezioni del PIANO (non del confronto) — servono a ElevationChart/StatsRow, esattamente
  // come nella tab "Percorso": SEMPRE dal motore dinamico (D43, un solo motore in tutta
  // l'app, nessun toggle).
  const sections = useMemo(() => {
    if (!plan || !routePoints || routePoints.length < 2) return [];
    return computeDynamicSections(
      plan.breakpoints,
      routePoints,
      physicsParams,
      plan.calcMode,
      defaultPowerWatts,
      plan.windZones,
      parseClockTimeToMinutes(plan.plannedStartTime),
      plan.smoothingWindowMeters
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
    setCreateRouteNotice(null);
    setActivityPoints(null);
    setFileName(file.name);
    setActivityStartIso(null);
    setWeatherResult(null);
    setWeatherHourly(null);
    setPreWeatherSnapshot(null);
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
      setActivityStartIso(parsed.startTimeIso);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Errore durante la lettura del file.');
    } finally {
      setBusy(false);
    }
  };

  // D68: crea un Route vero e persistito usando la traccia GPS della stessa uscita reale
  // appena caricata sopra, invece di richiedere che un percorso sia già stato pianificato
  // (via GPX) in tab "Percorso" prima di poter fare qualunque confronto qui. Stessa identica
  // chiamata di creazione di un percorso da GPX (`RouteSplitterApp.tsx`, upload GPX in tab
  // "Percorso") — cambia solo la provenienza dei punti (traccia dell'attività invece che
  // file GPX separato) — quindi il risultato è un percorso a tutti gli effetti: appare anche
  // in tab "Percorso", vi si costruisce sopra un piano vero (breakpoint, target, zone vento)
  // con gli stessi identici controlli già presenti qui sotto, nessuna via ridotta.
  const createRouteFromActivity = useCallback(async () => {
    if (!activityPoints) return;
    setBusy(true);
    setErrorMsg(null);
    setCreateRouteNotice(null);
    try {
      const rawPoints = fillMissingElevation(activityPoints);
      if (rawPoints.length < 2) {
        setErrorMsg('Traccia GPS insufficiente in questo file per crearci un percorso (servono almeno 2 punti con coordinate valide).');
        return;
      }
      const processed = processRoute(rawPoints);

      // Deduplica (stesso file ricaricato più volte, es. per ricontrollare un'analisi): se un
      // percorso con lo stesso nome file sorgente e la stessa distanza (tolleranza 50m, come
      // il controllo di coerenza export/import in RouteSplitterApp.tsx) esiste già, lo si
      // riusa invece di crearne un altro — altrimenti ogni ricarica dello stesso FIT
      // accumulerebbe un percorso duplicato in lista.
      const existing =
        fileName != null
          ? routes.find(r => r.sourceFileName === fileName && Math.abs(r.distanceKm - processed.distanceKm) < 0.05)
          : undefined;
      if (existing) {
        setSelectedRouteId(existing.id);
        setCreateRouteNotice(`Percorso già esistente da questo file ("${existing.name}") — selezionato quello, non ne ho creato uno nuovo.`);
        return;
      }

      const route = await store.routes.create(
        {
          athleteId: null,
          name: (fileName ?? 'uscita').replace(/\.(fit|tcx|gpx)$/i, ''),
          sourceFileName: fileName ?? undefined,
          distanceKm: processed.distanceKm,
          elevationGain: processed.elevationGain,
          elevationLoss: processed.elevationLoss,
          maxElevation: processed.maxElevation,
          minElevation: processed.minElevation
        },
        rawPoints
      );
      await refreshRoutes();
      setSelectedRouteId(route.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Errore durante la creazione del percorso da questo file.');
    } finally {
      setBusy(false);
    }
  }, [activityPoints, fileName, routes, store, refreshRoutes]);

  const effectiveActivityPoints = useMemo(() => {
    if (!activityPoints) return null;
    if (elevationSource === 'route' && routePoints) return remapElevationFromRoute(activityPoints, routePoints);
    return activityPoints;
  }, [activityPoints, elevationSource, routePoints]);

  const display = useMemo(() => (effectiveActivityPoints ? buildActivityDisplay(effectiveActivityPoints) : null), [effectiveActivityPoints]);

  // Bilancio energetico secondo-per-secondo (ipotesi inerzia, 2026-08-30): a differenza del
  // confronto a bin sopra, qui NON si assume equilibrio stazionario — si verifica se potenza
  // pedalata meno resistenze note spiega la variazione di velocità REALE misurata a cadenza
  // nativa. Calcolato solo a pannello aperto (stesso gating di microGrid: nessun costo se
  // non richiesto), indipendente dal passo microsezioni (qui la "griglia" è temporale, non
  // spaziale). Vedi `src/lib/energyBalance.ts` per il perché dei default.
  const energyBalanceRows = useMemo(() => {
    if (!energyOpen || !display) return [];
    return computeActivityEnergyBalance(display.points, physicsParams, { smoothingSeconds: energySmoothingSeconds });
  }, [energyOpen, display, physicsParams, energySmoothingSeconds]);

  // Riepilogo minimo per capire a colpo d'occhio se vale la pena scaricare il CSV: mediana
  // del residuo (robusta a poche frenate estreme che sposterebbero molto la media) e quota
  // di intervalli con un residuo fortemente negativo (soglia -50W, indicativa: energia persa
  // che nessuna resistenza nota spiega — frenata quasi certa, non errore di modello).
  const energySummary = useMemo(() => {
    if (energyBalanceRows.length === 0) return null;
    const sorted = [...energyBalanceRows].map(r => r.residualPowerW).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const likelyBrakingCount = sorted.filter(w => w < -50).length;
    return { n: energyBalanceRows.length, medianResidualW: median, likelyBrakingCount };
  }, [energyBalanceRows]);

  // Confronto "api on/off" (D57): stesso bilancio energetico, ricalcolato UNA VOLTA in più con
  // la densità dell'aria E il vento impliciti dal meteo storico al posto di quelli attualmente
  // impostati — mai al posto del calcolo "vero" sopra (che resta quello che guida tutto il
  // resto della vista), solo per rispondere empiricamente a "questo dato aiuta o no?".
  const weatherAirDensity = useMemo(
    () =>
      weatherResult?.temperatureC != null && weatherResult?.surfacePressureHPa != null
        ? computeAirDensity(weatherResult.temperatureC, weatherResult.surfacePressureHPa)
        : null,
    [weatherResult]
  );

  // Bearing medio (pesato per distanza) dell'intera uscita — serve a proiettare il vento
  // meteo (velocità+direzione) su un UNICO scalare headwind, perché il bilancio energetico
  // accetta solo `params.windKmh` come scalare per tutta l'attività, non per-zona (limite
  // noto, vedi `energyBalance.ts`). Un'approssimazione onesta: un'uscita con cambi di
  // direzione importanti (a U, ad anello) avrà un vento "medio" meno rappresentativo di
  // qualunque punto specifico — informativo per validare densità/vento nel complesso, non un
  // sostituto della stima per-sezione già disponibile altrove.
  const meanBearingDeg = useMemo(
    () => (effectiveActivityPoints ? distanceWeightedMeanBearingDeg(effectiveActivityPoints) : null),
    [effectiveActivityPoints]
  );

  const weatherEffectiveWindKmh = useMemo(
    () =>
      weatherResult?.windSpeedKmh != null && weatherResult?.windDirectionDeg != null && meanBearingDeg != null
        ? effectiveHeadwindKmh(weatherResult.windSpeedKmh, weatherResult.windDirectionDeg, meanBearingDeg)
        : null,
    [weatherResult, meanBearingDeg]
  );

  const energyBalanceRowsWithWeather = useMemo(() => {
    if (!energyOpen || !display || weatherAirDensity == null) return [];
    const weatherParams: PhysicsParams = {
      ...physicsParams,
      airDensity: weatherAirDensity,
      windKmh: weatherEffectiveWindKmh ?? physicsParams.windKmh
    };
    return computeActivityEnergyBalance(display.points, weatherParams, { smoothingSeconds: energySmoothingSeconds });
  }, [energyOpen, display, physicsParams, weatherAirDensity, weatherEffectiveWindKmh, energySmoothingSeconds]);

  // "Prima" del confronto: lo snapshot congelato al momento del fetch (vedi commento su
  // `preWeatherSnapshot`), NON i valori live — altrimenti dopo "Applica densità" le due righe
  // diventerebbero identiche e il confronto perderebbe senso.
  const energyBalanceRowsBaseline = useMemo(() => {
    if (!energyOpen || !display || preWeatherSnapshot == null) return energyBalanceRows;
    return computeActivityEnergyBalance(display.points, { ...physicsParams, ...preWeatherSnapshot }, { smoothingSeconds: energySmoothingSeconds });
  }, [energyOpen, display, physicsParams, preWeatherSnapshot, energySmoothingSeconds, energyBalanceRows]);

  const energyComparisonSummary = useMemo(
    () => (weatherAirDensity != null ? summarizeEnergyBalanceComparison(energyBalanceRowsBaseline, energyBalanceRowsWithWeather) : null),
    [energyBalanceRowsBaseline, energyBalanceRowsWithWeather, weatherAirDensity]
  );

  // Tempo previsto dal PIANO, api on/off (D62): la domanda che conta davvero in un'app che
  // serve a predire il tempo — non solo "il residuo cambia" ma "quanto cambia il tempo
  // previsto se uso le condizioni meteo storiche invece di quelle attuali". Stesso motore
  // (`computeDynamicSections`) già usato per `sections` sopra, ricalcolato con densità/vento
  // meteo al posto di quelli correnti — mai al posto del calcolo vero che guida il resto della
  // vista.
  const weatherWindZonesPreview = useMemo(() => {
    if (!plan || !weatherHourly || !activityStartIso || !display) return null;
    const zoneId = sortedWindZones[activeWindZoneIndex]?.id;
    if (!zoneId) return null;
    const samples = hourlyToWindTimeSamples(weatherHourly, activityStartIso, display.durationSec / 3600);
    if (samples.length === 0) return null;
    return plan.windZones.map(z =>
      z.id === zoneId ? { ...z, timeSamples: samples.slice(0, 12).map((s, i) => ({ id: `preview-${i}`, ...s })) } : z
    );
  }, [plan, weatherHourly, activityStartIso, display, sortedWindZones, activeWindZoneIndex]);

  const sectionsWithWeather = useMemo(() => {
    if (!plan || !routePoints || routePoints.length < 2 || weatherAirDensity == null) return [];
    return computeDynamicSections(
      plan.breakpoints,
      routePoints,
      { ...physicsParams, airDensity: weatherAirDensity },
      plan.calcMode,
      defaultPowerWatts,
      weatherWindZonesPreview ?? plan.windZones,
      parseClockTimeToMinutes(plan.plannedStartTime),
      plan.smoothingWindowMeters
    );
  }, [plan, routePoints, weatherAirDensity, weatherWindZonesPreview, physicsParams, defaultPowerWatts]);

  const plannedTimeBaselineH = useMemo(() => sections.reduce((sum, s) => sum + s.timeHours, 0), [sections]);
  const plannedTimeWeatherH = useMemo(
    () => (sectionsWithWeather.length > 0 ? sectionsWithWeather.reduce((sum, s) => sum + s.timeHours, 0) : null),
    [sectionsWithWeather]
  );

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
      cdaBuilt.samples,
      plan.smoothingWindowMeters
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
      cdaBuilt.samples,
      undefined,
      plan.smoothingWindowMeters
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
  // (plan.smoothingWindowMeters) — calcolata solo quando il pannello è aperto (nessun costo se
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
      microStepKm,
      plan.smoothingWindowMeters
    );
  }, [microOpen, plan, routePoints, physicsParams, display, cdaBuilt, microStepKm]);

  // D71: confronto "con/senza meteo" alla stessa risoluzione a microsezioni, per rispondere in
  // un colpo solo sia a "quanto perdo su curve/frenate" (colonne invariate rispetto a
  // `microGrid`) sia a "il meteo storico aiuta qui?" — stesso principio già usato per il
  // bilancio energetico (`energyBalanceRowsBaseline`/`WithWeather`), ma qui il vento non è
  // uno scalare: bisogna ricostruire `windZones` alternative, non solo `physicsParams`.
  // "Senza meteo" = le zone vento ATTUALI del piano (`plan.windZones`, qualunque cosa
  // l'utente abbia impostato a mano), con solo la densità congelata al preWeatherSnapshot per
  // restare un confronto stabile anche se `physicsParams.airDensity` cambia dopo (stesso
  // motivo dietro `energyBalanceRowsBaseline`).
  const microGridWeatherBaseline = useMemo(() => {
    if (!microOpen || !plan || !routePoints || !display || !cdaBuilt || preWeatherSnapshot == null) return microGrid;
    return computePlanVsActualFineGrid(
      plan.breakpoints,
      routePoints,
      { ...physicsParams, ...preWeatherSnapshot },
      plan.calcMode,
      plan.defaultPowerWatts,
      plan.windZones,
      display.distanceKm,
      cdaBuilt.samples,
      microStepKm,
      plan.smoothingWindowMeters
    );
  }, [microOpen, plan, routePoints, physicsParams, display, cdaBuilt, microStepKm, preWeatherSnapshot, microGrid]);

  // "Con meteo" = UNA zona vento uniforme per tutto il percorso, costruita dal vettore
  // vento+direzione di Open-Meteo (non dallo scalare `weatherEffectiveWindKmh` già proiettato
  // sul bearing medio — qui, a differenza del bilancio energetico, il motore può usare il
  // vettore vero per bin, tenendo conto della rotta reale punto per punto: più corretto, non
  // un'approssimazione in più).
  const weatherUniformWindZones = useMemo(() => {
    if (weatherResult?.windSpeedKmh == null || weatherResult?.windDirectionDeg == null || !display) return null;
    return makeUniformWindZones(display.distanceKm, weatherResult.windSpeedKmh, weatherResult.windDirectionDeg);
  }, [weatherResult, display]);

  const microGridWithWeather = useMemo(() => {
    if (!microOpen || !plan || !routePoints || !display || !cdaBuilt || weatherAirDensity == null || !weatherUniformWindZones) return [];
    return computePlanVsActualFineGrid(
      plan.breakpoints,
      routePoints,
      { ...physicsParams, airDensity: weatherAirDensity },
      plan.calcMode,
      plan.defaultPowerWatts,
      weatherUniformWindZones,
      display.distanceKm,
      cdaBuilt.samples,
      microStepKm,
      plan.smoothingWindowMeters
    );
  }, [microOpen, plan, routePoints, physicsParams, display, cdaBuilt, microStepKm, weatherAirDensity, weatherUniformWindZones]);

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
  // STESSA fisica (pendenza, vento, CdA, motore dinamico) della velocità pianificata,
  // sostituendo solo la potenza in ingresso con quella reale di quel bin.
  const [microVerifyMode, setMicroVerifyMode] = useState<'planned' | 'verified'>('planned');

  // D74: risultato fine di "Ottimizza completo" (potenza per bin da 50m, non collassata sulle
  // sezioni) sollevato da PacingOptimizerPanel — permette al grafico microsezioni qui sotto di
  // mostrare la curva VERA trovata dall'ottimizzatore invece di quella piatta/a gradini
  // ricavata dai breakpoint (che è tutto ciò che `microPlannedPowerSeries` può vedere, dato
  // che il piano stesso non conosce nulla di più fine dei suoi breakpoint). Reset esplicito al
  // cambio percorso: stato di lavoro non persistito, mostrare quello di un percorso diverso
  // sarebbe silenziosamente fuorviante.
  const [finePlan, setFinePlan] = useState<{ segs: FineSegment[]; powers: number[] } | null>(null);
  useEffect(() => {
    setFinePlan(null);
  }, [selectedRouteId]);
  const finePlanPowerSeries = useMemo(
    () => (finePlan ? finePlan.segs.map((s, i) => ({ distKm: (s.d0Km + s.d1Km) / 2, powerWatts: finePlan.powers[i]! })) : null),
    [finePlan]
  );
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
  const microDisplayPowerSeries = microVerifyMode === 'planned' ? microPlannedPowerSeries : microVerifiedPowerSeries;
  const microDisplaySpeedSeries = microVerifyMode === 'verified' ? microVerifiedSpeedSeries : microPlannedSpeedSeries;
  const microSectionsWithRealPower = useMemo(() => microGrid.filter(p => p.actualPowerWatts != null).length, [microGrid]);
  // Bin segnalati come "probabile frenata" (F3.13): non un errore di modello, il rider sta
  // decelerando volontariamente (curve, fondo tecnico) — vedi isLikelyBraking in planVsActual.ts
  // per la soglia. Calcolato su microGrid (dati grezzi), non su microDisplayGrid, perché il
  // flag deve restare lo stesso indipendentemente dal toggle "Verifica dati" della tabella.
  const microBrakingCount = useMemo(
    () => microGrid.filter((p, i) => isLikelyBraking(p, i > 0 ? microGrid[i - 1] : null)).length,
    [microGrid]
  );
  // Validazione dell'ipotesi curvatura (F3.15, 2026-08-31): fra i bin "probabile frenata",
  // quanti hanno una velocità reale coerente con un limite di curva stimato dal percorso
  // (non con un errore di modello)? Margine 15% oltre il limite fisico stimato: μ e finestra
  // di stima sono approssimazioni, non un vincolo esatto — un piccolo margine evita di
  // scartare come "non spiegati da curva" bin che in realtà lo sono, per un errore di stima.
  const microBrakingCurveMatch = useMemo(() => {
    const flagged = microGrid.filter((p, i) => isLikelyBraking(p, i > 0 ? microGrid[i - 1] : null));
    if (flagged.length === 0) return null;
    const matching = flagged.filter(p => p.actualSpeedKmh != null && Number.isFinite(p.maxCorneringSpeedKmh) && p.actualSpeedKmh <= p.maxCorneringSpeedKmh * 1.15).length;
    return { flagged: flagged.length, matching };
  }, [microGrid]);
  // BUG SEGNALATO: la tabella delle microsezioni leggeva `microGrid` direttamente
  // (plannedSpeedKmh/plannedPowerWatts sempre del PIANO), quindi non si aggiornava affatto
  // quando si attivava "Verifica dati" — il grafico sopra cambiava, la tabella sotto no.
  // Stesso principio di displayRows più sopra (sezioni custom): un'unica trasformazione
  // "effettiva" applicata PRIMA sia al grafico (le serie microDisplay*Series qui sopra) sia
  // alla tabella, così i due non possono più disallinearsi.
  const microDisplayGrid = useMemo(() => {
    return microGrid.map(p => {
      const hasVerified = microVerifyMode === 'verified' && p.actualPowerWatts != null && p.verifiedSpeedKmh != null;
      const plannedSpeedKmh = hasVerified ? p.verifiedSpeedKmh! : p.plannedSpeedKmh;
      const plannedPowerWatts = hasVerified ? p.actualPowerWatts! : p.plannedPowerWatts;
      return { ...p, plannedSpeedKmh, plannedPowerWatts, isVerified: hasVerified };
    });
  }, [microGrid, microVerifyMode]);
  // Etichetta condivisa da grafico/tabella per la modalità corrente — un solo posto dove
  // decidere il testo, invece di ripetere lo stesso ternario in 5 punti diversi della JSX.
  const microModeLabel = microVerifyMode === 'verified' ? 'Verif.' : 'Pian.';
  const microModeChartLabel =
    microVerifyMode === 'verified' ? 'verificata (potenza reale)' : finePlanPowerSeries ? "ottimizzata a 50m ('Ottimizza completo')" : 'pianificata';
  // Preferisce la curva fine vera (se è stata appena calcolata con "Ottimizza completo" in
  // questa sessione) a quella ricavata dai breakpoint — quest'ultima è tutto ciò che il piano
  // "sa" quando non è appena stato ottimizzato, e può essere piatta o a gradini a seconda di
  // quante sezioni/potenze diverse ha il piano (D74).
  const microChartPlannedPowerSeries = microVerifyMode === 'planned' && finePlanPowerSeries ? finePlanPowerSeries : microDisplayPowerSeries;

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
          {activityPoints && (
            <button type="button" className="btn btn-sm ghost" onClick={() => void createRouteFromActivity()} disabled={busy}>
              🆕 Crea percorso da questo file
            </button>
          )}
        </div>
        {activityPoints && (
          <p className="physics-hint pva-create-route-hint">
            Niente GPX a portata di mano? Il pulsante qui sopra crea un percorso vero (appare anche in tab "Percorso")
            usando la traccia GPS di questo stesso file — poi ci costruisci sopra un piano come faresti con un GPX,
            oppure lasci solo partenza/arrivo e vai dritto al confronto qui sotto con "Verifica dati".
          </p>
        )}
        {errorMsg && <p className="app-error">{errorMsg}</p>}
        {createRouteNotice && <p className="wind-panel-hint">ℹ️ {createRouteNotice}</p>}
        {!selectedRoute && (
          <p className="wind-panel-hint">
            Seleziona un percorso per iniziare a modificare il piano, oppure caricane uno qui sopra e crealo da quel
            file (nessun GPX necessario).
          </p>
        )}
      </div>

      {selectedRoute && plan && routePoints && routePoints.length > 1 && (
        <>
          <div className="pva-group-divider">🛠️ Configura il piano</div>

          <CollapsibleSection title="📈 Statistiche percorso">
            <StatsRow route={selectedRoute} sections={sections} />
          </CollapsibleSection>

          <CollapsibleSection title="⚙️ Parametri fisici">
            <PhysicsParamsPanel params={physicsParams} onChange={onPhysicsParamsChange} calcMode={plan.calcMode} onCalcModeChange={mode => void setCalcMode(mode)} />
          </CollapsibleSection>

          <CollapsibleSection title="💨 Zone vento">
            <HistoricalWindImport
              latitude={effectiveActivityPoints?.[0]?.lat ?? null}
              longitude={effectiveActivityPoints?.[0]?.lon ?? null}
              startTimeIso={activityStartIso}
              durationHours={display ? display.durationSec / 3600 : 0}
              targetZoneId={sortedWindZones[activeWindZoneIndex]?.id ?? null}
              targetZoneLabel={sortedWindZones[activeWindZoneIndex] ? `${sortedWindZones[activeWindZoneIndex]!.distKm.toFixed(1)} km` : null}
              plannedStartTimeMissing={plan.plannedStartTime == null}
              onImport={(zoneId, samples) => importWindTimeSamples(zoneId, samples)}
            />
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
              onUpdateTimeSample={(zoneId, sampleId, minuteOfDay, speedKmh, directionDeg) =>
                void updateWindTimeSample(zoneId, sampleId, minuteOfDay, speedKmh, directionDeg)
              }
              onRemoveTimeSample={(zoneId, sampleId) => void removeWindTimeSample(zoneId, sampleId)}
              onSetTimeSamplesEnabled={(zoneId, enabled) => void updateWindZone(zoneId, { timeSamplesEnabled: enabled })}
              windControl={windControl}
            />
          </CollapsibleSection>

          <CollapsibleSection title="🎯 Ottimizzatore di pacing">
            <PacingOptimizerPanel
              breakpoints={plan.breakpoints}
              processedPoints={routePoints}
              physicsParams={physicsParams}
              totalDistanceKm={selectedRoute.distanceKm}
              windZones={plan.windZones}
              onApplyPowers={updates => void applyPowerUpdates(updates)}
              smoothingWindowMeters={plan.smoothingWindowMeters}
              onSmoothingWindowMetersChange={v => void setSmoothingWindowMeters(v)}
              plannedStartMinuteOfDay={parseClockTimeToMinutes(plan.plannedStartTime)}
              criticalPowerW={criticalPowerW}
              onCriticalPowerWChange={onCriticalPowerWChange}
              wPrimeJ={wPrimeJ}
              onWPrimeJChange={onWPrimeJChange}
              onFinePlanChange={setFinePlan}
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

          <div className="pva-group-divider">
            🔎 Confronto con l'uscita reale
            <p className="physics-hint pva-group-divider-hint">
              Quattro viste via via più dettagliate, in quest'ordine: <strong>per sezione</strong> usa le tue sezioni manuali (il confronto
              principale) · <strong>vento</strong> isola solo l'errore di direzione/intensità · <strong>microsezioni</strong> ripete lo
              stesso confronto su una griglia fine automatica invece delle tue sezioni · <strong>bilancio energetico</strong> scende al
              secondo-per-secondo includendo l'inerzia (frenate, accelerazioni) e ci mette anche il meteo storico.
            </p>
          </div>

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
                <p className="physics-hint">
                  Riepilogo (tempo/velocità/potenza) in "Risultato in breve" in cima alla pagina — si aggiorna con questo toggle. Qui sotto il
                  dettaglio sezione per sezione.
                </p>
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
                    fatigue={fatigue}
                  />
                </div>
              </div>

              <div className="pva-export-row">
                <button
                  type="button"
                  className="btn btn-sm ghost"
                  onClick={() => downloadTextFile(`confronto_sezioni_${safeRouteName}.csv`, planVsActualSectionsToCsv(rows), 'text/csv')}
                  title="Esporta questa tabella (dati grezzi, non filtrati da 'Verifica dati') in CSV: una riga per sezione manuale, pianificato+reale+delta"
                >
                  ⬇️ Esporta CSV — per sezione
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
                    <label className="stream-toggle" style={{ marginLeft: '1rem' }} title="Mostra, al posto della linea pianificata, la velocità che il motore dinamico predice usando la potenza REALE registrata in ogni microsezione — per vedere dove il modello fisico sovrastima/sottostima, isolato dalla scelta di pacing.">
                      <input
                        type="checkbox"
                        checked={microVerifyMode === 'verified'}
                        onChange={e => setMicroVerifyMode(e.target.checked ? 'verified' : 'planned')}
                      />
                      🔍 Verifica dati ({microSectionsWithRealPower} microsezioni con potenza reale)
                    </label>
                  )}
                  {microBrakingCount > 0 && (
                    <span
                      className="pva-micro-active-label"
                      style={{ marginLeft: '1rem' }}
                      title="Bin in discesa dove la velocità reale è molto più bassa di quanto il modello preveda usando la potenza reale — quasi certamente frenata (curve, fondo tecnico), non un errore del modello. Segnalati anche in tabella e nel CSV."
                    >
                      🛑 {microBrakingCount} probabile frenata
                      {microBrakingCurveMatch && ` (${microBrakingCurveMatch.matching}/${microBrakingCurveMatch.flagged} coerenti con una curva stimata dal percorso)`}
                    </span>
                  )}
                </div>

                {microSummary && (
                  <div className="pva-summary-grid">
                    <div className="pva-summary-header">
                      <span></span>
                      <span>{microModeLabel}</span>
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
                      plannedPowerSeries={microChartPlannedPowerSeries}
                      plannedSpeedSeries={microDisplaySpeedSeries}
                      plannedPowerLabel={microModeChartLabel}
                      plannedSpeedLabel={microModeChartLabel}
                      fatigue={fatigue}
                    />
                  </div>
                </div>

                <div className="pva-export-row">
                  <button
                    type="button"
                    className="btn btn-sm ghost"
                    onClick={() =>
                      downloadTextFile(`confronto_microsezioni_${safeRouteName}.csv`, planVsActualFineGridToCsv(microGrid, physicsParams, plan.windZones), 'text/csv')
                    }
                    title="Esporta questa tabella (dati grezzi, non filtrati da 'Verifica dati', include pendenza e quota per bin) in CSV: griglia fine automatica, utile per correlare l'errore a un punto preciso del percorso"
                  >
                    ⬇️ Esporta CSV — microsezioni
                  </button>
                  {weatherAirDensity != null && weatherResult?.windSpeedKmh != null && weatherResult?.windDirectionDeg != null && (
                    <button
                      type="button"
                      className="btn btn-sm ghost"
                      onClick={() =>
                        downloadTextFile(
                          `confronto_microsezioni_confronto_meteo_${safeRouteName}.csv`,
                          planVsActualFineGridComparisonToCsv(
                            microGridWeatherBaseline,
                            microGridWithWeather,
                            preWeatherSnapshot?.airDensity ?? physicsParams.airDensity,
                            { airDensity: weatherAirDensity, windKmh: weatherResult.windSpeedKmh!, windDirectionDeg: weatherResult.windDirectionDeg! },
                            physicsParams,
                            plan.windZones
                          ),
                          'text/csv'
                        )
                      }
                      title="Come sopra ma con due colonne affiancate — verificata senza e con il vento/densità storici da Open-Meteo — per capire in un colpo solo sia dove si perde su curve/frenate sia se il meteo storico avvicina o allontana il modello dai dati"
                    >
                      ⬇️ Esporta CSV — microsezioni + confronto meteo
                    </button>
                  )}
                </div>

                <div className="sections-table-wrap pva-micro-table-wrap">
                  <table className="sections-table pva-micro-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Tratto (km)</th>
                        <th>Pend.</th>
                        <th>Vel. {microModeLabel === 'Pian.' ? 'pian.' : 'verif.'}</th>
                        <th>Vel. reale</th>
                        <th>Δ vel.</th>
                        <th>Pot. {microModeLabel === 'Pian.' ? 'pian.' : 'verif.'}</th>
                        <th>Pot. reale</th>
                        <th>Δ pot.</th>
                        <th title="Discesa con velocità reale molto più bassa di quanto il modello preveda usando la potenza reale: quasi certamente frenata, non errore di modello">🛑</th>
                      </tr>
                    </thead>
                    <tbody>
                      {microDisplayGrid.map((p, i) => {
                        const deltaSpeedPct = p.actualSpeedKmh != null && p.plannedSpeedKmh > 0 ? ((p.actualSpeedKmh - p.plannedSpeedKmh) / p.plannedSpeedKmh) * 100 : null;
                        const deltaPowerPct =
                          p.actualPowerWatts != null && p.plannedPowerWatts > 0 ? ((p.actualPowerWatts - p.plannedPowerWatts) / p.plannedPowerWatts) * 100 : null;
                        const braking = isLikelyBraking(p, i > 0 ? microDisplayGrid[i - 1] : null);
                        return (
                          <tr key={i} className={braking ? 'pva-row-braking' : undefined}>
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
                            <td>{braking ? '🛑' : ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="⚡ Bilancio energetico (ipotesi inerzia)"
            defaultOpen={false}
            open={energyOpen}
            onToggle={setEnergyOpen}
            collapsedHint="Confronto secondo-per-secondo (non a bin): verifica se potenza pedalata meno resistenze note spiega davvero la variazione di velocità reale misurata, invece di assumere l'equilibrio stazionario usato altrove in questa vista. Serve a isolare l'inerzia (e le frenate) dagli altri errori del modello."
          >
            <div className="physics-panel pva-energy-panel">
              <p className="wind-panel-hint">
                A differenza delle tabelle sopra (che confrontano velocità MEDIE per tratto assumendo l'equilibrio istantaneo), qui ogni riga è un
                intervallo di pochi secondi fra due campioni consecutivi dell'attività — abbastanza breve da NON poter assumere quell'equilibrio.
                Il "residuo" è l'energia cinetica che pedalata + gravità + resistenze note non spiegano: se negativo e concentrato in discesa
                ripida è quasi certamente frenata (non un errore di modello); se sistematico e correlato con l'accelerazione, è il segnale di
                inerzia che stavamo cercando.
              </p>
              <div className="pva-micro-controls">
                <span className="pva-micro-active-label">Smoothing temporale:</span>
                <NumberField value={energySmoothingSeconds} onCommit={v => setEnergySmoothingSeconds(Math.max(0, v))} step={1} min={0} max={15} />
                <span className="pva-micro-active-label">secondi · {energyBalanceRows.length} intervalli</span>
              </div>

              {energySummary && (
                <p className="wind-panel-hint">
                  Residuo mediano: <strong>{Math.round(energySummary.medianResidualW)} W</strong> ·{' '}
                  {energySummary.likelyBrakingCount} intervalli su {energySummary.n} con residuo sotto -50 W (probabile frenata).
                </p>
              )}

              <div className="pva-export-row">
                <button
                  type="button"
                  className="btn btn-sm ghost"
                  disabled={energyBalanceRows.length === 0}
                  onClick={() => downloadTextFile(`bilancio_energetico_${safeRouteName}.csv`, energyBalanceToCsv(energyBalanceRows, physicsParams), 'text/csv')}
                  title="Esporta il bilancio energetico secondo-per-secondo in CSV: una riga per campione reale, con il residuo (potenza non spiegata dal modello — inerzia/frenate)"
                >
                  ⬇️ Esporta CSV — bilancio energetico (secondo per secondo)
                </button>
              </div>

              <div className="pva-weather-comparison">
                <h4>Meteo storico (Open-Meteo) — densità aria e vento "api on" vs "api off"</h4>
                <WeatherPanel
                  latitude={effectiveActivityPoints?.[0]?.lat ?? null}
                  longitude={effectiveActivityPoints?.[0]?.lon ?? null}
                  startTimeIso={activityStartIso}
                  durationHours={display ? display.durationSec / 3600 : 0}
                  physicsParams={physicsParams}
                  onPhysicsParamsChange={onPhysicsParamsChange}
                  windSpeedKmh={windControl?.speedKmh ?? 0}
                  windDirectionDeg={windControl?.directionDeg ?? 0}
                  onWindChange={noop}
                  showApplyWind={false}
                  onResult={result => {
                    setWeatherResult(result);
                    // Congela densità E vento "di partenza" solo su un fetch RIUSCITO (result
                    // non null) — su errore/reset non tocca un eventuale confronto già in corso.
                    if (result) setPreWeatherSnapshot({ airDensity: physicsParams.airDensity, windKmh: physicsParams.windKmh });
                  }}
                  onHourlyResult={setWeatherHourly}
                />

                {weatherAirDensity != null && energyComparisonSummary && (
                  <>
                    <div className="pva-summary-grid">
                      <div className="pva-summary-header">
                        <span></span>
                        <span>Partenza</span>
                        <span>Meteo</span>
                        <span>Δ</span>
                      </div>
                      <div className="pva-summary-row">
                        <span className="pva-summary-label">Tempo previsto (piano)</span>
                        <span className="pva-summary-val">{formatTime(plannedTimeBaselineH)}</span>
                        <span className="pva-summary-val">{plannedTimeWeatherH != null ? formatTime(plannedTimeWeatherH) : '—'}</span>
                        {deltaTimeBadge(plannedTimeWeatherH != null ? plannedTimeWeatherH - plannedTimeBaselineH : null)}
                      </div>
                      <div className="pva-summary-row">
                        <span className="pva-summary-label">Residuo mediano</span>
                        <span className="pva-summary-val">{Math.round(energyComparisonSummary.medianAbsResidualBaselineW)} W</span>
                        <span className="pva-summary-val">{Math.round(energyComparisonSummary.medianAbsResidualWithWeatherW)} W</span>
                        {deltaBadge(
                          ((energyComparisonSummary.medianAbsResidualWithWeatherW - energyComparisonSummary.medianAbsResidualBaselineW) /
                            Math.max(1, energyComparisonSummary.medianAbsResidualBaselineW)) *
                            100,
                          '%',
                          true
                        )}
                      </div>
                      <div className="pva-summary-row">
                        <span className="pva-summary-label">Residuo medio</span>
                        <span className="pva-summary-val">{Math.round(energyComparisonSummary.meanAbsResidualBaselineW)} W</span>
                        <span className="pva-summary-val">{Math.round(energyComparisonSummary.meanAbsResidualWithWeatherW)} W</span>
                        {deltaBadge(
                          ((energyComparisonSummary.meanAbsResidualWithWeatherW - energyComparisonSummary.meanAbsResidualBaselineW) /
                            Math.max(1, energyComparisonSummary.meanAbsResidualBaselineW)) *
                            100,
                          '%',
                          true
                        )}
                      </div>
                      <div className="pva-summary-row">
                        <span className="pva-summary-label">Densità aria</span>
                        <span className="pva-summary-val">{(preWeatherSnapshot?.airDensity ?? physicsParams.airDensity).toFixed(3)} kg/m³</span>
                        <span className="pva-summary-val">{weatherAirDensity.toFixed(3)} kg/m³</span>
                        {deltaBadge(
                          ((weatherAirDensity - (preWeatherSnapshot?.airDensity ?? physicsParams.airDensity)) /
                            (preWeatherSnapshot?.airDensity ?? physicsParams.airDensity)) *
                            100,
                          '%'
                        )}
                      </div>
                      <div className="pva-summary-row">
                        <span className="pva-summary-label">Vento effettivo</span>
                        <span className="pva-summary-val">{(preWeatherSnapshot?.windKmh ?? physicsParams.windKmh).toFixed(1)} km/h</span>
                        <span className="pva-summary-val">{(weatherEffectiveWindKmh ?? physicsParams.windKmh).toFixed(1)} km/h</span>
                        {deltaBadge((weatherEffectiveWindKmh ?? physicsParams.windKmh) - (preWeatherSnapshot?.windKmh ?? physicsParams.windKmh), ' km/h')}
                      </div>
                    </div>
                    <p className="wind-panel-hint">
                      Migliora (|residuo| più basso con il meteo) su {energyComparisonSummary.improvedCount} di {energyComparisonSummary.n}{' '}
                      intervalli ({Math.round((100 * energyComparisonSummary.improvedCount) / energyComparisonSummary.n)}%).
                      {weatherWindZonesPreview == null && (
                        <span> Il tempo previsto "Meteo" qui sopra riflette solo la densità: nessuna zona vento disponibile per il vento storico.</span>
                      )}
                      {Math.abs((preWeatherSnapshot?.airDensity ?? physicsParams.airDensity) - weatherAirDensity) < 0.0005 &&
                        Math.abs((preWeatherSnapshot?.windKmh ?? physicsParams.windKmh) - (weatherEffectiveWindKmh ?? physicsParams.windKmh)) <
                          0.05 && (
                          <span className="app-error">
                            {' '}
                            Densità e vento coincidono: hai già applicato i valori meteo prima di questo fetch, il confronto non è
                            significativo — recupera di nuovo il meteo PRIMA di applicarlo per un confronto valido.
                          </span>
                        )}
                    </p>

                    <div className="pva-export-row">
                      <button type="button" className="btn btn-sm ghost" onClick={() => setShowWeatherComparisonTable(v => !v)}>
                        {showWeatherComparisonTable ? '🔼 Nascondi confronto riga per riga' : '🔍 Vedi confronto riga per riga'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm ghost"
                        onClick={() =>
                          downloadTextFile(
                            `bilancio_energetico_confronto_meteo_${safeRouteName}.csv`,
                            energyBalanceComparisonToCsv(
                              energyBalanceRowsBaseline,
                              energyBalanceRowsWithWeather,
                              preWeatherSnapshot ?? { airDensity: physicsParams.airDensity, windKmh: physicsParams.windKmh },
                              { airDensity: weatherAirDensity, windKmh: weatherEffectiveWindKmh ?? physicsParams.windKmh },
                              physicsParams
                            ),
                            'text/csv'
                          )
                        }
                        title="Esporta il confronto riga per riga fra le condizioni di partenza e quelle dal meteo storico"
                      >
                        ⬇️ Esporta CSV — confronto api on/off
                      </button>
                    </div>

                    {showWeatherComparisonTable && (
                      <div className="sections-table-wrap pva-micro-table-wrap">
                        <table className="sections-table pva-micro-table">
                          <thead>
                            <tr>
                              <th>Tempo (s)</th>
                              <th>Dist. (km)</th>
                              <th>Pend.</th>
                              <th>Vel.</th>
                              <th>Pot.</th>
                              <th>Residuo partenza</th>
                              <th>Residuo meteo</th>
                              <th>Δ |residuo|</th>
                            </tr>
                          </thead>
                          <tbody>
                            {energyBalanceRowsBaseline.map((b, i) => {
                              const w = energyBalanceRowsWithWeather[i];
                              if (!w) return null;
                              const deltaAbs = Math.abs(w.residualPowerW) - Math.abs(b.residualPowerW);
                              return (
                                <tr key={i}>
                                  <td>{b.timeSec.toFixed(0)}</td>
                                  <td>{b.distKm.toFixed(2)}</td>
                                  <td>{b.gradientPct.toFixed(1)}%</td>
                                  <td>{b.speedKmh.toFixed(1)} km/h</td>
                                  <td>{Math.round(b.powerW)} W</td>
                                  <td>{Math.round(b.residualPowerW)} W</td>
                                  <td>{Math.round(w.residualPowerW)} W</td>
                                  <td>{deltaBadge(deltaAbs, 'W', true)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </CollapsibleSection>
        </>
      )}
    </div>
  );
}
