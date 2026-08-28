import { useMemo, useRef, useState } from 'react';
import {
  estimateCdaFromSamples,
  bucketSamplesByTier,
  bucketSamplesByBreakpoints,
  makeUniformWindZones,
  routeBearingAtDistKm,
  effectiveHeadwindKmh,
  computeGainLossBetween,
  type PhysicsParams,
  type SectionBreakpoint,
  type CdaSample
} from '@physics-core';
import { parseActivityText, type ActivityTrackPoint } from '../activity/parseActivityFile.js';
import { buildCdaSamples } from '../activity/activitySamples.js';
import { buildActivityDisplay, nearestPointTimeSec } from '../activity/buildActivityDisplay.js';
import { RouteMap, type MapWindControlData } from './RouteMap.js';
import { ActivityElevationChart } from './ActivityElevationChart.js';
import { formatTime } from '../lib/formatTime.js';
import { generateId } from '../data-store/common.js';

interface ActivityAnalysisViewProps {
  physicsParams: PhysicsParams;
  /** target 'base' = sovrascrive il CdA base; un numero = indice della soglia in cdaTiers da sovrascrivere. */
  onApplyCda: (cda: number, target: 'base' | number) => void;
}

interface BucketResult {
  target: 'base' | number;
  thresholdPct: number | null;
  cda: number;
  usedSamples: number;
  stdDev: number;
}

/** Una riga della tabella sezioni: dati REALI misurati sul tratto (non target pianificati),
 * più il CdA calcolato su quel tratto quando ci sono abbastanza campioni. */
interface ActivitySectionRow {
  index: number;
  fromKm: number;
  toKm: number;
  distanceKm: number;
  gain: number;
  loss: number;
  avgGradient: number;
  avgHeadwindKmh: number;
  avgSpeedKmh: number;
  avgPowerW: number | null;
  durationSec: number;
  cda: number | null;
  cdaStdDev: number | null;
  usedSamples: number;
  /** id del breakpoint che chiude questa sezione — null per l'ultima sezione (aperta, non rimovibile). */
  breakpointId: string | null;
}

const MIN_CDA_SAMPLES = 20;

function windBadge(headwindKmh: number) {
  if (Math.abs(headwindKmh) < 0.5) {
    return <span className="wind-badge wind-badge-neutral">— </span>;
  }
  const isHeadwind = headwindKmh > 0;
  return (
    <span className={`wind-badge ${isHeadwind ? 'wind-badge-head' : 'wind-badge-tail'}`}>
      {isHeadwind ? '↑' : '↓'} {Math.abs(headwindKmh).toFixed(1)} km/h
    </span>
  );
}

/**
 * Analisi di un'attività reale caricata da file (FIT/TCX/GPX) — strumento a sé stante, non
 * legato al percorso pianificato nella tab "Percorso": si può caricare un'uscita registrata
 * senza aver mai importato un GPX di gara. `physicsParams`/`onApplyCda` sono comunque
 * condivisi con la tab "Percorso" (stesso stato globale in `RouteSplitterApp`), così una
 * calibrazione CdA fatta qui è già pronta per la pianificazione.
 *
 * La mappa RIUSA DIRETTAMENTE `RouteMap` (non un clone): stesso pulsante ricentra, stesso
 * click-to-add sul percorso, stessa bussola vento overlay — nessuna reinvenzione, perché
 * non c'è alcun motivo che l'HUD di una mappa debba essere diverso solo perché i dati sotto
 * vengono da un'attività registrata invece che da un percorso pianificato.
 * `ActivityElevationChart` non può essere un riuso diretto di `ElevationChart` (serve la
 * linea di potenza, assente lì, e non ha senso il concetto di "sezione con target"), ma ne
 * replica fedelmente HUD e logica — vedi i commenti in quel file per le uniche differenze
 * deliberate.
 *
 * Vento: stessa bussola/UI della tab "Percorso" (`MapWindControlData`), non un campo
 * numerico separato. Un solo vento costante per l'intera uscita (nessuna gestione a zone
 * qui), ma proiettato correttamente sulla direzione di marcia punto per punto —
 * `effectiveHeadwindKmh` + `routeBearingAtDistKm`, la stessa fisica della fascia vento sul
 * grafico — non un valore scalare fisso applicato uniformemente come prima: due tratti con
 * la stessa intensità di vento ma bearing diverso ora hanno correttamente headwind diverso.
 *
 * Sezioni manuali (F3.4): stesso motore di split della pianificazione — un breakpoint
 * cliccato sul grafico O sulla mappa (sincronizzati, come nella tab "Percorso") definisce un
 * confine, `bucketSamplesByBreakpoints` (physics-core) divide i campioni CdA fra i confini.
 */
export function ActivityAnalysisView({ physicsParams, onApplyCda }: ActivityAnalysisViewProps) {
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [activityPoints, setActivityPoints] = useState<ActivityTrackPoint[] | null>(null);
  const [hasPowerData, setHasPowerData] = useState(false);
  const [hoverPoint, setHoverPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [smoothingRadiusMeters, setSmoothingRadiusMeters] = useState(50);
  const [windSpeedKmh, setWindSpeedKmh] = useState(0);
  const [windDirectionDeg, setWindDirectionDeg] = useState(0);
  const [sectionBreakpoints, setSectionBreakpoints] = useState<SectionBreakpoint[]>([]);
  const [addSectionMode, setAddSectionMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addBreakpoint = (distKm: number) => {
    setSectionBreakpoints(bps =>
      [...bps, { id: generateId(), distKm, fixed: false as const, sectionLabel: null, speedKmh: null, powerWatts: null }].sort(
        (a, b) => a.distKm - b.distKm
      )
    );
  };
  const removeBreakpoint = (id: string) => {
    setSectionBreakpoints(bps => bps.filter(b => b.id !== id));
  };

  const display = useMemo(() => (activityPoints ? buildActivityDisplay(activityPoints) : null), [activityPoints]);

  // A vento zero, niente fascia/animazione vento: windZones vuoto disattiva sia la fascia
  // sul grafico sia il layer animato sulla mappa (entrambi condizionati a windZones.length
  // >= 2 nei rispettivi componenti) — non ha senso animare un vento nullo.
  const windZones = useMemo(
    () => (display && windSpeedKmh !== 0 ? makeUniformWindZones(display.distanceKm, windSpeedKmh, windDirectionDeg) : []),
    [display, windSpeedKmh, windDirectionDeg]
  );

  const windControl: MapWindControlData | null = useMemo(() => {
    if (!display) return null;
    return {
      rangeLabel: `0.0 → ${display.distanceKm.toFixed(1)} km`,
      speedKmh: windSpeedKmh,
      directionDeg: windDirectionDeg,
      onChangeSpeed: setWindSpeedKmh,
      onChangeDirection: setWindDirectionDeg
    };
  }, [display, windSpeedKmh, windDirectionDeg]);

  const cdaBuilt = useMemo(() => (activityPoints ? buildCdaSamples(activityPoints) : null), [activityPoints]);

  // Vento proiettato punto per punto sulla direzione di marcia reale (stessa fisica della
  // fascia vento sul grafico), non un valore scalare unico per tutta l'uscita.
  const windedSamples = useMemo<CdaSample[] | null>(() => {
    if (!cdaBuilt || !display) return null;
    if (windSpeedKmh === 0) return cdaBuilt.samples;
    return cdaBuilt.samples.map(s => {
      if (s.distKm == null) return s;
      const bearing = routeBearingAtDistKm(display.points, s.distKm);
      return { ...s, windKmh: effectiveHeadwindKmh(windSpeedKmh, windDirectionDeg, bearing) };
    });
  }, [cdaBuilt, display, windSpeedKmh, windDirectionDeg]);

  const tierResults = useMemo<BucketResult[]>(() => {
    if (!windedSamples) return [];
    const buckets = bucketSamplesByTier(windedSamples, physicsParams);
    const computed: BucketResult[] = [];
    for (const bucket of buckets) {
      const r = estimateCdaFromSamples(bucket.samples, physicsParams);
      if (r) {
        computed.push({
          target: bucket.target,
          thresholdPct: bucket.thresholdPct,
          cda: r.cda,
          usedSamples: r.usedSamples,
          stdDev: r.stdDev
        });
      }
    }
    return computed;
  }, [windedSamples, physicsParams]);

  const sectionRows = useMemo<ActivitySectionRow[]>(() => {
    if (!windedSamples || !display) return [];
    const totalKm = display.distanceKm;
    const sortedBps = [...sectionBreakpoints].sort((a, b) => a.distKm - b.distKm);
    const bpKm = sortedBps.map(b => b.distKm);
    const buckets = bucketSamplesByBreakpoints(windedSamples, bpKm);

    return buckets.map((bucket, i) => {
      const toKmFinite = Number.isFinite(bucket.toKm) ? bucket.toKm : totalKm;
      const r = estimateCdaFromSamples(bucket.samples, physicsParams);
      const { gain, loss } = computeGainLossBetween(display.points, bucket.fromKm, toKmFinite);
      const distanceKm = toKmFinite - bucket.fromKm;
      const avgGradient = distanceKm > 0 ? ((gain - loss) / (distanceKm * 1000)) * 100 : 0;
      const n = bucket.samples.length;
      const avgSpeedKmh = n > 0 ? (bucket.samples.reduce((s, x) => s + x.speedMS, 0) / n) * 3.6 : 0;
      const powerSamples = bucket.samples.filter(s => s.powerW > 0);
      const avgPowerW = powerSamples.length > 0 ? powerSamples.reduce((s, x) => s + x.powerW, 0) / powerSamples.length : null;
      const windSamples = bucket.samples.filter(s => s.windKmh != null);
      const avgHeadwindKmh = windSamples.length > 0 ? windSamples.reduce((s, x) => s + x.windKmh!, 0) / windSamples.length : 0;
      const durationSec = nearestPointTimeSec(display.points, toKmFinite) - nearestPointTimeSec(display.points, bucket.fromKm);

      return {
        index: i + 1,
        fromKm: bucket.fromKm,
        toKm: toKmFinite,
        distanceKm,
        gain,
        loss,
        avgGradient,
        avgHeadwindKmh,
        avgSpeedKmh,
        avgPowerW,
        durationSec,
        cda: r?.cda ?? null,
        cdaStdDev: r?.stdDev ?? null,
        usedSamples: r?.usedSamples ?? 0,
        breakpointId: i < sortedBps.length ? sortedBps[i]!.id : null
      };
    });
  }, [windedSamples, display, sectionBreakpoints, physicsParams]);

  const sectionCdaRange = useMemo(() => {
    const values = sectionRows.map(r => r.cda).filter((v): v is number => v != null);
    if (values.length === 0) return null;
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [sectionRows]);

  const handleFile = async (file: File) => {
    setBusy(true);
    setErrorMsg(null);
    setActivityPoints(null);
    setHasPowerData(false);
    setSectionBreakpoints([]);
    setFileName(file.name);
    try {
      const parsed = /\.fit$/i.test(file.name)
        ? await (await import('../activity/parseFitFile.js')).parseFitFile(file)
        : parseActivityText(await file.text());
      if (parsed.points.length < 2) {
        setErrorMsg('File troppo corto: servono almeno 2 punti con coordinate e orario validi.');
        return;
      }
      setActivityPoints(parsed.points);
      setHasPowerData(parsed.hasPower);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Errore durante la lettura del file.');
    } finally {
      setBusy(false);
    }
  };

  const samplesCount = cdaBuilt?.samples.length ?? 0;
  const hasCdaTiers = (physicsParams.cdaTiers?.length ?? 0) > 0;

  return (
    <div className="activity-analysis-view">
      <div className="activity-analysis-header">
        <h2 className="physics-panel-title">Analisi Attività</h2>
        <p className="physics-hint">
          Carica un file FIT, TCX o GPX di un'uscita registrata: mappa, altimetria e potenza lungo il percorso, per
          leggere come è andato il pacing — non un'analisi classica (per quella usa altri strumenti). Indipendente dal
          percorso eventualmente caricato nella tab "Percorso".
        </p>
      </div>

      <div className="pacing-actions activity-upload-row">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? 'Elaborazione…' : fileName ? `📄 ${fileName}` : '📄 Carica FIT/TCX/GPX'}
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

      {errorMsg && <p className="app-error activity-upload-row">{errorMsg}</p>}

      {display && (
        <>
          <div className="stats-row">
            <div className="stat-card stat-dist">
              <div className="stat-label">Distanza</div>
              <div className="stat-value">{display.distanceKm.toFixed(2)} km</div>
            </div>
            <div className="stat-card stat-gain">
              <div className="stat-label">Dislivello +</div>
              <div className="stat-value">{Math.round(display.elevationGain)} m</div>
            </div>
            <div className="stat-card stat-loss">
              <div className="stat-label">Dislivello −</div>
              <div className="stat-value">{Math.round(display.elevationLoss)} m</div>
            </div>
            <div className="stat-card stat-time">
              <div className="stat-label">Durata</div>
              <div className="stat-value">{formatTime(display.durationSec / 3600)}</div>
            </div>
            <div className="stat-card stat-avgspeed">
              <div className="stat-label">Vel. media</div>
              <div className="stat-value">{display.avgSpeedKmh.toFixed(1)} km/h</div>
            </div>
            {display.avgPowerW != null && (
              <div className="stat-card">
                <div className="stat-label">Potenza media</div>
                <div className="stat-value">{Math.round(display.avgPowerW)} W</div>
              </div>
            )}
          </div>

          <div className="gara-zone">
            <RouteMap
              points={display.points}
              smoothingRadiusMeters={smoothingRadiusMeters}
              hoverPoint={hoverPoint}
              breakpoints={sectionBreakpoints}
              addMode={addSectionMode}
              onAddBreakpoint={addBreakpoint}
              onRemoveBreakpoint={removeBreakpoint}
              windControl={windControl}
              windZones={windZones}
              totalDistanceKm={display.distanceKm}
            />

            <div className="top-controls-row">
              <p className="sv-hint">
                👆 "Aggiungi punto" poi clicca su mappa/grafico per posizionarlo (clic su un punto per rimuoverlo). Trascina il
                grafico per zoomare, doppio clic per resettare.
              </p>
              <button
                type="button"
                className={`btn btn-sm addmode-btn${addSectionMode ? ' active' : ''}`}
                onClick={() => setAddSectionMode(v => !v)}
              >
                ✛ Aggiungi punto
              </button>
              <button type="button" className="btn btn-sm ghost" onClick={() => setSectionBreakpoints([])}>
                ↺ Reset punti
              </button>
            </div>

            <div className="panel">
              <ActivityElevationChart
                points={display.points}
                smoothingRadiusMeters={smoothingRadiusMeters}
                onSmoothingChange={setSmoothingRadiusMeters}
                onHoverPoint={setHoverPoint}
                breakpoints={sectionBreakpoints}
                addMode={addSectionMode}
                onAddBreakpoint={addBreakpoint}
                onRemoveBreakpoint={removeBreakpoint}
                windZones={windZones}
              />
            </div>
          </div>
        </>
      )}

      {activityPoints && (
        <div className="activity-cda-section">
          <h3>Stima CdA (multi-punto)</h3>

          {!hasPowerData && (
            <p className="physics-hint">
              Il file non contiene dati di potenza: mappa e altimetria restano disponibili sopra, ma la stima CdA
              richiede potenza — non calcolabile per questa attività.
            </p>
          )}

          {hasPowerData && samplesCount < MIN_CDA_SAMPLES && (
            <p className="physics-hint">
              Solo {samplesCount} campioni utilizzabili (minimo {MIN_CDA_SAMPLES}): file troppo corto o troppe fermate
              per una stima CdA affidabile.
            </p>
          )}

          {hasPowerData && samplesCount >= MIN_CDA_SAMPLES && (
            <>
              {hasCdaTiers && tierResults.length === 0 && (
                <p className="app-error">
                  Non è stato possibile stimare un CdA affidabile per le soglie configurate (dati troppo rumorosi, o
                  troppo pochi campioni in una delle soglie di pendenza).
                </p>
              )}

              {hasCdaTiers && tierResults.length > 0 && (
                <>
                  <p className="physics-hint">
                    <strong>CdA base</strong> è il CdA stimato sui campioni sotto la prima soglia di pendenza
                    configurata (il "piano" secondo le tue soglie) — le altre righe sono le soglie stesse, ognuna
                    stimata solo sui campioni con pendenza in quel range. <strong>Applica</strong> scrive il CdA
                    stimato nei parametri fisici, sostituendo quello attuale.
                  </p>
                  <div className="cda-activity-results">
                    {tierResults.map(r => (
                      <div key={String(r.target)} className="cda-activity-result-row">
                        <span>
                          {r.target === 'base' ? 'CdA base (piano)' : `Soglia ≥${r.thresholdPct}%`} — {r.cda.toFixed(3)} m²
                          <span className="physics-hint"> (±{r.stdDev.toFixed(3)}, n={r.usedSamples})</span>
                        </span>
                        <button type="button" className="pacing-full" onClick={() => onApplyCda(r.cda, r.target)}>
                          Applica
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="cda-section-view">
                {sectionRows.length === 0 ? (
                  <p className="physics-hint">
                    Nessuna sezione ancora definita — aggiungine una dal grafico o dalla mappa con "✛ Aggiungi punto".
                  </p>
                ) : (
                  <>
                    <p className="physics-hint">
                      Dati reali misurati su ciascun tratto, non un'unica media su tutto il giro che mischierebbe
                      salite e discese.
                      {!hasCdaTiers && (
                        <>
                          {' '}
                          Non hai soglie CdA configurate: usa "Applica" sulla sezione più rappresentativa del tuo
                          utilizzo tipico (es. pianura a velocità di crociera) invece di un valore medio sull'intero
                          giro.
                        </>
                      )}
                    </p>
                    <div className="sections-table-wrap">
                      <table className="sections-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Da → A</th>
                            <th>Distanza</th>
                            <th>D+</th>
                            <th>D−</th>
                            <th>Pend.</th>
                            <th>Vento</th>
                            <th>Velocità media</th>
                            <th>Potenza media</th>
                            <th>Tempo</th>
                            <th>CdA calcolata</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {sectionRows.map(row => {
                            const range = sectionCdaRange;
                            const barPct = row.cda != null && range && range.max - range.min > 1e-6 ? ((row.cda - range.min) / (range.max - range.min)) * 100 : 50;
                            return (
                              <tr key={`${row.fromKm}-${row.toKm}`}>
                                <td>{row.index}</td>
                                <td className="mono">
                                  {row.fromKm.toFixed(2)} → {Number.isFinite(row.toKm) ? row.toKm.toFixed(2) : '∞'} km
                                </td>
                                <td className="mono dist">{row.distanceKm.toFixed(2)} km</td>
                                <td className="mono gain">+{Math.round(row.gain)} m</td>
                                <td className="mono loss">−{Math.round(row.loss)} m</td>
                                <td className="mono">
                                  {row.avgGradient >= 0 ? '+' : ''}
                                  {row.avgGradient.toFixed(1)}%
                                </td>
                                <td className="mono wind-cell">{windBadge(row.avgHeadwindKmh)}</td>
                                <td className="mono">{row.avgSpeedKmh.toFixed(1)} km/h</td>
                                <td className="mono">{row.avgPowerW != null ? `${Math.round(row.avgPowerW)} W` : '—'}</td>
                                <td className="mono time">{formatTime(row.durationSec / 3600)}</td>
                                <td className="mono cda-cell">
                                  {row.cda != null ? (
                                    <div className="cda-section-row">
                                      <div className="cda-section-bar-track">
                                        <div className="cda-section-bar-fill" style={{ width: `${Math.max(4, barPct)}%` }} />
                                      </div>
                                      <span className="cda-section-value">
                                        {row.cda.toFixed(3)} m² <span className="physics-hint">(n={row.usedSamples})</span>
                                      </span>
                                      {!hasCdaTiers && (
                                        <button type="button" className="cda-apply-btn" onClick={() => onApplyCda(row.cda!, 'base')}>
                                          Applica
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="physics-hint">n. d. (n={row.usedSamples})</span>
                                  )}
                                </td>
                                <td>{row.breakpointId && <button onClick={() => removeBreakpoint(row.breakpointId!)}>✕</button>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
