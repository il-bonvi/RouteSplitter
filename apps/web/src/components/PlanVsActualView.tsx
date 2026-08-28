import { useEffect, useMemo, useRef, useState } from 'react';
import { processRoute, computeSections, parseClockTimeToMinutes, type PhysicsParams, type ProcessedPoint } from '@physics-core';
import type { Route } from '@shared-schema';
import { useDataStore } from '../lib/DataStoreContext.js';
import { useSectionPlan } from '../hooks/useSectionPlan.js';
import { parseActivityText, type ActivityTrackPoint } from '../activity/parseActivityFile.js';
import { buildActivityDisplay, remapElevationFromRoute } from '../activity/buildActivityDisplay.js';
import { buildCdaSamples } from '../activity/activitySamples.js';
import { computePlanVsActualSections, computePlanVsActualFineGrid, padSeriesToRouteEdges, type PlanVsActualSectionRow } from '../lib/planVsActual.js';
import { formatTime, formatDeltaTime } from '../lib/formatTime.js';
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

const MICRO_STEP_OPTIONS = [0.1, 0.25, 0.5, 1] as const;

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
    setPlannedStartTime
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
  const [microStepKm, setMicroStepKm] = useState<number>(0.25);
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

  const plannedPowerSeries = useMemo(() => {
    if (!plan || !routePoints || !display || !cdaBuilt) return [];
    const raw = computePlanVsActualFineGrid(
      plan.breakpoints,
      routePoints,
      physicsParams,
      plan.calcMode,
      plan.defaultPowerWatts,
      plan.windZones,
      display.distanceKm,
      cdaBuilt.samples
    ).map(p => ({ distKm: p.distKm, powerWatts: p.plannedPowerWatts }));
    return padSeriesToRouteEdges(raw, display.distanceKm);
  }, [plan, routePoints, physicsParams, display, cdaBuilt]);

  // Griglia a microsezioni: stessa funzione, passo scelto dall'utente — calcolata solo
  // quando il pannello è aperto (nessun costo se non richiesta).
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
  const microBoundariesKm = useMemo(() => microGrid.map(p => p.distKm), [microGrid]);

  const windRows = rows.filter(r => r.actualWindHeadwindKmh != null);

  // Riepilogo compatto (3 righe: velocità/potenza/tempo) sopra la tabella di confronto —
  // medie pesate sul tempo pianificato/reale di ciascuna sezione, non una semplice media
  // aritmetica fra sezioni di lunghezza diversa.
  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    let plannedDistKm = 0;
    let plannedTimeH = 0;
    let plannedPowerTimeWeighted = 0;
    let actualDistKm = 0;
    let actualTimeH = 0;
    let actualPowerTimeWeighted = 0;
    let hasActual = false;
    for (const r of rows) {
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
  }, [rows]);
  const noop = () => {};

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

          <CollapsibleSection title="🗺️ Mappa e altimetria uscita reale">
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
                  plannedPowerSeries={plannedPowerSeries}
                />
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

          <CollapsibleSection title="📊 Confronto per sezione">
            <div className="physics-panel">
            {summary && (
              <div className="pva-summary-grid">
                <div className="pva-summary-header">
                  <span></span>
                  <span>Pian.</span>
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
            <div className="sections-table-wrap">
              <table className="sections-table pva-sections-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Sezione</th>
                    <th>Distanza</th>
                    <th>Velocità pian.</th>
                    <th>Velocità reale</th>
                    <th>Δ vel.</th>
                    <th>Potenza pian.</th>
                    <th>Potenza reale</th>
                    <th>Δ pot.</th>
                    <th>Tempo pian.</th>
                    <th>Tempo reale</th>
                    <th>Δ tempo</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
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

          <CollapsibleSection
            title="🔬 Confronto a microsezioni (griglia automatica)"
            defaultOpen={false}
            open={microOpen}
            onToggle={setMicroOpen}
            collapsedHint="Lo stesso confronto sopra, ma su una griglia automatica ogni X metri invece che sulle sezioni del piano — utile per individuare punti precisi dove la previsione si discosta dai dati reali."
          >
            <div className="physics-panel pva-micro-panel">
                <div className="pva-micro-controls">
                  <span>Passo:</span>
                  {MICRO_STEP_OPTIONS.map(step => (
                    <button
                      key={step}
                      type="button"
                      className={`btn btn-sm ghost${microStepKm === step ? ' active' : ''}`}
                      onClick={() => setMicroStepKm(step)}
                    >
                      {step < 1 ? `${step * 1000} m` : `${step} km`}
                    </button>
                  ))}
                  <span className="pva-micro-active-label">
                    → in uso: {microStepKm < 1 ? `${microStepKm * 1000} m` : `${microStepKm} km`} · {microGrid.length} microsezioni
                  </span>
                </div>

                <div className="gara-zone">
                  <RouteMap
                    points={display.points}
                    smoothingRadiusMeters={microSmoothingRadiusMeters}
                    hoverPoint={microHoverPoint}
                    breakpoints={[]}
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
                      breakpoints={[]}
                      addMode={false}
                      onAddBreakpoint={noop}
                      onRemoveBreakpoint={noop}
                      windZones={plan.windZones}
                      plannedPowerSeries={microPlannedPowerSeries}
                      microBoundariesKm={microBoundariesKm}
                    />
                  </div>
                </div>

                <div className="sections-table-wrap pva-micro-table-wrap">
                  <table className="sections-table pva-micro-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Tratto (km)</th>
                        <th>Pend.</th>
                        <th>Vel. pian.</th>
                        <th>Vel. reale</th>
                        <th>Δ vel.</th>
                        <th>Pot. pian.</th>
                        <th>Pot. reale</th>
                        <th>Δ pot.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {microGrid.map((p, i) => {
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
