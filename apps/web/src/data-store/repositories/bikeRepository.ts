import type { Table } from 'dexie';
import { BikeSchema, CURRENT_SCHEMA_VERSION, type Bike, type Id } from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { BikeRepository } from '../types.js';

export function createBikeRepository(table: Table<Bike, string>): BikeRepository {
  return {
    async create(input) {
      const now = nowIso();
      const entity = BikeSchema.parse({
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
    async update(id: Id, patch) {
      const existing = await table.get(id);
      if (!existing) throw new Error(`Bike non trovata: ${id}`);
      const updated = BikeSchema.parse({ ...existing, ...patch, updatedAt: nowIso() });
      await table.put(updated);
      return updated;
    },
    async delete(id: Id) {
      await table.delete(id);
    }
  };
}
