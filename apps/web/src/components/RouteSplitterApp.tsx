import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processRoute, computeSections, type ProcessedPoint } from '@physics-core';
import { DEFAULT_PHYSICS_PARAMS, type Route, type RawTrackPoint, type PhysicsParams } from '@shared-schema';
import { useDataStore } from '../lib/DataStoreContext.js';
import { useSectionPlan } from '../hooks/useSectionPlan.js';
import { parseGpxText } from '../gpx/parseGpx.js';
import { downloadTextFile } from '../lib/exportCsv.js';
import { buildSectionsExportPayload, parseSectionsImport } from '../lib/exportImportSections.js';
import { UploadZone } from './UploadZone.js';
import { RouteList } from './RouteList.js';
import { RouteMap } from './RouteMap.js';
import type { MapWindControlData } from './RouteMap.js';
import { StatsRow } from './StatsRow.js';
import { ElevationChart } from './ElevationChart.js';
import { PhysicsParamsPanel } from './PhysicsParamsPanel.js';
import { SectionsTable } from './SectionsTable.js';
import { PacingOptimizerPanel } from './PacingOptimizerPanel.js';
import { CdaEstimator } from './CdaEstimator.js';
import { NumberField } from './NumberField.js';
import { ReportView } from './ReportView.js';
import { WindZonesPanel } from './WindZonesPanel.js';

export function RouteSplitterApp() {
  const store = useDataStore();

  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<RawTrackPoint[] | null>(null);
  const [routeNameDraft, setRouteNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [smoothingRadiusMeters, setSmoothingRadiusMeters] = useState(50);
  const [hoverPoint, setHoverPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [physicsParams, setPhysicsParams] = useState<PhysicsParams>(DEFAULT_PHYSICS_PARAMS);
  const [addMode, setAddMode] = useState(false);
  const [manualKm, setManualKm] = useState(0);
  const [everyKm, setEveryKm] = useState(0.25);
  const [startTime, setStartTime] = useState('');
  const [reportExporting, setReportExporting] = useState(false);
  const [selectedWindZoneId, setSelectedWindZoneId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const processedPoints = useMemo<ProcessedPoint[]>(() => {
    if (!selectedPoints || selectedPoints.length < 2) return [];
    return processRoute(selectedPoints).points;
  }, [selectedPoints]);

  const {
    plan,
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
    resetWindZones
  } = useSectionPlan(selectedRoute?.id ?? null, selectedRoute?.distanceKm ?? 0);

  const defaultPowerWatts = plan?.defaultPowerWatts ?? 250;

  const sections = useMemo(() => {
    if (!plan || processedPoints.length < 2) return [];
    return computeSections(plan.breakpoints, processedPoints, physicsParams, plan.calcMode, defaultPowerWatts, plan.windZones);
  }, [plan, processedPoints, physicsParams, defaultPowerWatts]);

  const sortedWindZones = useMemo(() => [...(plan?.windZones ?? [])].sort((a, b) => a.distKm - b.distKm), [plan?.windZones]);

  const activeWindZoneIndex = useMemo(() => {
    if (sortedWindZones.length < 2) return -1;
    const idx = sortedWindZones.findIndex(z => z.id === selectedWindZoneId && z.fixed !== 'start');
    // Il confine 'start' (indice 0) non porta un proprio vento: se non c'è selezione valida,
    // seleziona di default l'ultima zona (quella che copre l'arrivo).
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

  const refreshRoutes = useCallback(async () => {
    const list = await store.routes.listByAthlete(null);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    setRoutes(list);
    return list;
  }, [store]);

  useEffect(() => {
    void refreshRoutes();
  }, [refreshRoutes]);

  const selectRoute = useCallback(
    async (id: string) => {
      setError(null);
      setHoverPoint(null);
      setAddMode(false);
      const route = await store.routes.get(id);
      const points = await store.routes.getPoints(id);
      setSelectedRoute(route);
      setSelectedPoints(points);
      setRouteNameDraft(route?.name ?? '');
    },
    [store]
  );

  const backToUpload = useCallback(() => {
    setSelectedRoute(null);
    setSelectedPoints(null);
    setError(null);
    setNotice(null);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const text = await file.text();
        const parsed = parseGpxText(text);
        if (!parsed.hasElevation) {
          setNotice('Attenzione: nessun dato di quota trovato nel GPX — il percorso verrà trattato come piatto.');
        } else if (parsed.discardedCount > 0) {
          setNotice(`${parsed.discardedCount} punti scartati per coordinate non valide.`);
        }

        const processed = processRoute(parsed.points);
        const route = await store.routes.create(
          {
            athleteId: null,
            name: file.name.replace(/\.gpx$/i, ''),
            sourceFileName: file.name,
            distanceKm: processed.distanceKm,
            elevationGain: processed.elevationGain,
            elevationLoss: processed.elevationLoss,
            maxElevation: processed.maxElevation,
            minElevation: processed.minElevation
          },
          parsed.points
        );

        await refreshRoutes();
        await selectRoute(route.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Errore sconosciuto durante il caricamento del GPX.');
      } finally {
        setBusy(false);
      }
    },
    [store, refreshRoutes, selectRoute]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await store.routes.delete(id);
      if (selectedRoute?.id === id) backToUpload();
      await refreshRoutes();
    },
    [store, selectedRoute, refreshRoutes, backToUpload]
  );

  const saveRouteName = useCallback(async () => {
    if (!selectedRoute || routeNameDraft.trim() === '' || routeNameDraft === selectedRoute.name) return;
    const updated = await store.routes.update(selectedRoute.id, { name: routeNameDraft.trim() });
    setSelectedRoute(updated);
    await refreshRoutes();
  }, [store, selectedRoute, routeNameDraft, refreshRoutes]);

  const handleImportSections = useCallback(
    async (file: File) => {
      if (!selectedRoute || !plan) return;
      try {
        const text = await file.text();
        const parsed = parseSectionsImport(text, selectedRoute.distanceKm, plan.defaultSpeedKmh);
        if (
          parsed.routeDistanceKm != null &&
          Math.abs(parsed.routeDistanceKm - selectedRoute.distanceKm) > 0.05 &&
          !window.confirm(
            `Attenzione: questo file è stato esportato da un percorso di ${parsed.routeDistanceKm.toFixed(2)} km, ` +
              `mentre quello caricato ora è di ${selectedRoute.distanceKm.toFixed(2)} km.\n\n` +
              `I punti verranno adattati (clampati) al percorso attuale. Continuare comunque?`
          )
        ) {
          return;
        }
        await replaceBreakpoints(parsed.breakpoints, {
          calcMode: parsed.calcMode ?? undefined,
          defaultSpeedKmh: parsed.defaultSpeedKmh ?? undefined,
          windZones: parsed.windZones ?? undefined
        });
        if (parsed.routeName) {
          const updated = await store.routes.update(selectedRoute.id, { name: parsed.routeName });
          setSelectedRoute(updated);
          setRouteNameDraft(updated.name);
          await refreshRoutes();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Errore sconosciuto durante l\'importazione.');
      }
    },
    [selectedRoute, plan, replaceBreakpoints, store, refreshRoutes]
  );

  return (
    <div className="wrapper">
      <div className="header">
        <h1>RouteSplitter</h1>
      </div>

      {!selectedRoute ? (
        <div className="upload-panel">
          <UploadZone onFile={handleFile} busy={busy} />
          {error && <p className="app-error">{error}</p>}
          {routes.length > 0 && (
            <div className="recent-routes">
              <div className="recent-routes-title">Percorsi recenti</div>
              <RouteList routes={routes} selectedId={null} onSelect={id => void selectRoute(id)} onDelete={id => void handleDelete(id)} />
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="top-bar">
            <input
              type="text"
              className="route-name-input"
              value={routeNameDraft}
              onChange={e => setRouteNameDraft(e.target.value)}
              onBlur={() => void saveRouteName()}
            />
            <label className="start-time-field">
              Ora partenza (opz.)
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} />
            </label>
            <button
              type="button"
              className="btn ghost"
              disabled={sections.length === 0 || reportExporting}
              onClick={() => setReportExporting(true)}
            >
              🖨️ Esporta report PDF
            </button>
            <button type="button" className="btn ghost" onClick={backToUpload}>
              📂 Nuovo GPX
            </button>
          </div>
          {notice && <p className="app-notice">{notice}</p>}
          {error && <p className="app-error">{error}</p>}

          <StatsRow route={selectedRoute} sections={sections} />

          <PhysicsParamsPanel
            params={physicsParams}
            onChange={setPhysicsParams}
            calcMode={plan?.calcMode ?? 'speed'}
            onCalcModeChange={mode => void setCalcMode(mode)}
          />

          <CdaEstimator physicsParams={physicsParams} onApplyCda={cda => setPhysicsParams(p => ({ ...p, cda }))} />

          {plan && selectedRoute && (
            <WindZonesPanel
              windZones={plan.windZones}
              totalDistanceKm={selectedRoute.distanceKm}
              selectedZoneId={selectedWindZoneId}
              onSelectZone={setSelectedWindZoneId}
              onAddBoundary={distKm => void addWindZoneBoundary(distKm)}
              onRemoveBoundary={id => void removeWindZoneBoundary(id)}
              onReset={() => void resetWindZones()}
            />
          )}

          {plan && (
            <PacingOptimizerPanel
              breakpoints={plan.breakpoints}
              processedPoints={processedPoints}
              physicsParams={physicsParams}
              totalDistanceKm={selectedRoute.distanceKm}
              windZones={plan.windZones}
              onApplyPowers={updates => void applyPowerUpdates(updates)}
            />
          )}

          {plan && processedPoints.length > 1 && (
            <div className="gara-zone">
              <RouteMap
                points={processedPoints}
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
                  👆 "Aggiungi punto" poi clicca su mappa/grafico per posizionarlo (clic su un punto per rimuoverlo). Trascina il
                  grafico per zoomare, doppio clic per resettare.
                </p>
                <button
                  type="button"
                  className={`btn btn-sm addmode-btn${addMode ? ' active' : ''}`}
                  onClick={() => setAddMode(v => !v)}
                >
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
                  {plan?.calcMode === 'power' ? 'Potenza default nuove sezioni' : 'Velocità default nuove sezioni'}
                  {plan?.calcMode === 'power' ? (
                    <NumberField step={1} value={plan?.defaultPowerWatts ?? 250} onCommit={v => void setDefaultPowerWatts(v)} />
                  ) : (
                    <NumberField step={0.1} value={plan?.defaultSpeedKmh ?? 40} onCommit={v => void setDefaultSpeedKmh(v)} />
                  )}
                  <span>{plan?.calcMode === 'power' ? 'W' : 'km/h'}</span>
                </label>
                <button
                  type="button"
                  className="btn btn-sm ghost"
                  onClick={() => {
                    if (!selectedRoute || !plan) return;
                    const payload = buildSectionsExportPayload(selectedRoute.name, selectedRoute.distanceKm, plan);
                    const safeName = selectedRoute.name.trim().replace(/[^a-z0-9\-_]+/gi, '_') || 'percorso';
                    downloadTextFile(`sezioni_${safeName}.json`, JSON.stringify(payload, null, 2), 'application/json');
                  }}
                >
                  ⬇ Esporta sezioni
                </button>
                <button type="button" className="btn btn-sm ghost" onClick={() => importInputRef.current?.click()}>
                  ⬆ Importa sezioni
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportSections(file);
                    e.target.value = '';
                  }}
                />
              </div>

              <div className="panel">
                <ElevationChart
                  points={processedPoints}
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
          )}

          <SectionsTable
            sections={sections}
            calcMode={plan?.calcMode ?? 'speed'}
            onUpdateLabel={(id, label) => void updateBreakpoint(id, { sectionLabel: label })}
            onUpdateSpeed={(id, speedKmh) => void updateBreakpoint(id, { speedKmh })}
            onUpdatePower={(id, powerWatts) => void updateBreakpoint(id, { powerWatts })}
            onRemove={id => void removeBreakpoint(id)}
          />

          {plan && processedPoints.length > 1 && (
            <ReportView
              route={selectedRoute}
              sections={sections}
              points={processedPoints}
              breakpoints={plan.breakpoints}
              smoothingRadiusMeters={smoothingRadiusMeters}
              startTime={startTime}
              exporting={reportExporting}
              onDonePrinting={() => setReportExporting(false)}
            />
          )}
        </>
      )}

      <footer className="app-footer">
        <a href="https://linktr.ee/bonvicin.coaching" target="_blank" rel="noopener noreferrer">
          © 2026 Andrea Bonvicin
        </a>
      </footer>
    </div>
  );
}
