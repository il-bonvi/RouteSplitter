import type { Table } from 'dexie';
import { SectionPlanSchema, CURRENT_SCHEMA_VERSION, type SectionPlan, type Id } from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { SectionPlanRepository } from '../types.js';

export function createSectionPlanRepository(table: Table<SectionPlan, string>): SectionPlanRepository {
  return {
    async create(input) {
      const now = nowIso();
      const entity = SectionPlanSchema.parse({
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
    async listByRoute(routeId: Id) {
      return table.where('routeId').equals(routeId).toArray();
    },
    async update(id: Id, patch) {
      const existing = await table.get(id);
      if (!existing) throw new Error(`SectionPlan non trovato: ${id}`);
      const updated = SectionPlanSchema.parse({ ...existing, ...patch, updatedAt: nowIso() });
      await table.put(updated);
      return updated;
    },
    async delete(id: Id) {
      await table.delete(id);
    }
  };
}
