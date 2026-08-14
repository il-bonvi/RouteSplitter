import type { Table } from 'dexie';
import { ActivitySchema, CURRENT_SCHEMA_VERSION, type Activity, type Id } from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { ActivityRepository } from '../types.js';

export function createActivityRepository(table: Table<Activity, string>): ActivityRepository {
  return {
    async create(input) {
      const now = nowIso();
      const entity = ActivitySchema.parse({
        ...input,
        id: generateId(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now
      });
      await table.add(entity);
      return entity;
    },
    async get(id: Id) {
      const found = await table.get(id);
      return found ?? null;
    },
    async listByAthlete(athleteId: Id) {
      return table.where('athleteId').equals(athleteId).toArray();
    },
    async listByRoute(routeId: Id) {
      return table.where('routeId').equals(routeId).toArray();
    },
    async delete(id: Id) {
      await table.delete(id);
    }
  };
}
