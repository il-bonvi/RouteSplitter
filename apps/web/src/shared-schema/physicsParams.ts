import { z } from 'zod';

/**
 * Parametri fisici del modello di equilibrio delle forze. Stesso schema logico di
 * PhysicsParams in @routesplitter/physics-core, ma qui con BOUND DI SANITÀ espliciti —
 * la review del prototipo originale segnalava l'assenza totale di validazione su questi
 * campi (es. un refuso "CdA=2.8" invece di "0.28" passava silenzioso e produceva
 * previsioni assurde). I range sono ampi ma escludono valori fisicamente/fisiologicamente
 * impossibili per il ciclismo su strada; non sono limiti "di gara" ma guardrail anti-errore.
 */
export const PhysicsParamsSchema = z.object({
  /** Massa ciclista, kg. Range plausibile ciclismo adulto. */
  riderMassKg: z.number().min(30).max(160),
  /** Massa bici + kit (borracce, sacche...), kg. */
  bikeMassKg: z.number().min(3).max(30),
  /** Coefficiente aerodinamico CdA, m². Posizione aero estrema ~0.19, MTB eretto ~0.5+. */
  cda: z.number().min(0.15).max(0.6),
  /** Coefficiente di rotolamento Crr. Asfalto liscio ~0.002-0.003, gravel/MTB fino a ~0.02. */
  crr: z.number().min(0.001).max(0.03),
  /** Densità dell'aria, kg/m³. Da livello del mare (~1.29) a quote elevate (~0.9 oltre 3000m). */
  airDensity: z.number().min(0.7).max(1.35),
  /** Perdita drivetrain, in percento (es. 2 = 2%). Catena pulita/sporca. */
  drivetrainLossPct: z.number().min(0).max(10),
  /**
   * Vento, km/h, positivo = contrario (in testa). Range ampio per condizioni estreme.
   * NOTA: per i calcoli sul percorso (tabella sezioni, report, ecc.) questo campo NON è più
   * la fonte del vento — è sovrascritto per-sezione dalle zone vento direzionali (pannello
   * 💨 Vento, physics-core/wind.ts), che tengono conto della rotta del tracciato. Resta usato
   * com'è solo dallo stimatore CdA (un calcolo puntuale, non legato al percorso).
   */
  windKmh: z.number().min(-120).max(120)
});
export type PhysicsParams = z.infer<typeof PhysicsParamsSchema>;

export const DEFAULT_PHYSICS_PARAMS: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.28,
  crr: 0.004,
  airDensity: 1.1989,
  drivetrainLossPct: 2,
  windKmh: 0
};

/**
 * Parametri fisici parzialmente sovrascritti (es. a livello di singola bici/percorso,
 * sopra i default dell'atleta). Ogni campo è opzionale; il merge con i default avviene
 * a livello applicativo, non qui.
 */
export const PhysicsParamsOverrideSchema = PhysicsParamsSchema.partial();
export type PhysicsParamsOverride = z.infer<typeof PhysicsParamsOverrideSchema>;
