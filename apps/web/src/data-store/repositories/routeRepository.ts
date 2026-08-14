import type { Table } from 'dexie';
import {
  RouteSchema,
  RoutePointsPayloadSchema,
  CURRENT_SCHEMA_VERSION,
  type Route,
  type RoutePointsPayload,
  type RawTrackPoint,
  type Id
} from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { RouteRepository } from '../types.js';

export function createRouteRepository(
  routesTable: Table<Route, string>,
  pointsTable: Table<RoutePointsPayload, string>
): RouteRepository {
  return {
    async create(input, points: RawTrackPoint[]) {
      const now = nowIso();
      const id = generateId();
      const route = RouteSchema.parse({
        ...input,
        id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now
      });
      const payload = RoutePointsPayloadSchema.parse({
        routeId: id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        points
      });
      // Le due scritture devono restare coerenti: se una fallisse a metà, meglio non
      // lasciare un percorso "orfano" senza punti o viceversa.
      await routesTable.db.transaction('rw', routesTable, pointsTable, async () => {
        await routesTable.add(route);
        await pointsTable.add(payload);
      });
      return route;
    },
    async get(id: Id) {
      const found = await routesTable.get(id);
      return found ?? null;
    },
    async getPoints(id: Id) {
      const payload = await pointsTable.get(id);
      return payload ? payload.points : null;
    },
    async listByAthlete(athleteId: Id | null) {
      if (athleteId === null) {
        // IndexedDB non indicizza in modo affidabile i valori null: scan filtrato,
        // accettabile per un dataset locale di dimensioni personali.
        return routesTable.filter(r => r.athleteId === null).toArray();
      }
      return routesTable.where('athleteId').equals(athleteId).toArray();
    },
    async update(id: Id, patch) {
      const existing = await routesTable.get(id);
      if (!existing) throw new Error(`Route non trovata: ${id}`);
      const updated = RouteSchema.parse({ ...existing, ...patch, updatedAt: nowIso() });
      await routesTable.put(updated);
      return updated;
    },
    async delete(id: Id) {
      await routesTable.db.transaction('rw', routesTable, pointsTable, async () => {
        await routesTable.delete(id);
        await pointsTable.delete(id);
      });
    }
  };
}
