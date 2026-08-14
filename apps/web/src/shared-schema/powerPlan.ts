import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';

/** Un segmento della griglia fine calcolata dall'ottimizzatore (vedi physics-core optimizePacing). */
export const FineGridSegmentSchema = z.object({
  d0Km: z.number().min(0),
  d1Km: z.number().min(0),
  distanceKm: z.number().min(0),
  gradient: z.number().min(-40).max(40),
  powerWatts: z.number().min(0).max(3000),
  timeHours: z.number().min(0)
});
export type FineGridSegment = z.infer<typeof FineGridSegmentSchema>;

/**
 * Piano potenza persistito: risultato di optimizePacing() su una griglia fine, associato
 * a un SectionPlan. Un SectionPlan può avere più PowerPlan nel tempo (es. target diversi
 * provati in fasi di what-if, Fase 1 roadmap F1.3) — anche questa un'entità separata,
 * non annidata, per lo stesso motivo di SectionPlan rispetto a Route.
 */
export const PowerPlanSchema = EntityBaseSchema.extend({
  sectionPlanId: IdSchema,
  stepMeters: z.number().min(20).max(5000),
  targetAvgPowerWatts: z.number().min(50).max(2000),
  targetNormalizedPowerWatts: z.number().min(50).max(2000).nullable().default(null),
  minPowerWatts: z.number().min(0).max(3000),
  maxPowerWatts: z.number().min(0).max(3000),
  segments: z.array(FineGridSegmentSchema).min(1),
  /** Risultati riassuntivi, per non dover ricalcolare tutto solo per mostrare le stats. */
  resultTimeWeightedAvgPowerWatts: z.number().min(0),
  resultNormalizedPowerWatts: z.number().min(0),
  resultTotalTimeHours: z.number().min(0)
});
export type PowerPlan = z.infer<typeof PowerPlanSchema>;

export const CreatePowerPlanInputSchema = PowerPlanSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true
});
export type CreatePowerPlanInput = z.input<typeof CreatePowerPlanInputSchema>;
