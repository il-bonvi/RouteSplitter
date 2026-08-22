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
  /**
   * Soglie di pendenza opzionali per un CdA che cambia con la pendenza — molti ciclisti
   * assumono una posizione via via più eretta (meno aero) man mano che la salita si fa
   * ripida. Ogni voce vale da `thresholdPct` in su, finché non viene superata da una
   * soglia più alta della lista; sotto la soglia più bassa si usa `cda`. Non serve che
   * siano in ordine (si ordinano al momento del calcolo), e non c'è un numero fisso di
   * soglie: 0 (default, comportamento storico invariato — un solo `cda` per tutto il
   * percorso), 1, o quante servono.
   */
  cdaTiers?: { thresholdPct: number; cda: number }[];
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
  /** Componente di vento efficace su questo tratto (km/h, positivo = in testa), se nota. */
  windKmh?: number;
}

/** Segmento "grezzo" (senza potenza ancora assegnata) su cui far lavorare l'ottimizzatore. */
export interface OptimizableSegment {
  distanceKm: number;
  gradient: number;
  /**
   * Componente di vento efficace su QUESTO segmento (km/h, positivo = in testa), se nota
   * (zone vento definite). Se assente, l'ottimizzatore usa il params.windKmh scalare globale
   * passato a parte — comportamento storico, invariato quando non ci sono zone vento.
   */
  windKmh?: number;
}
