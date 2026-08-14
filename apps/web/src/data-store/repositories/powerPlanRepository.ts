import type { Table } from 'dexie';
import { PowerPlanSchema, CURRENT_SCHEMA_VERSION, type PowerPlan, type Id } from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { PowerPlanRepository } from '../types.js';

/**
 * Nota di design: PowerPlan non ha update(), solo create()/delete(). Un ricalcolo
 * dell'ottimizzatore (nuovo target, nuovo step) genera un nuovo PowerPlan invece di
 * sovrascrivere quello precedente — utile per confrontare tentativi diversi (what-if,
 * Fase 1 roadmap F1.3) senza perdere lo storico.
 */
export function createPowerPlanRepository(table: Table<PowerPlan, string>): PowerPlanRepository {
  return {
    async create(input) {
      const now = nowIso();
      const entity = PowerPlanSchema.parse({
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
    async listBySectionPlan(sectionPlanId: Id) {
      return table.where('sectionPlanId').equals(sectionPlanId).toArray();
    },
    async delete(id: Id) {
      await table.delete(id);
    }
  };
}
