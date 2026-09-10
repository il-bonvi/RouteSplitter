import { z } from 'zod';
import { EntityBaseSchema } from './common.js';
import { PhysicsParamsOverrideSchema } from './physicsParams.js';

/**
 * Profilo atleta. In v1 (nessun login, nessun backend — vedi stato_rs.md decisioni D2/D3)
 * esiste un solo Athlete locale per dispositivo, creato implicitamente. Il campo `coachId`
 * è già presente ma sempre `null` finché non esiste autenticazione multi-utente: questo
 * evita una migrazione di schema quando login/coach verranno introdotti.
 */
export const AthleteSchema = EntityBaseSchema.extend({
  /** null finché non esiste un vero account coach (nessun backend in v1). */
  coachId: z.string().nullable().default(null),
  name: z.string().min(1).max(120),
  weightKg: z.number().min(30).max(160).optional(),
  ftpWatts: z.number().min(30).max(600).optional(),
  /** CP/W' (D48): proprietà persistente dell'atleta, indipendente da `physicsDefaults` (che
   * modella solo l'equilibrio aerodinamico/di massa) — stessa separazione concettuale già
   * adottata in app (RouteSplitterApp) quando CP/W' erano solo stato React non persistito. */
  criticalPowerW: z.number().min(50).max(600).optional(),
  wPrimeJ: z.number().min(1000).max(60000).optional(),
  /** Sovrascrive i default fisici globali per questo atleta (es. CdA/Crr abituali). */
  physicsDefaults: PhysicsParamsOverrideSchema.optional(),
  notes: z.string().max(4000).optional()
});
export type Athlete = z.infer<typeof AthleteSchema>;

/** Payload di creazione: id/timestamp generati dal data-store, non dal chiamante. */
export const CreateAthleteInputSchema = AthleteSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true
});
export type CreateAthleteInput = z.input<typeof CreateAthleteInputSchema>;
