import { useEffect, useMemo, useRef, useState } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import type { ProcessedPoint } from '@physics-core';
import { effectiveHeadwindKmh, getInterpolatedPoint, routeBearingAtDistKm, windAtDistKm } from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';
import { headwindColor, headwindOpacity } from '../lib/windDisplay.js';

interface WindArrowsLayerProps {
  points: ProcessedPoint[];
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
}

/** Spaziatura visiva desiderata fra due frecce, in pixel schermo — indipendente dallo zoom. */
const TARGET_PX_SPACING = 90;
const MIN_SPACING_KM = 0.12;
const MAX_SPACING_KM = 6;
/** Limite di sicurezza: oltre non si guadagna leggibilità e si rischia di appesantire il pan. */
const MAX_ARROWS = 260;

/** Formula standard Web Mercator: metri per pixel a una data latitudine e livello di zoom. */
function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

function arrowIcon(rotationDeg: number, color: string, opacity: number): L.DivIcon {
  const html = `<svg width="26" height="26" viewBox="0 0 26 26" style="transform:rotate(${rotationDeg}deg);opacity:${opacity}">
    <path d="M13 2 L19 16 L13 12.5 L7 16 Z" fill="${color}" stroke="rgba(0,0,0,0.35)" stroke-width="0.6" />
  </svg>`;
  return L.divIcon({
    className: 'wind-arrow-icon',
    html,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

/**
 * Frecce vento "soffuse" sparse sulla planimetria: ogni freccia punta nella direzione VERA
 * verso cui soffia il vento locale (non relativa alla strada — quella si legge già dal
 * confronto visivo con il tracciato sotto), colorata rosso/verde come la ribbon (testa/coda)
 * e con opacità proporzionale all'intensità, così il vento debole resta leggibile ma discreto.
 * Densità adattiva: ricalcolata a ogni pan/zoom in base ai pixel effettivamente visibili,
 * in stile Windfinder/Best Bike Split, invece di un passo fisso in km.
 */
export function WindArrowsLayer({ points, windZones, totalDistanceKm }: WindArrowsLayerProps) {
  const map = useMap();
  const [tick, forceTick] = useState(0);
  const debounceRef = useRef<number | null>(null);

  useMapEvents({
    moveend: () => scheduleRecompute(),
    zoomend: () => scheduleRecompute()
  });

  function scheduleRecompute() {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => forceTick(t => t + 1), 80);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const maxAbs = useMemo(() => {
    if (windZones.length < 2 || totalDistanceKm <= 0 || points.length < 2) return 0;
    let max = 0;
    const coarseSamples = 120;
    for (let i = 0; i <= coarseSamples; i++) {
      const km = (totalDistanceKm * i) / coarseSamples;
      const wind = windAtDistKm(windZones, km);
      if (!wind) continue;
      const bearing = routeBearingAtDistKm(points, km);
      max = Math.max(max, Math.abs(effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing)));
    }
    return Math.max(max, 3);
  }, [points, windZones, totalDistanceKm]);

  const arrows = useMemo(() => {
    if (windZones.length < 2 || totalDistanceKm <= 0 || points.length < 2) return [];
    const bounds = map.getBounds();
    const center = map.getCenter();
    const mpp = metersPerPixel(center.lat, map.getZoom());
    const spacingKm = Math.min(MAX_SPACING_KM, Math.max(MIN_SPACING_KM, (TARGET_PX_SPACING * mpp) / 1000));

    const out: { key: string; lat: number; lon: number; rotationDeg: number; color: string; opacity: number }[] = [];
    for (let km = spacingKm / 2; km < totalDistanceKm; km += spacingKm) {
      const p = getInterpolatedPoint(points, km * 1000);
      if (!bounds.contains([p.lat, p.lon])) continue;
      const wind = windAtDistKm(windZones, km);
      if (!wind || wind.speedKmh <= 0) continue;
      const bearing = routeBearingAtDistKm(points, km);
      const headwindKmh = effectiveHeadwindKmh(wind.speedKmh, wind.directionDeg, bearing);
      const blowingToDeg = (wind.directionDeg + 180) % 360;
      out.push({
        key: `${km.toFixed(2)}`,
        lat: p.lat,
        lon: p.lon,
        rotationDeg: blowingToDeg,
        color: headwindColor(headwindKmh, maxAbs),
        opacity: headwindOpacity(headwindKmh, maxAbs)
      });
      if (out.length >= MAX_ARROWS) break;
    }
    return out;
    // tick forza il ricalcolo a ogni pan/zoom (i bounds della mappa non sono uno stato React)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, windZones, totalDistanceKm, maxAbs, map, tick]);

  useEffect(() => {
    const layer = L.layerGroup();
    for (const a of arrows) {
      L.marker([a.lat, a.lon], {
        icon: arrowIcon(a.rotationDeg, a.color, a.opacity),
        interactive: false,
        keyboard: false
      }).addTo(layer);
    }
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [arrows, map]);

  return null;
}
