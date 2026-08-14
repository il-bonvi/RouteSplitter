import type { Route } from '@shared-schema';

interface RouteListProps {
  routes: Route[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function RouteList({ routes, selectedId, onSelect, onDelete }: RouteListProps) {
  if (routes.length === 0) return null;
  return (
    <ul className="route-list">
      {routes.map(route => (
        <li key={route.id} className={route.id === selectedId ? 'active' : ''}>
          <button className="route-list-item" onClick={() => onSelect(route.id)}>
            <span className="route-list-name">{route.name}</span>
            <span className="route-list-meta">{route.distanceKm.toFixed(1)} km</span>
          </button>
          <button
            className="route-list-delete"
            title="Elimina percorso"
            onClick={e => {
              e.stopPropagation();
              onDelete(route.id);
            }}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
