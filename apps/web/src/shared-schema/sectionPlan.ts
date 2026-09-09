import { z } from 'zod';
import { EntityBaseSchema, IdSchema } from './common.js';

/** Un punto di sezione (breakpoint) sul percorso — posizione continua in km, non agganciata alla risoluzione GPX. */
export const BreakpointSchema = z.object({
  id: IdSchema,
  distKm: z.number().min(0),
  /** 'start'/'finish' = punti fissi non rimovibili; false = punto intermedio modificabile. */
  fixed: z.union([z.literal('start'), z.literal('finish'), z.literal(false)]),
  sectionLabel: z.string().max(120).nullable(),
  speedKmh: z.number().min(0).max(150).nullable(),
  powerWatts: z.number().min(0).max(3000).nullable()
});
export type Breakpoint = z.infer<typeof BreakpointSchema>;

/**
 * Campione vento a un'ora del giorno precisa, per una zona — vedi commento in
 * physics-core/wind.ts. Opzionale (0 = comportamento storico, vento statico).
 */
export const WindTimeSampleSchema = z.object({
  id: IdSchema,
  minuteOfDay: z.number().min(0).max(1439),
  speedKmh: z.number().min(0).max(150),
  directionDeg: z.number().min(0).max(360)
});
export type WindTimeSample = z.infer<typeof WindTimeSampleSchema>;

/** Confine di zona vento — stessa struttura concettuale dei breakpoint di sezione. */
export const WindZoneBoundarySchema = z.object({
  id: IdSchema,
  distKm: z.number().min(0),
  fixed: z.union([z.literal('start'), z.literal('finish'), z.literal(false)]),
  /** Intensità del vento, km/h. null solo per il confine 'start' (non ha un tratto precedente). */
  speedKmh: z.number().min(0).max(150).nullable(),
  /** Direzione DA cui soffia il vento, gradi bussola [0,360). null solo per 'start'. */
  directionDeg: z.number().min(0).max(360).nullable(),
  /** Vuoto/assente = vento statico (comportamento storico). Tetto a 12: oltre non ha senso
   * pratico per una singola zona (un forecast tipico copre poche ore per punto). */
  timeSamples: z.array(WindTimeSampleSchema).max(12).default([])
});
export type WindZoneBoundary = z.infer<typeof WindZoneBoundarySchema>;

export const CalcModeSchema = z.union([z.literal('speed'), z.literal('power')]);
export type CalcMode = z.infer<typeof CalcModeSchema>;

function startsAndEndsFixedWind(list: WindZoneBoundary[]): boolean {
  if (list.length === 0) return true;
  const first = list[0];
  const last = list[list.length - 1];
  return first?.fixed === 'start' && last?.fixed === 'finish';
}

/**
 * Un piano di sezionamento per un percorso. Un percorso può avere più SectionPlan nel
 * tempo (es. versioni diverse di pacing per la stessa gara) — per questo è un'entità
 * separata da Route, referenziata per id, non annidata.
 */
export const SectionPlanSchema = EntityBaseSchema.extend({
  routeId: IdSchema,
  name: z.string().min(1).max(200).default('Piano sezioni'),
  calcMode: CalcModeSchema,
  defaultSpeedKmh: z.number().min(0).max(150).default(40),
  /** Potenza (W) usata per le nuove sezioni create in modalità 'power'. */
  defaultPowerWatts: z.number().min(0).max(3000).default(250),
  /** Ordinati per distKm crescente; sempre almeno un punto 'start' e uno 'finish'. */
  breakpoints: z.array(BreakpointSchema).min(2),
  /** Vuoto = vento non configurato (equivale a 0). Se presente, stesso vincolo start/finish dei breakpoint. */
  windZones: z.array(WindZoneBoundarySchema).default([]),
  /**
   * Ora di partenza pianificata, formato "HH:mm", null = non impostata. Unica fonte per
   * "che ora è" lungo il piano: usata sia dal report PDF (già presente prima come stato
   * locale non persistito) sia — da questa versione — per interpretare i `timeSamples`
   * delle zone vento (senza un'ora di partenza nota, un campione vento a un'ora precisa
   * non si può collocare sul percorso, si ricade sul valore statico della zona).
   */
  plannedStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
  /**
   * Finestra (metri) di smoothing della pendenza locale, a gradini di 10m: 0 = grezza (nessuno
   * smoothing, un punto ogni cambio del GPX), 10, 20, ... fino a 100m — stesso spirito della
   * granularità che si vede scorrendo il grafico d3.js dell'altimetria. Usata dal motore
   * dinamico (D43) per smussare il rumore GPS/quota, e come granularità della griglia su cui
   * lavora l'ottimizzatore dinamico ("Ottimizza completo") — un solo parametro per entrambi gli
   * usi, dato che con un solo motore fisico non ha più senso tenerli separati (era
   * `pacingStepMeters`, 50-5000m, legato al vecchio ottimizzatore a microsezioni ora rimosso).
   */
  smoothingWindowMeters: z.number().min(0).max(100).multipleOf(10).default(50)
})
  .refine(val => startsAndEndsFixed(val.breakpoints), {
    message: 'Il primo breakpoint deve essere "start" e l\'ultimo "finish".'
  })
  .refine(val => startsAndEndsFixedWind(val.windZones), {
    message: 'La prima zona vento deve essere "start" e l\'ultima "finish".'
  });
export type SectionPlan = z.infer<typeof SectionPlanSchema>;

function startsAndEndsFixed(list: Breakpoint[]): boolean {
  const first = list[0];
  const last = list[list.length - 1];
  return first?.fixed === 'start' && last?.fixed === 'finish';
}

export const CreateSectionPlanInputSchema = z
  .object({
    routeId: IdSchema,
    name: z.string().min(1).max(200).default('Piano sezioni'),
    calcMode: CalcModeSchema,
    defaultSpeedKmh: z.number().min(0).max(150).default(40),
    defaultPowerWatts: z.number().min(0).max(3000).default(250),
    breakpoints: z.array(BreakpointSchema).min(2),
    windZones: z.array(WindZoneBoundarySchema).default([]),
    plannedStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
    smoothingWindowMeters: z.number().min(0).max(100).multipleOf(10).default(50)
  })
  .refine(val => startsAndEndsFixed(val.breakpoints), {
    message: 'Il primo breakpoint deve essere "start" e l\'ultimo "finish".'
  })
  .refine(val => startsAndEndsFixedWind(val.windZones), {
    message: 'La prima zona vento deve essere "start" e l\'ultima "finish".'
  });
export type CreateSectionPlanInput = z.input<typeof CreateSectionPlanInputSchema>;
