import L from 'leaflet';
import type { ProcessedPoint, SectionBreakpoint } from '@physics-core';
import { smoothByDistance } from '@physics-core';
import { getGradientColor } from './gradientColor.js';

export interface StaticMapOptions {
  points: ProcessedPoint[];
  breakpoints: SectionBreakpoint[];
  smoothingRadiusMeters: number;
  isDark: boolean;
  pxWidth: number;
  pxHeight: number;
}

function markerColor(fixed: SectionBreakpoint['fixed']): string {
  if (fixed === 'start') return '#22c55e';
  if (fixed === 'finish') return '#fc5200';
  return '#3b82f6';
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Disegna tile OSM + tracciato colorato per pendenza + marker numerati su un <canvas> a
 * risoluzione scelta da noi, invece di provare a "fotografare" la mappa Leaflet interattiva
 * (fragile: dipende da animazioni di zoom/pan e timing del caricamento tile). Risultato sempre
 * nitido indipendentemente da cosa succede a schermo. Stessa tecnica del prototipo originale.
 */
export async function buildStaticMapImage(opts: StaticMapOptions): Promise<string | null> {
  const { points, breakpoints, smoothingRadiusMeters, isDark, pxWidth, pxHeight } = opts;
  if (points.length < 2) return null;

  const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
  const crs = L.CRS.EPSG3857;
  const project = (lat: number, lon: number, zoom: number) => crs.latLngToPoint(L.latLng(lat, lon), zoom);
  const PADDING = 24;

  let zoom = 18;
  for (; zoom >= 1; zoom--) {
    const nw = project(bounds.getNorth(), bounds.getWest(), zoom);
    const se = project(bounds.getSouth(), bounds.getEast(), zoom);
    if (Math.abs(se.x - nw.x) <= pxWidth - PADDING * 2 && Math.abs(se.y - nw.y) <= pxHeight - PADDING * 2) break;
  }

  const nw = project(bounds.getNorth(), bounds.getWest(), zoom);
  const se = project(bounds.getSouth(), bounds.getEast(), zoom);
  const bboxW = se.x - nw.x;
  const bboxH = se.y - nw.y;
  const originX = nw.x - (pxWidth - bboxW) / 2;
  const originY = nw.y - (pxHeight - bboxH) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = pxWidth;
  canvas.height = pxHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#e5e3df';
  ctx.fillRect(0, 0, pxWidth, pxHeight);

  const TILE = 256;
  const firstTx = Math.floor(originX / TILE);
  const lastTx = Math.floor((originX + pxWidth) / TILE);
  const firstTy = Math.floor(originY / TILE);
  const lastTy = Math.floor((originY + pxHeight) / TILE);
  const maxIdx = Math.pow(2, zoom) - 1;
  const subs = ['a', 'b', 'c'];

  const jobs: Promise<{ img: HTMLImageElement | null; tx: number; ty: number }>[] = [];
  for (let tx = firstTx; tx <= lastTx; tx++) {
    for (let ty = firstTy; ty <= lastTy; ty++) {
      if (tx < 0 || ty < 0 || tx > maxIdx || ty > maxIdx) continue;
      const sub = subs[Math.abs(tx + ty * 3) % subs.length];
      const url = `https://${sub}.tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
      jobs.push(loadImage(url).then(img => ({ img, tx, ty })));
    }
  }
  const tiles = await Promise.all(jobs);

  if (isDark) ctx.filter = 'invert(100%) hue-rotate(180deg) brightness(0.95) contrast(0.9)';
  tiles.forEach(({ img, tx, ty }) => {
    if (!img) return;
    ctx.drawImage(img, tx * TILE - originX, ty * TILE - originY, TILE, TILE);
  });
  ctx.filter = 'none';

  const distances = points.map(p => p.dist);
  const gradients = points.map(p => p.gradient);
  const smoothed = smoothByDistance(gradients, distances, smoothingRadiusMeters);
  const scaleFactor = pxWidth / 700;
  ctx.lineWidth = 4 * scaleFactor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1]!;
    const p2 = points[i]!;
    const pt1 = project(p1.lat, p1.lon, zoom);
    const pt2 = project(p2.lat, p2.lon, zoom);
    ctx.strokeStyle = getGradientColor(smoothed[i]!);
    ctx.beginPath();
    ctx.moveTo(pt1.x - originX, pt1.y - originY);
    ctx.lineTo(pt2.x - originX, pt2.y - originY);
    ctx.stroke();
  }

  function latLngAtDistKm(distKm: number): { lat: number; lon: number } {
    const targetM = distKm * 1000;
    let nearest = points[0]!;
    let minDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.dist - targetM);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = p;
      }
    }
    return { lat: nearest.lat, lon: nearest.lon };
  }

  breakpoints.forEach((bp, i) => {
    const { lat, lon } = latLngAtDistKm(bp.distKm);
    const pt = project(lat, lon, zoom);
    const x = pt.x - originX;
    const y = pt.y - originY;
    const r = 4 * scaleFactor;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = markerColor(bp.fixed);
    ctx.fill();
    ctx.lineWidth = 1 * scaleFactor;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${5.5 * scaleFactor}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + scaleFactor);
  });

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
