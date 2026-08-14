import type { Table } from 'dexie';
import { AthleteSchema, CURRENT_SCHEMA_VERSION, type Athlete, type Id } from '@shared-schema';
import { generateId, nowIso } from '../common.js';
import type { AthleteRepository } from '../types.js';

export function createAthleteRepository(table: Table<Athlete, string>): AthleteRepository {
  return {
    async create(input) {
      const now = nowIso();
      // Validazione Zod anche qui (non solo a livello UI): IndexedDB non ha uno schema
      // proprio, quindi è questo il punto in cui i dati vengono davvero garantiti corretti
      // prima di toccare il disco.
      const entity = AthleteSchema.parse({
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
    async list() {
      return table.toArray();
    },
    async update(id: Id, patch) {
      const existing = await table.get(id);
      if (!existing) throw new Error(`Athlete non trovato: ${id}`);
      const updated = AthleteSchema.parse({ ...existing, ...patch, updatedAt: nowIso() });
      await table.put(updated);
      return updated;
    },
    async delete(id: Id) {
      await table.delete(id);
    }
  };
}
