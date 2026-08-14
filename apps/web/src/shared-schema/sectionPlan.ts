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

export const CalcModeSchema = z.union([z.literal('speed'), z.literal('power')]);
export type CalcMode = z.infer<typeof CalcModeSchema>;

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
  breakpoints: z.array(BreakpointSchema).min(2)
}).refine(val => startsAndEndsFixed(val.breakpoints), {
  message: 'Il primo breakpoint deve essere "start" e l\'ultimo "finish".'
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
    breakpoints: z.array(BreakpointSchema).min(2)
  })
  .refine(val => startsAndEndsFixed(val.breakpoints), {
    message: 'Il primo breakpoint deve essere "start" e l\'ultimo "finish".'
  });
export type CreateSectionPlanInput = z.input<typeof CreateSectionPlanInputSchema>;
