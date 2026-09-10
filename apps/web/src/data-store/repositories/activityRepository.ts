import type { Table } from 'dexie';
import {
  ActivitySchema,
  ActivityPointsPayloadSchema,
  CURRENT_SCHEMA_VERSION,
  type Activity,
  type ActivityPointsPayload,
  type ActivityTrackPointRecord,
  type Id
} from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { ActivityRepository } from '../types.js';

export function createActivityRepository(
  activitiesTable: Table<Activity, string>,
  pointsTable: Table<ActivityPointsPayload, string>
): ActivityRepository {
  return {
    async create(input, points: ActivityTrackPointRecord[]) {
      const now = nowIso();
      const id = generateId();
      const activity = ActivitySchema.parse({
        ...input,
        id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now
      });
      const payload = ActivityPointsPayloadSchema.parse({
        activityId: id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        points
      });
      // Stessa cautela di routeRepository.create: le due scritture devono restare coerenti,
      // mai un'attività orfana senza punti o viceversa.
      await activitiesTable.db.transaction('rw', activitiesTable, pointsTable, async () => {
        await activitiesTable.add(activity);
        await pointsTable.add(payload);
      });
      return activity;
    },
    async get(id: Id) {
      const found = await activitiesTable.get(id);
      return found ?? null;
    },
    async getPoints(id: Id) {
      const payload = await pointsTable.get(id);
      return payload ? payload.points : null;
    },
    async listByAthlete(athleteId: Id) {
      return activitiesTable.where('athleteId').equals(athleteId).toArray();
    },
    async listByRoute(routeId: Id) {
      return activitiesTable.where('routeId').equals(routeId).toArray();
    },
    async delete(id: Id) {
      await activitiesTable.db.transaction('rw', activitiesTable, pointsTable, async () => {
        await activitiesTable.delete(id);
        await pointsTable.delete(id);
      });
    }
  };
}
