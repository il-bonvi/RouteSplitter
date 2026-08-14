import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';

/**
 * STUB — non ancora usato dall'app (Fase 3 roadmap, F3.3 "Plan vs actual").
 * Riservo qui la forma minima per non dover reinventare/migrare lo schema quando si
 * implementerà l'import di attività reali (FIT/GPX+potenza) da confrontare col piano.
 */
export const ActivitySchema = EntityBaseSchema.extend({
  athleteId: IdSchema,
  routeId: IdSchema.nullable().default(null),
  powerPlanId: IdSchema.nullable().default(null),
  sourceFileName: z.string().max(300),
  activityDate: z.string().datetime().or(z.string().datetime({ offset: true })),
  /** Riassunto minimo: il dettaglio (serie temporale) vive altrove, come per RoutePointsPayload. */
  summary: z.object({
    durationHours: z.number().min(0),
    distanceKm: z.number().min(0),
    avgPowerWatts: z.number().min(0).optional(),
    normalizedPowerWatts: z.number().min(0).optional(),
    elevationGain: z.number().min(0).optional()
  })
});
export type Activity = z.infer<typeof ActivitySchema>;
