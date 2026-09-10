import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';

/**
 * Un pneumatico salvato per un atleta. Il Crr dipende dal pneumatico (mescola, sezione,
 * pressione, superficie tipica), NON dall'atleta — un atleta può averne diversi (asfalto
 * liscio, gravel, bagnato...) e ne sceglie uno per singola uscita/attività da analizzare, non
 * un default fisso e permanente come `physicsDefaults` su `Athlete`. Per questo è
 * un'entità a sé, non un campo su `AthleteSchema`.
 */
export const TireSchema = EntityBaseSchema.extend({
  athleteId: IdSchema,
  name: z.string().min(1).max(120),
  /** Coefficiente di rotolamento — stesso range di sanità di `PhysicsParamsSchema.crr`. */
  crr: z.number().min(0.001).max(0.03),
  notes: z.string().max(4000).optional()
});
export type Tire = z.infer<typeof TireSchema>;

export const CreateTireInputSchema = TireSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true
});
export type CreateTireInput = z.input<typeof CreateTireInputSchema>;
