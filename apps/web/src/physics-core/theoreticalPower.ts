import { GRAVITY, effectiveCda } from './physics.js';
import type { PhysicsParams } from './types.js';

/**
 * Campione di moto di un'attività reale — velocità/pendenza/tempo, SENZA potenza. È
 * l'input di `estimateTheoreticalPower`: a differenza di `CdaSample` (cdaFromActivity.ts) e
 * `EnergyBalanceInput` (energyBalance.ts), qui la potenza non serve perché è esattamente
 * l'incognita che si vuole ricavare — questo è ciò che rende possibile stimarla anche su
 * un'uscita senza misuratore (basta velocità dal GPS + pendenza dall'altimetria).
 */
export interface MotionSample {
  timeSec: number;
  distKm: number;
  speedMS: number;
  gradientPct: number;
  /** Vento efficace (km/h, +testa) per questo campione, se noto punto per punto (stessa
   * convenzione di `CdaSample.windKmh`). Se assente, usa `params.windKmh` (costante). */
  windKmh?: number;
}

export interface TheoreticalPowerPoint {
  timeSec: number;
  distKm: number;
  dtSec: number;
  gradientPct: number;
  speedKmh: number;
  /**
   * Potenza teorica alla pedivella (W) necessaria per produrre la variazione di velocità
   * OSSERVATA in questo intervallo, dati i parametri fisici — l'inverso esatto di
   * `computeEnergyBalance`: lì potenza reale nota → ΔEC previsto; qui ΔEC osservato (dalla
   * velocità misurata) → potenza necessaria. Include esplicitamente il termine cinetico
   * (accelerazione/decelerazione), a differenza di `powerFromSpeed` che assume equilibrio
   * stazionario — su un tratto non a velocità costante (curve, cambi di ritmo, salite non
   * uniformi) `powerFromSpeed` applicata punto per punto introdurrebbe un bias sistematico
   * con il segno dell'accelerazione, esattamente il tipo di errore che questa funzione evita.
   *
   * Clampata a 0: un ΔEC osservato più negativo di quanto aerodinamica+rotolamento+gravità
   * già spieghino implica frenata, non potenza pedalata negativa (fisicamente
   * indistinguibile da qui — vedi `isLikelyBraking` in planVsActual.ts per un'euristica
   * dedicata se serve segnalare il tratto invece di limitarsi a troncare a 0).
   */
  theoreticalPowerW: number;
}

/**
 * Ricostruisce la potenza teorica da una traccia di moto reale (velocità + pendenza +
 * tempo), invertendo l'identità di bilancio energetico usata da `computeEnergyBalance`:
 *
 *   effectivePowerW = ΔEC/dt + potenza_dissipativa + potenza_gravità
 *   theoreticalPowerW = effectivePowerW / driveEff
 *
 * `samples` deve essere ordinato per `timeSec` crescente; intervalli con `dtSec<=0`
 * (timestamp duplicati/fuori ordine) vengono saltati silenziosamente, come in
 * `computeEnergyBalance`.
 *
 * ATTENZIONE — rumore: il termine aerodinamico dipende da v² (e la potenza da v³), quindi
 * velocità grezza da GPS/device introduce un bias verso l'alto per disuguaglianza di
 * Jensen (stesso fenomeno già documentato per la stima CdA in `cdaFromActivity.ts`) — va
 * quasi sempre applicato uno smoothing (`smoothByDistance`/`smoothByTime`) su velocità e
 * pendenza PRIMA di passarle qui, non sull'output. Questa funzione non applica smoothing
 * di sua iniziativa: lascia la scelta della finestra a chi chiama (dipende dal tipo di
 * attività — outdoor rumoroso vs rullo pulito).
 *
 * ATTENZIONE — circolarità di calibrazione: la potenza ricavata è affidabile solo quanto
 * CdA/Crr/massa già calibrati (su uscite CON misuratore); su un'uscita senza misuratore non
 * c'è modo di validare quei parametri con questi stessi dati.
 */
export function estimateTheoreticalPower(samples: MotionSample[], params: PhysicsParams): TheoreticalPowerPoint[] {
  const m = params.riderMassKg + params.bikeMassKg;
  const driveEff = 1 - params.drivetrainLossPct / 100;
  const rows: TheoreticalPowerPoint[] = [];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;
    const dtSec = curr.timeSec - prev.timeSec;
    if (!(dtSec > 0)) continue;

    const v0 = prev.speedMS;
    const v1 = curr.speedMS;
    const vAvg = (v0 + v1) / 2;
    const gradientPct = (prev.gradientPct + curr.gradientPct) / 2;
    const windKmh = curr.windKmh ?? prev.windKmh ?? params.windKmh;
    const windMS = windKmh / 3.6;

    const slopeRad = Math.atan(gradientPct / 100);
    const rel = vAvg + windMS;
    const aeroN = 0.5 * params.airDensity * effectiveCda(params, gradientPct) * rel * Math.abs(rel);
    const rollN = params.crr * m * GRAVITY * Math.cos(slopeRad);
    const gravN = m * GRAVITY * Math.sin(slopeRad);

    const dissipativePowerW = (aeroN + rollN) * vAvg;
    const gravPowerW = gravN * vAvg;

    // Identità esatta: 0.5*m*(v1²-v0²) = m*vAvg*(v1-v0) — stessa forma numericamente
    // stabile già usata in computeEnergyBalance.
    const observedDeltaKeJ = m * vAvg * (v1 - v0);
    const effectivePowerW = observedDeltaKeJ / dtSec + dissipativePowerW + gravPowerW;
    const theoreticalPowerW = Math.max(0, driveEff > 0 ? effectivePowerW / driveEff : effectivePowerW);

    rows.push({
      timeSec: curr.timeSec,
      distKm: curr.distKm,
      dtSec,
      gradientPct,
      speedKmh: vAvg * 3.6,
      theoreticalPowerW
    });
  }

  return rows;
}
