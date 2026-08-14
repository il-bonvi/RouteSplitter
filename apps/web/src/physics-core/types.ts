/**
 * Parametri fisici del modello di equilibrio delle forze (Martin et al.).
 * Un solo oggetto di questo tipo deve alimentare sia la predizione (velocità<->potenza)
 * sia la stima CdA sia l'ottimizzatore di pacing — mai istanze/copie divergenti.
 */
export interface PhysicsParams {
  /** Massa ciclista, kg */
  riderMassKg: number;
  /** Massa bici + kit, kg */
  bikeMassKg: number;
  /** Coefficiente aerodinamico CdA, m² */
  cda: number;
  /** Coefficiente di rotolamento Crr, adimensionale */
  crr: number;
  /** Densità dell'aria, kg/m³ */
  airDensity: number;
  /** Perdita drivetrain, in percento (es. 2 = 2%) */
  drivetrainLossPct: number;
  /** Vento, km/h, convenzione: positivo = vento contrario (in testa) */
  windKmh: number;
}

/** Un tratto di percorso a cui si assume potenza costante (usato per NP, medie, ottimizzatore). */
export interface PowerSegment {
  distanceKm: number;
  /** Pendenza media del tratto, in percento (rise/run * 100) */
  gradient: number;
  /** Potenza costante assunta sul tratto, in W */
  power: number;
}

/** Segmento "grezzo" (senza potenza ancora assegnata) su cui far lavorare l'ottimizzatore. */
export interface OptimizableSegment {
  distanceKm: number;
  gradient: number;
}
