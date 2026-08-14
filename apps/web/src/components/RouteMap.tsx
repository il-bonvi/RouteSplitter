import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L, { type LatLngBoundsExpression, type LatLngTuple } from 'leaflet';
import type { ProcessedPoint, SectionBreakpoint } from '@physics-core';
import { buildColorSegments } from '../lib/buildColorSegments.js';

interface RouteMapProps {
  points: ProcessedPoint[];
  smoothingRadiusMeters: number;
  hoverPoint: { lat: number; lon: number } | null;
  breakpoints: SectionBreakpoint[];
  addMode: boolean;
  onAddBreakpoint: (distKm: number) => void;
  onRemoveBreakpoint: (id: string) => void;
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
  onRemoveBreakpoint
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
      </MapContainer>
    </div>
  );
}
