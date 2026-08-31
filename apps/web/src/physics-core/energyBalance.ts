import { GRAVITY, effectiveCda } from './physics.js';
import type { PhysicsParams } from './types.js';

/**
 * Campione grezzo (o leggermente smussato nel tempo) di un'attività reale, alla cadenza
 * nativa del device — NON i bin da 100m di `planVsActual.ts`. Qui la finestra temporale fra
 * due campioni consecutivi (`dtSec`, tipicamente 1s) è abbastanza corta da non poter
 * assumere l'equilibrio stazionario di forze che usa il resto del modello (`speedFromPower`/
 * `powerFromSpeed`): in 1-5 secondi un ciclista reale non è già alla velocità di equilibrio,
 * sta accelerando o decelerando — è esattamente l'inerzia che il modello a bin ignora.
 */
export interface EnergyBalanceInput {
  timeSec: number;
  distKm: number;
  speedMS: number;
  gradientPct: number;
  powerW: number;
}

/**
 * Riga di confronto energetico fra due campioni consecutivi: quanta energia cinetica il
 * ciclista ha REALMENTE guadagnato/perso (da come cambia la velocità misurata) contro quanta
 * ne prevede il bilancio di potenza — pedalata meno le resistenze note (aerodinamica,
 * rotolamento, gravità) — nello stesso intervallo. A differenza del confronto a bin di
 * `planVsActual.ts` (che confronta VELOCITÀ MEDIE ipotizzando equilibrio istantaneo), qui
 * l'energia cinetica (`observedDeltaKeJ`) è un termine ESPLICITO del bilancio, non un
 * residuo nascosto nella differenza fra bin — è il modo corretto di isolare l'inerzia da
 * tutto il resto (calibrazione CdA/Crr, vento non modellato, frenate).
 */
export interface EnergyBalanceRow {
  timeSec: number;
  distKm: number;
  dtSec: number;
  gradientPct: number;
  speedKmh: number;
  powerW: number;
  /** Potenza dissipata da aerodinamica + rotolamento alla velocità media dell'intervallo, W. */
  dissipativePowerW: number;
  /** Potenza "spesa" contro la gravità (= variazione di energia potenziale nel tempo), W.
   * Positiva in salita, negativa in discesa (la gravità RESTITUISCE energia). */
  gravPowerW: number;
  /** Energia cinetica realmente guadagnata (positiva) o persa (negativa) nell'intervallo,
   * calcolata dalla velocità misurata: 0.5·m·(v₁²−v₀²), joule. */
  observedDeltaKeJ: number;
  /** Energia cinetica che il bilancio "potenza pedalata − dissipazioni − gravità" prevede
   * per lo stesso intervallo, joule. Se il modello fisico (massa, CdA, Crr, drivetrain,
   * vento) fosse perfetto e non ci fossero frenate, coinciderebbe con `observedDeltaKeJ`. */
  predictedDeltaKeJ: number;
  /** observedDeltaKeJ − predictedDeltaKeJ: l'energia che NESSUNA delle forze note spiega.
   * Sistematicamente negativo e concentrato in discesa ripida = quasi certamente frenata
   * (rimuove energia senza comparire come potenza negativa). Rumoroso ma senza bias
   * sistematico = i parametri fisici (massa/CdA/Crr) sono ragionevoli. Bias sistematico
   * correlato con l'ACCELERAZIONE (non con la pendenza) = segnale di inerzia non ancora
   * gestita in altro punto del modello (qui invece è già un termine esplicito, quindi un
   * residuo di questo tipo punterebbe altrove, es. massa non accurata). */
  residualJ: number;
  /** Stesso residuo espresso come potenza equivalente (residualJ / dtSec, W) — più
   * comparabile con la potenza pedalata reale per farsi un'idea della sua grandezza. */
  residualPowerW: number;
}

/**
 * Calcola il bilancio energetico fra ogni coppia di campioni consecutivi. `inputs` deve
 * essere ordinato per `timeSec` crescente; intervalli con `dtSec<=0` (timestamp duplicati/
 * fuori ordine, capitano nei file reali) vengono saltati silenziosamente.
 *
 * Il vento è preso da `params.windKmh` (scalare, non per-zona): un limite noto, coerente col
 * fatto che questa è un'analisi diagnostica su un'uscita già registrata, non un piano futuro
 * — se serve raffinare, va passato un vento medio realistico per l'uscita, non 0 di default.
 */
export function computeEnergyBalance(inputs: EnergyBalanceInput[], params: PhysicsParams): EnergyBalanceRow[] {
  const m = params.riderMassKg + params.bikeMassKg;
  const windMS = params.windKmh / 3.6;
  const driveEff = 1 - params.drivetrainLossPct / 100;
  const rows: EnergyBalanceRow[] = [];

  for (let i = 1; i < inputs.length; i++) {
    const prev = inputs[i - 1]!;
    const curr = inputs[i]!;
    const dtSec = curr.timeSec - prev.timeSec;
    if (!(dtSec > 0)) continue;

    const v0 = prev.speedMS;
    const v1 = curr.speedMS;
    const vAvg = (v0 + v1) / 2;
    const gradientPct = (prev.gradientPct + curr.gradientPct) / 2;
    const powerAvgW = (prev.powerW + curr.powerW) / 2;

    const slopeRad = Math.atan(gradientPct / 100);
    const rel = vAvg + windMS;
    const aeroN = 0.5 * params.airDensity * effectiveCda(params, gradientPct) * rel * Math.abs(rel);
    const rollN = params.crr * m * GRAVITY * Math.cos(slopeRad);
    const gravN = m * GRAVITY * Math.sin(slopeRad);

    const dissipativePowerW = (aeroN + rollN) * vAvg;
    const gravPowerW = gravN * vAvg;
    const effectivePowerW = powerAvgW * driveEff;

    // Identità esatta: 0.5*m*(v1²-v0²) = m*vAvg*(v1-v0) — evita di sommare due quadrati
    // grandi e vicini fra loro (differenza numericamente più stabile).
    const observedDeltaKeJ = m * vAvg * (v1 - v0);
    const predictedDeltaKeJ = (effectivePowerW - dissipativePowerW - gravPowerW) * dtSec;
    const residualJ = observedDeltaKeJ - predictedDeltaKeJ;

    rows.push({
      timeSec: curr.timeSec,
      distKm: curr.distKm,
      dtSec,
      gradientPct,
      speedKmh: vAvg * 3.6,
      powerW: powerAvgW,
      dissipativePowerW,
      gravPowerW,
      observedDeltaKeJ,
      predictedDeltaKeJ,
      residualJ,
      residualPowerW: residualJ / dtSec
    });
  }

  return rows;
}
