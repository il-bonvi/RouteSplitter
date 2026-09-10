import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';
import { PhysicsParamsSchema } from './physicsParams.js';

/**
 * Punto grezzo di un'attività (Tab 2) — a differenza di `RawTrackPointSchema` (percorsi
 * pianificati, solo lat/lon/ele) qui servono anche tempo e potenza: sono il dato REGISTRATO
 * su cui si ricalcolano CdA/vento ogni volta che l'attività viene riaperta, non un riassunto.
 * Stessa forma di `ActivityTrackPoint` (activity/parseActivityFile.ts, lato app) — duplicata
 * qui invece di importata perché quel tipo vive nel codice applicativo (parsing), non nello
 * schema condiviso, e `shared-schema` non deve dipendere da `apps/web/src/activity`.
 */
export const ActivityTrackPointSchema = z.object({
  lat: z.number().min(-90).max(90).finite(),
  lon: z.number().min(-180).max(180).finite(),
  ele: z.number().min(-500).max(9000).finite().nullable(),
  timeSec: z.number().min(0).finite(),
  powerW: z.number().min(0).finite().nullable(),
  distM: z.number().min(0).finite().nullable()
});
export type ActivityTrackPointRecord = z.infer<typeof ActivityTrackPointSchema>;

export const ActivityPointsPayloadSchema = z.object({
  activityId: IdSchema,
  schemaVersion: z.number().int().min(0),
  points: z.array(ActivityTrackPointSchema).min(2)
});
export type ActivityPointsPayload = z.infer<typeof ActivityPointsPayloadSchema>;

/**
 * Metadati di un'attività salvata (Tab 2) — i punti grezzi (potenzialmente migliaia) vivono
 * in un payload separato (`ActivityPointsPayload`, stesso `id` come chiave), stessa scelta di
 * modellazione già presa per `RouteSchema`/`RoutePointsPayload` (D10) e per lo stesso motivo:
 * non appesantire ogni lettura della sola lista "uscite salvate".
 *
 * `physicsParamsSnapshot` + `windSpeedKmh`/`windDirectionDeg` + `sectionBreakpointsKm`
 * catturano le condizioni usate per QUESTA analisi (D52/D53/D54: Crr, drivetrain loss,
 * densità aria... cambiano da uscita a uscita) — senza questo, riaprire un'attività salvata
 * userebbe qualunque valore sia rimasto impostato altrove al momento della riapertura,
 * vanificando lo scopo di uno storico ("che valori avevo usato per QUESTA gara?").
 */
export const ActivitySchema = EntityBaseSchema.extend({
  athleteId: IdSchema,
  routeId: IdSchema.nullable().default(null),
  powerPlanId: IdSchema.nullable().default(null),
  sourceFileName: z.string().max(300),
  activityDate: z.string().datetime().or(z.string().datetime({ offset: true })),
  summary: z.object({
    durationHours: z.number().min(0),
    distanceKm: z.number().min(0),
    avgPowerWatts: z.number().min(0).optional(),
    normalizedPowerWatts: z.number().min(0).optional(),
    elevationGain: z.number().min(0).optional()
  }),
  physicsParamsSnapshot: PhysicsParamsSchema,
  windSpeedKmh: z.number().default(0),
  windDirectionDeg: z.number().min(0).max(360).default(0),
  /** Solo le distanze dei breakpoint manuali (F3.4) — id/etichette/target vengono rigenerati
   * alla riapertura (`generateId()`), non hanno senso persistiti: sono UI state, non dati. */
  sectionBreakpointsKm: z.array(z.number().min(0)).default([])
});
export type Activity = z.infer<typeof ActivitySchema>;

export const CreateActivityInputSchema = ActivitySchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true
});
export type CreateActivityInput = z.input<typeof CreateActivityInputSchema>;
