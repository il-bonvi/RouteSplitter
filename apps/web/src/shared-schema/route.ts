import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';

/**
 * Punto grezzo di tracciato. Vincoli espliciti su lat/lon/ele: la review del prototipo
 * segnalava che coordinate NaN o mancanti si propagavano silenziosamente in tutta la
 * catena di calcolo (haversine, gradiente...) senza alcun errore visibile. Validare qui,
 * al momento del parsing GPX→dominio, blocca il problema alla fonte.
 */
export const RawTrackPointSchema = z.object({
  lat: z.number().min(-90).max(90).finite(),
  lon: z.number().min(-180).max(180).finite(),
  /** Quota in metri. Range ampio (Mar Morto ~-430m, oltre 8000m in alta quota estrema). */
  ele: z.number().min(-500).max(9000).finite()
});
export type RawTrackPoint = z.infer<typeof RawTrackPointSchema>;

export const RoutePointsPayloadSchema = z.object({
  routeId: IdSchema,
  schemaVersion: z.number().int().min(0),
  points: z.array(RawTrackPointSchema).min(2)
});
export type RoutePointsPayload = z.infer<typeof RoutePointsPayloadSchema>;

/**
 * Metadati del percorso. I punti grezzi (potenzialmente migliaia) NON sono qui dentro:
 * vivono in un payload separato (RoutePointsPayload), stesso `id` come chiave, per non
 * appesantire ogni lettura/scrittura dei soli metadati (nome, distanza, atleta associato).
 */
export const RouteSchema = EntityBaseSchema.extend({
  athleteId: IdSchema.nullable().default(null),
  name: z.string().min(1).max(200),
  sourceFileName: z.string().max(300).optional(),
  distanceKm: z.number().min(0),
  elevationGain: z.number().min(0),
  elevationLoss: z.number().min(0),
  maxElevation: z.number(),
  minElevation: z.number()
});
export type Route = z.infer<typeof RouteSchema>;

export const CreateRouteInputSchema = RouteSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true
});
export type CreateRouteInput = z.input<typeof CreateRouteInputSchema>;
