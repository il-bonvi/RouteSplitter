import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L, { type LatLngBoundsExpression, type LatLngTuple } from 'leaflet';
import type { ProcessedPoint, SectionBreakpoint } from '@physics-core';
import type { WindZoneBoundary } from '@shared-schema';
import { buildColorSegments } from '../lib/buildColorSegments.js';
import { WindCompass } from './WindCompass.js';
import { NumberField } from './NumberField.js';
import { cardinalName } from '../lib/windDisplay.js';
import { WindArrowsLayer } from './WindArrowsLayer.js';

export interface MapWindControlData {
  rangeLabel: string;
  speedKmh: number;
  directionDeg: number;
  onChangeSpeed: (speedKmh: number) => void;
  onChangeDirection: (directionDeg: number) => void;
}

interface RouteMapProps {
  points: ProcessedPoint[];
  smoothingRadiusMeters: number;
  hoverPoint: { lat: number; lon: number } | null;
  breakpoints: SectionBreakpoint[];
  addMode: boolean;
  onAddBreakpoint: (distKm: number) => void;
  onRemoveBreakpoint: (id: string) => void;
  windControl: MapWindControlData | null;
  windZones: WindZoneBoundary[];
  totalDistanceKm: number;
}

function FitToRoute({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [map, bounds]);
  return null;
}

/** Pulsante ⌖ aggiunto alla barra di zoom di Leaflet per ricentrare la vista sul percorso. */
function RecenterControl({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    let btn: HTMLAnchorElement | null = null;
    const timer = setTimeout(() => {
      const zoomBar = map.getContainer().querySelector('.leaflet-control-zoom');
      if (zoomBar) {
        btn = document.createElement('a');
        btn.href = '#';
        btn.title = 'Recentra sul percorso';
        btn.innerHTML = '⌖';
        btn.style.fontSize = '18px';
        btn.onclick = e => {
          e.preventDefault();
          map.fitBounds(bounds, { padding: [30, 30], animate: true });
        };
        zoomBar.appendChild(btn);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      btn?.remove();
    };
  }, [map, bounds]);
  return null;
}

/**
 * Bussola vento come overlay direttamente sulla mappa (non in un pannello a parte): così il
 * coach vede subito come la direzione del vento si relaziona alla direzione reale della strada,
 * cosa che una bussola isolata in un form non permette di valutare a colpo d'occhio.
 */
function WindMapControl({ data }: { data: MapWindControlData }) {
  const map = useMap();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const ctrl = new L.Control({ position: 'bottomright' });
    let div: HTMLDivElement | null = null;
    ctrl.onAdd = () => {
      div = L.DomUtil.create('div', 'map-wind-control');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      setContainer(div);
      return div;
    };
    ctrl.addTo(map);
    return () => {
      ctrl.remove();
      setContainer(null);
    };
  }, [map]);

  if (!container) return null;
  return createPortal(
    <div className="map-wind-widget">
      <div className="map-wind-range">💨 {data.rangeLabel}</div>
      <WindCompass directionDeg={data.directionDeg} onChange={data.onChangeDirection} size={104} />
      <div className="map-wind-readout">
        <NumberField step={1} min={0} value={data.speedKmh} onCommit={data.onChangeSpeed} />
        <span>km/h da {cardinalName(data.directionDeg)}</span>
      </div>
    </div>,
    container
  );
}

/** Trova il punto del percorso più vicino a un click sulla mappa, per calcolarne la distanza km. */
function findNearestDistKm(points: ProcessedPoint[], lat: number, lon: number): number {
  let nearestIdx = 0;
  let minSq = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const dSq = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
    if (dSq < minSq) {
      minSq = dSq;
      nearestIdx = i;
    }
  }
  return points[nearestIdx]!.dist / 1000;
}

function ClickToAdd({ points, addMode, onAddBreakpoint }: Pick<RouteMapProps, 'points' | 'addMode' | 'onAddBreakpoint'>) {
  useMapEvents({
    click(e) {
      if (!addMode) return;
      onAddBreakpoint(findNearestDistKm(points, e.latlng.lat, e.latlng.lng));
    }
  });
  return null;
}

function markerColor(fixed: SectionBreakpoint['fixed']): string {
  if (fixed === 'start') return '#22c55e';
  if (fixed === 'finish') return '#fc5200';
  return '#3b82f6';
}

function breakpointLatLng(points: ProcessedPoint[], distKm: number): [number, number] {
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
  return [nearest.lat, nearest.lon];
}

export function RouteMap({
  points,
  smoothingRadiusMeters,
  hoverPoint,
  breakpoints,
  addMode,
  onAddBreakpoint,
  onRemoveBreakpoint,
  windControl,
  windZones,
  totalDistanceKm
}: RouteMapProps) {
  const latLngs = useMemo<LatLngTuple[]>(() => points.map(p => [p.lat, p.lon]), [points]);
  const bounds = useMemo<LatLngBoundsExpression>(() => latLngs, [latLngs]);
  const segments = useMemo(() => buildColorSegments(points, smoothingRadiusMeters), [points, smoothingRadiusMeters]);
  const initialCenter = latLngs[0] ?? [45.0, 11.0];

  if (latLngs.length < 2) return null;

  return (
    <div className={`panel route-map${addMode ? ' add-mode' : ''}`}>
      <MapContainer center={initialCenter} zoom={12} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {segments.map((seg, i) => (
          <Polyline key={i} positions={seg.positions} pathOptions={{ color: seg.color, weight: 4, opacity: 0.9 }} />
        ))}
        {breakpoints.map((bp, i) => {
          const [lat, lon] = breakpointLatLng(points, bp.distKm);
          const icon = L.divIcon({
            className: '',
            html: `<div class="map-num-icon" style="background:${markerColor(bp.fixed)}">${i + 1}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
          });
          return (
            <Marker
              key={bp.id}
              position={[lat, lon]}
              icon={icon}
              eventHandlers={
                bp.fixed
                  ? {}
                  : {
                      click: () => onRemoveBreakpoint(bp.id)
                    }
              }
            >
              <Tooltip direction="top">
                {bp.fixed === 'start' ? 'Partenza' : bp.fixed === 'finish' ? 'Arrivo' : bp.sectionLabel || `Punto ${i + 1}`} —{' '}
                {bp.distKm.toFixed(2)} km
              </Tooltip>
            </Marker>
          );
        })}
        {hoverPoint && (
          <CircleMarker
            center={[hoverPoint.lat, hoverPoint.lon]}
            radius={7}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#fc5200', fillOpacity: 0.95 }}
          />
        )}
        <ClickToAdd points={points} addMode={addMode} onAddBreakpoint={onAddBreakpoint} />
        <FitToRoute bounds={bounds} />
        <RecenterControl bounds={bounds} />
        {windZones.length >= 2 && <WindArrowsLayer points={points} windZones={windZones} totalDistanceKm={totalDistanceKm} />}
        {windControl && <WindMapControl data={windControl} />}
      </MapContainer>
    </div>
  );
}
