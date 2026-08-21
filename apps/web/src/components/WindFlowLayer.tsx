import { useEffect, useRef } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import type { ProcessedPoint } from '@physics-core';
import { effectiveHeadwindKmh, getInterpolatedPoint, routeBearingAtDistKm, windAtDistKm } from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';

interface WindFlowLayerProps {
  points: ProcessedPoint[];
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
}

const EARTH_RADIUS_M = 6371000;
const METERS_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

/**
 * Corridoio attorno al tracciato (in px schermo) entro cui le particelle possono derivare
 * lateralmente, prima di essere rigenerate. Windfinder ha un campo di vento 2D su tutta l'area;
 * qui il dato è 1D lungo il percorso, quindi il flusso resta confinato vicino alla rotta invece
 * di coprire tutta la mappa — ma la DIREZIONE del flusso è sempre la bussola reale del vento,
 * mai la direzione della strada (vedi commento più sotto sul perché di questa distinzione).
 */
const CORRIDOR_HALF_WIDTH_PX = 42;

/** Densità: una particella ogni ~22px di percorso visibile a schermo, fra questi limiti. */
const TARGET_PX_PER_PARTICLE = 22;
const MIN_PARTICLES = 28;
const MAX_PARTICLES = 190;

/** Campionamento del tracciato per sapere quali tratti sono nel viewport e per la ricerca del
 * punto più vicino (proiezione della particella sul percorso, usata sia per il corridoio sia
 * per capire quale zona di vento/km applicare). Tenuto abbastanza fitto da seguire bene anche
 * i tornanti, ma con un tetto massimo di campioni per restare economico ad ogni frame. */
const TARGET_SAMPLE_PX_SPACING = 45;
const MIN_SAMPLE_STEP_KM = 0.02;
const MAX_SAMPLE_STEP_KM = 2;
const MAX_SAMPLES = 600;

/** Velocità di scorrimento delle particelle, px/s — mappata sull'intensità REALE del vento
 * (non sulla sola componente testa/coda): calmo = lento, forte = veloce. */
const MIN_FLOW_PX_SPEED = 10;
const MAX_FLOW_PX_SPEED = 52;
const REFERENCE_MAX_SPEED_KMH = 30;

/** Sotto questa soglia (km/h) la componente testa/coda è considerata sostanzialmente nulla
 * (vento quasi puramente al traverso): colore neutro invece di rosso/blu tenue. Sopra la
 * soglia il colore è SEMPRE pieno — niente più sfumature verso il grigio in base
 * all'intensità, che rendevano illeggibile la direzione col vento debole. */
const HEADWIND_DEADBAND_KMH = 1.2;
const HEADWIND_COLOR = 'rgb(239,68,68)'; // rosso: vento in testa
/** Blu invece del verde "canonico" di testa/coda usato altrove nell'app: su una base mappa
 * verde (bosco/campagna, molto comune sui percorsi) il verde si mimetizza nel terreno, il blu
 * resta leggibile su qualunque sfondo. */
const TAILWIND_COLOR = 'rgb(56,189,248)'; // blu: vento in coda
const CROSSWIND_COLOR = 'rgb(226,232,240)'; // grigio chiaro: vento al traverso

/** Vita di ogni particella: rigenerata di continuo su un punto casuale del tratto visibile, con
 * dissolvenza in ingresso/uscita per non far mai vedere il "pop" di nascita/morte. */
const MIN_LIFE_SEC = 2.2;
const MAX_LIFE_SEC = 4;
const FADE_IN_SEC = 0.4;
const FADE_OUT_SEC = 0.5;

const BASE_OPACITY = 0.95;
const LINE_WIDTH = 1.3;

/** Alone scuro sottile dietro ogni tratto, per garantire contrasto sopra qualunque sfondo di
 * mappa. */
const HALO_COLOR = 'rgba(15, 23, 42, 0.55)';
const HALO_EXTRA_WIDTH = 0.9;

/** Dimezzamento della scia lasciata da ogni particella: più basso = coda più lunga. */
const TRAIL_FADE_HALFLIFE_SEC = 0.22;

const OFFSCREEN_PAD_PX = CORRIDOR_HALF_WIDTH_PX + 40;

interface SamplePoint {
  km: number;
  x: number;
  y: number;
}

interface RouteRun {
  fromKm: number;
  toKm: number;
  length: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface Particle {
  lat: number;
  lon: number;
  age: number;
  maxLife: number;
  prevScreen: ScreenPoint | null;
}

/** Proietta (x,y) sul tracciato campionato (per "run" contigue, senza saltare i buchi dove il
 * percorso esce dal viewport) e restituisce il km più vicino e la distanza in px. */
function nearestOnSamples(x: number, y: number, groups: SamplePoint[][]): { km: number; dist: number } | null {
  let bestDist2 = Infinity;
  let bestKm = 0;
  let found = false;
  for (const group of groups) {
    for (let i = 0; i < group.length - 1; i++) {
      const a = group[i]!;
      const b = group[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const ddx = x - px;
      const ddy = y - py;
      const dist2 = ddx * ddx + ddy * ddy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        bestKm = a.km + (b.km - a.km) * t;
        found = true;
      }
    }
  }
  return found ? { km: bestKm, dist: Math.sqrt(bestDist2) } : null;
}

function pickRandomKm(runs: RouteRun[], totalLength: number): number {
  let r = Math.random() * totalLength;
  for (const run of runs) {
    if (r <= run.length || run === runs[runs.length - 1]) {
      return run.fromKm + Math.min(run.length, Math.max(0, r));
    }
    r -= run.length;
  }
  return runs[0]!.fromKm;
}

/**
 * Particelle vento in stile Windfinder: un campo di puntini che scorrono di continuo lasciando
 * una scia che sbiadisce, invece di un segno che oscilla fermo sul posto.
 *
 * PUNTO CHIAVE (bug corretto rispetto alla versione precedente): la direzione di movimento è
 * SEMPRE la direzione geografica reale del vento (una bussola fissa), mai la tangente della
 * strada. Su un percorso pieno di tornanti la tangente cambia in continuazione: se il movimento
 * fosse legato ad essa, le particelle sembrerebbero muoversi "a caso" ad ogni curva anche con
 * vento perfettamente uniforme — esattamente il difetto segnalato. Il percorso qui serve SOLO a
 * delimitare un corridoio (~42px) entro cui le particelle vengono generate e rigenerate: dentro
 * quel corridoio si muovono in linea retta nella direzione vera del vento, e quando esco dal
 * corridoio (o dal tratto visibile, o a fine vita) vengono rigenerate altrove sul percorso.
 *
 * Per sapere quale km/zona di vento applicare a una particella, ad ogni frame la si proietta sul
 * tracciato campionato (proiezione punto-segmento sulle "run" visibili, senza saltare i tratti
 * fuori schermo) e si usa il km più vicino trovato.
 *
 * Tecnica scia: il canvas non viene mai cancellato del tutto. Ad ogni frame si "erode" l'alpha
 * del contenuto precedente con `globalCompositeOperation = 'destination-out'`, poi si disegna la
 * nuova posizione di ogni particella — stesso trucco delle visualizzazioni di campo vettoriale
 * (windy.com, earth.nullschool), qui in Canvas 2D puro senza WebGL.
 *
 * Colore: SEMPRE pieno (rosso = testa, blu = coda — blu al posto del verde "canonico" usato nel
 * resto dell'app perché su una base mappa verde il verde si mimetizza nel terreno), tranne un
 * grigio neutro sotto una soglia minima (vento quasi puramente al traverso). Niente più sfumatura
 * verso il grigio proporzionale all'intensità: quella rendeva illeggibile rosso/blu col vento
 * debole. L'intensità resta comunicata solo dalla velocità di scorrimento.
 *
 * Canvas puro (vedi commento su `.wind-flow-canvas` in index.css per lo z-index: deve stare
 * SOPRA l'intero `mapPane` di Leaflet, non solo sopra le tile, altrimenti resta invisibile).
 */
export function WindFlowLayer({ points, windZones, totalDistanceKm }: WindFlowLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const sampleGroupsRef = useRef<SamplePoint[][]>([]);
  const runsRef = useRef<RouteRun[]>([]);
  const totalRunLengthRef = useRef(0);
  const mppRef = useRef(1);
  const mapSizeRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const debounceRef = useRef<number | null>(null);
  /** true mentre l'utente sta trascinando/zoomando la mappa. I pixel già disegnati sul canvas
   * NON seguono il pan/zoom (il canvas è un elemento fisso, ridisegnato da capo ogni frame in
   * coordinate container-relative correnti) — solo la posizione calcolata al volo di ogni
   * particella è sempre corretta. Se durante un movimento rapido (soprattutto uno zoom, dove la
   * stessa posizione geografica può spostarsi di centinaia di px da un frame all'altro) si
   * continua a disegnare la scia collegando il punto vecchio (fermo) al nuovo (corretto), si
   * ottengono le righe diagonali lunghissime segnalate. Soluzione: azzerare del tutto il disegno
   * durante l'interazione — il canvas resta vuoto — e ripartire pulito a `moveend`/`zoomend`,
   * quando comunque le particelle vengono già rigenerate da zero. */
  const interactingRef = useRef(false);

  const active = windZones.length >= 2 && totalDistanceKm > 0 && points.length >= 2;

  function spawnParticle(target: Particle) {
    const runs = runsRef.current;
    if (runs.length === 0) {
      target.age = MAX_LIFE_SEC; // niente da mostrare: la si lascia "morta" finché non c'è un tratto visibile
      target.maxLife = MAX_LIFE_SEC;
      target.prevScreen = null;
      return;
    }
    const km = pickRandomKm(runs, totalRunLengthRef.current);
    const base = getInterpolatedPoint(points, km * 1000);
    const tangentDeg = routeBearingAtDistKm(points, km);
    const rad = (tangentDeg * Math.PI) / 180;
    // Normale allo schermo (perpendicolare alla tangente), stessa convenzione bussola->schermo
    // usata nel resto del file: 0°=su, 90°=destra.
    const nX = Math.cos(rad);
    const nY = Math.sin(rad);
    const offsetPx = (Math.random() * 2 - 1) * CORRIDOR_HALF_WIDTH_PX;
    const mpp = mppRef.current;
    const metersEast = nX * offsetPx * mpp;
    const metersSouth = nY * offsetPx * mpp;
    target.lat = base.lat - metersSouth / METERS_PER_DEG_LAT;
    target.lon = base.lon + metersEast / (METERS_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180));
    target.age = 0;
    target.maxLife = MIN_LIFE_SEC + Math.random() * (MAX_LIFE_SEC - MIN_LIFE_SEC);
    target.prevScreen = null;
  }

  function recomputeFlowField() {
    if (!active) {
      particlesRef.current = [];
      sampleGroupsRef.current = [];
      runsRef.current = [];
      totalRunLengthRef.current = 0;
      clearCanvas();
      return;
    }
    const bounds = map.getBounds();
    const center = map.getCenter();
    const mpp = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    mppRef.current = mpp;
    mapSizeRef.current = map.getSize();

    let sampleStepKm = Math.min(
      MAX_SAMPLE_STEP_KM,
      Math.max(MIN_SAMPLE_STEP_KM, (TARGET_SAMPLE_PX_SPACING * mpp) / 1000)
    );
    if (totalDistanceKm / sampleStepKm > MAX_SAMPLES) {
      sampleStepKm = totalDistanceKm / MAX_SAMPLES;
    }

    const groups: SamplePoint[][] = [];
    const runs: RouteRun[] = [];
    let current: SamplePoint[] = [];
    let currentStartKm: number | null = null;
    let prevKm = 0;

    function flushRun(endKm: number) {
      if (current.length >= 2 && currentStartKm != null) {
        groups.push(current);
        runs.push({ fromKm: currentStartKm, toKm: endKm, length: endKm - currentStartKm });
      }
      current = [];
      currentStartKm = null;
    }

    for (let km = 0; km <= totalDistanceKm; km += sampleStepKm) {
      const p = getInterpolatedPoint(points, km * 1000);
      const visible = bounds.contains([p.lat, p.lon]);
      if (visible) {
        if (currentStartKm == null) currentStartKm = km;
        const screen = map.latLngToContainerPoint([p.lat, p.lon]);
        current.push({ km, x: screen.x, y: screen.y });
      } else if (currentStartKm != null) {
        flushRun(prevKm);
      }
      prevKm = km;
    }
    flushRun(totalDistanceKm);

    sampleGroupsRef.current = groups;
    runsRef.current = runs;
    const totalLength = runs.reduce((sum, r) => sum + r.length, 0);
    totalRunLengthRef.current = totalLength;
    clearCanvas();

    if (totalLength <= 0) {
      particlesRef.current = [];
      return;
    }

    const visiblePx = (totalLength * 1000) / mpp;
    const targetCount = Math.round(
      Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, visiblePx / TARGET_PX_PER_PARTICLE))
    );

    const fresh: Particle[] = [];
    for (let i = 0; i < targetCount; i++) {
      const particle: Particle = { lat: 0, lon: 0, age: 0, maxLife: 1, prevScreen: null };
      spawnParticle(particle);
      // Sfasa l'età iniziale così il campo appare già "in flusso" invece che nascere tutto insieme.
      particle.age = Math.random() * particle.maxLife;
      fresh.push(particle);
    }
    particlesRef.current = fresh;
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx?.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  }

  useMapEvents({
    movestart: () => {
      interactingRef.current = true;
    },
    zoomstart: () => {
      interactingRef.current = true;
    },
    moveend: () => {
      interactingRef.current = false;
      scheduleRecompute();
    },
    zoomend: () => {
      interactingRef.current = false;
      scheduleRecompute();
    },
    resize: () => {
      resizeCanvas();
      scheduleRecompute();
    }
  });

  function scheduleRecompute() {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(recomputeFlowField, 80);
  }

  function resizeCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(size.x * dpr));
    canvas.height = Math.max(1, Math.round(size.y * dpr));
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapSizeRef.current = size;
  }

  useEffect(() => {
    if (!active) return;
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'wind-flow-canvas';
    map.getContainer().appendChild(canvas);
    canvasRef.current = canvas;
    resizeCanvas();
    recomputeFlowField();

    let stopped = false;
    function onVisibilityChange() {
      if (document.hidden) {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        lastTsRef.current = null;
      } else if (!stopped) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    function tick(ts: number) {
      if (stopped) return;
      const canvasEl = canvasRef.current;
      if (!canvasEl) return;
      const last = lastTsRef.current;
      const dt = last != null ? Math.min(0.1, (ts - last) / 1000) : 0.016;
      lastTsRef.current = ts;

      const ctx = canvasEl.getContext('2d');
      const width = mapSizeRef.current.x;
      const height = mapSizeRef.current.y;
      const mpp = mppRef.current;
      const groups = sampleGroupsRef.current;

      if (ctx && width > 0 && height > 0 && interactingRef.current) {
        // Pan/zoom in corso: il canvas è ridisegnato in coordinate container-relative correnti,
        // ma i pixel già tracciati dei frame precedenti restano fermi dove sono stati disegnati
        // e NON seguono il movimento della mappa. Continuare a collegare la vecchia posizione
        // (ferma) alla nuova (corretta) produrrebbe proprio le righe diagonali segnalate,
        // specialmente durante uno zoom dove lo stesso punto geografico può spostarsi di
        // centinaia di px in un frame. Soluzione: azzerare la scia e non disegnare nulla finché
        // l'interazione non termina — a quel punto `moveend`/`zoomend` rigenera comunque le
        // particelle da zero, quindi non c'è nulla da "riprendere".
        ctx.clearRect(0, 0, width, height);
      } else if (ctx && width > 0 && height > 0) {
        // Erode la scia precedente invece di cancellarla: lascia una coda che sbiadisce da sola.
        ctx.globalCompositeOperation = 'destination-out';
        const eraseAlpha = 1 - Math.pow(0.5, dt / TRAIL_FADE_HALFLIFE_SEC);
        ctx.fillStyle = `rgba(0,0,0,${eraseAlpha})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineCap = 'round';

        for (const p of particlesRef.current) {
          const screenPos = map.latLngToContainerPoint([p.lat, p.lon]);
          const nearest = nearestOnSamples(screenPos.x, screenPos.y, groups);

          const outOfScreen =
            screenPos.x < -OFFSCREEN_PAD_PX ||
            screenPos.x > width + OFFSCREEN_PAD_PX ||
            screenPos.y < -OFFSCREEN_PAD_PX ||
            screenPos.y > height + OFFSCREEN_PAD_PX;
          const outOfCorridor = !nearest || nearest.dist > CORRIDOR_HALF_WIDTH_PX;
          const tooOld = p.age > p.maxLife;

          if (outOfScreen || outOfCorridor || tooOld) {
            spawnParticle(p);
            continue;
          }

          const wind = windAtDistKm(windZones, nearest.km);
          const routeBearingDeg = routeBearingAtDistKm(points, nearest.km);

          // Direzione di scorrimento = bussola VERA del vento (dove soffia), indipendente dalla
          // tangente della strada — vedi commento in cima al file sul perché.
          let flowPxSpeed = MIN_FLOW_PX_SPEED;
          let dirRad = 0;
          if (wind && wind.speedKmh > 0) {
            const blowingToDeg = (wind.directionDeg + 180) % 360;
            dirRad = (blowingToDeg * Math.PI) / 180;
            const speedT = Math.min(1, wind.speedKmh / REFERENCE_MAX_SPEED_KMH);
            flowPxSpeed = MIN_FLOW_PX_SPEED + speedT * (MAX_FLOW_PX_SPEED - MIN_FLOW_PX_SPEED);
          }
          const dirX = Math.sin(dirRad);
          const dirY = -Math.cos(dirRad);
          const metersEast = dirX * flowPxSpeed * dt * mpp;
          const metersSouth = dirY * flowPxSpeed * dt * mpp;
          p.lat -= metersSouth / METERS_PER_DEG_LAT;
          p.lon += metersEast / (METERS_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180));
          p.age += dt;

          if (p.prevScreen) {
            const fadeT =
              p.age < FADE_IN_SEC
                ? p.age / FADE_IN_SEC
                : p.age > p.maxLife - FADE_OUT_SEC
                  ? Math.max(0, (p.maxLife - p.age) / FADE_OUT_SEC)
                  : 1;
            const headwindKmh = wind ? effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, routeBearingDeg) : 0;
            const color =
              Math.abs(headwindKmh) < HEADWIND_DEADBAND_KMH
                ? CROSSWIND_COLOR
                : headwindKmh > 0
                  ? HEADWIND_COLOR
                  : TAILWIND_COLOR;

            ctx.globalAlpha = BASE_OPACITY * fadeT;
            ctx.strokeStyle = HALO_COLOR;
            ctx.lineWidth = LINE_WIDTH + HALO_EXTRA_WIDTH;
            ctx.beginPath();
            ctx.moveTo(p.prevScreen.x, p.prevScreen.y);
            ctx.lineTo(screenPos.x, screenPos.y);
            ctx.stroke();
            ctx.strokeStyle = color;
            ctx.lineWidth = LINE_WIDTH;
            ctx.beginPath();
            ctx.moveTo(p.prevScreen.x, p.prevScreen.y);
            ctx.lineTo(screenPos.x, screenPos.y);
            ctx.stroke();
          }
          p.prevScreen = { x: screenPos.x, y: screenPos.y };
        }
        ctx.globalAlpha = 1;
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      canvas.remove();
      canvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, map, points, windZones, totalDistanceKm]);

  return null;
}
