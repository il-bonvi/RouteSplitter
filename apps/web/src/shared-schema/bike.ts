import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';
import { PhysicsParamsOverrideSchema } from './physicsParams.js';

/** Setup bici (una o più per atleta): peso, ed eventuali override di CdA/Crr specifici. */
export const BikeSchema = EntityBaseSchema.extend({
  athleteId: IdSchema,
  name: z.string().min(1).max(120),
  weightKg: z.number().min(3).max(30),
  /** Es. bici aero con CdA diverso dal default atleta; sterrato con Crr diverso. */
  physicsOverride: PhysicsParamsOverrideSchema.optional(),
  notes: z.string().max(4000).optional()
});
export type Bike = z.infer<typeof BikeSchema>;

export const CreateBikeInputSchema = BikeSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true
});
export type CreateBikeInput = z.input<typeof CreateBikeInputSchema>;
