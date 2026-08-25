import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet';
import type { LatLngBoundsExpression, LatLngTuple } from 'leaflet';
import type { ProcessedPoint } from '@physics-core';
import { buildColorSegments } from '../lib/buildColorSegments.js';

interface ActivityMapProps {
  points: ProcessedPoint[];
  hoverPoint: { lat: number; lon: number } | null;
}

function FitToRoute({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [map, bounds]);
  return null;
}

/**
 * Mappa della traccia REALE di un'attività — colorata per pendenza come `RouteMap` (stesso
 * `buildColorSegments`, `ActivityDisplayPoint` è strutturalmente un `ProcessedPoint`), ma
 * senza nessuno dei concetti di pianificazione di `RouteMap` (breakpoint, zone vento,
 * modalità aggiunta): qui non si sta pianificando nulla, si sta solo guardando dove si è
 * passati e come. Se in futuro serve colorare per potenza invece che per pendenza, questo è
 * il punto giusto dove aggiungerlo (funzione di colorazione alternativa, stesso componente).
 */
export function ActivityMap({ points, hoverPoint }: ActivityMapProps) {
  const latLngs = useMemo<LatLngTuple[]>(() => points.map(p => [p.lat, p.lon]), [points]);
  const bounds = useMemo<LatLngBoundsExpression>(() => latLngs, [latLngs]);
  const segments = useMemo(() => buildColorSegments(points, 50), [points]);
  const initialCenter = latLngs[0] ?? [45.0, 11.0];

  if (latLngs.length < 2) return null;

  return (
    <div className="panel route-map">
      <MapContainer center={initialCenter} zoom={12} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {segments.map((seg, i) => (
          <Polyline key={i} positions={seg.positions} pathOptions={{ color: seg.color, weight: 4, opacity: 0.9 }} />
        ))}
        {hoverPoint && (
          <CircleMarker
            center={[hoverPoint.lat, hoverPoint.lon]}
            radius={7}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#fc5200', fillOpacity: 0.95 }}
          />
        )}
        <FitToRoute bounds={bounds} />
      </MapContainer>
    </div>
  );
}
