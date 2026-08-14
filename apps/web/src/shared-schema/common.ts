import { z } from 'zod';

/**
 * Versione dello schema dati. Da incrementare ad ogni modifica non retro-compatibile
 * della forma di una entità persistita (Route, SectionPlan, PowerPlan, Athlete, Bike...).
 * I file "sezioni_*.json" del prototipo originale NON avevano questo campo: in fase di
 * import legacy, l'assenza del campo va trattata come schemaVersion = 0 e migrata.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export const SchemaVersionField = z.number().int().min(0).default(CURRENT_SCHEMA_VERSION);

/** Id entità: stringa non vuota (uuid in pratica, ma non forziamo il formato qui per restare portabili). */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** Timestamp ISO 8601. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true }).or(z.string().datetime());
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const nowIso = (): IsoDateTime => new Date().toISOString();

/** Campi comuni a ogni entità persistita: id, versione schema, timestamp di audit. */
export const EntityBaseSchema = z.object({
  id: IdSchema,
  schemaVersion: SchemaVersionField,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema
});
export type EntityBase = z.infer<typeof EntityBaseSchema>;
