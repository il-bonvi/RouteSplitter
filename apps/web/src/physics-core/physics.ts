import type { PhysicsParams } from './types.js';

export const GRAVITY = 9.80665; // m/s^2

/**
 * CdA effettivo da usare a una data pendenza. Con `cdaTiers` assente/vuoto (caso più comune,
 * invariato rispetto a prima) restituisce sempre `params.cda` — nessun cambiamento di
 * comportamento per chi non configura nulla. Con una o più soglie, sceglie quella con la
 * pendenza-limite più alta fra quelle raggiunte dalla pendenza corrente (non serve che le
 * soglie siano ordinate in `cdaTiers`: si confrontano tutte).
 *
 * Centralizzata qui (non nei singoli chiamanti) perché `gradientPct` è già un parametro
 * esplicito di OGNI funzione fisica (wheelPowerAtSpeed, speedFromPower, powerFromSpeed) —
 * quindi la scelta del CdA propaga automaticamente a sezioni, ottimizzatore e grafico
 * potenza, ovunque venga passata la pendenza locale del tratto, senza toccare quei
 * chiamanti (stesso principio già usato per il vento per-segmento, ma qui non serve
 * nemmeno un campo di override: la pendenza è già un dato locale per costruzione).
 */
export function effectiveCda(params: PhysicsParams, gradientPct: number): number {
  const tiers = params.cdaTiers;
  if (!tiers || tiers.length === 0) return params.cda;
  let best = params.cda;
  let bestThreshold = -Infinity;
  for (const tier of tiers) {
    if (gradientPct >= tier.thresholdPct && tier.thresholdPct > bestThreshold) {
      bestThreshold = tier.thresholdPct;
      best = tier.cda;
    }
  }
  return best;
}

/**
 * Potenza alla ruota (W) necessaria per mantenere speedMS su una pendenza gradientPct,
 * dati i parametri fisici (gravità + rotolamento + aerodinamica).
 *
 * Il termine aerodinamico è "firmato" rispetto alla velocità RELATIVA (bici + vento):
 * 0.5·ρ·CdA·rel·|rel| invece di rel·rel. Con rel*rel il segno si perderebbe sempre
 * (positivo anche se il vento in coda supera la velocità di marcia), mentre fisicamente
 * in quel caso l'aria assiste la propulsione invece di frenarla. Vedi review 2026-08,
 * punto 3 ("Bug: il termine aerodinamico non è firmato rispetto al vento").
 */
export function wheelPowerAtSpeed(speedMS: number, gradientPct: number, params: PhysicsParams): number {
  const m = params.riderMassKg + params.bikeMassKg;
  const slopeRad = Math.atan(gradientPct / 100);
  const windMS = params.windKmh / 3.6;
  const rel = speedMS + windMS;
  const aero = 0.5 * params.airDensity * effectiveCda(params, gradientPct) * rel * Math.abs(rel);
  const roll = params.crr * m * GRAVITY * Math.cos(slopeRad);
  const grav = m * GRAVITY * Math.sin(slopeRad);
  return (aero + roll + grav) * speedMS;
}

/**
 * Velocità (m/s) raggiungibile con una data potenza (W) su una data pendenza, per bisezione.
 * wheelPowerAtSpeed è monotona crescente in v (l'aerodinamica domina), quindi la bisezione
 * è sempre stabile — anche in discesa, dove converge alla velocità di equilibrio "a ruota
 * libera" (drag + rotolamento = componente di gravità lungo il piano).
 */
export function speedFromPower(powerW: number, gradientPct: number, params: PhysicsParams): number {
  const effectivePower = Math.max(0, powerW * (1 - params.drivetrainLossPct / 100));
  const f = (v: number) => wheelPowerAtSpeed(v, gradientPct, params) - effectivePower;
  let lo = 0.5;
  let hi = 45;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 0.05) return mid;
    if (fm < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Potenza (W) richiesta per mantenere una data velocità (m/s) su una data pendenza.
 * Ritorna 0 se la pendenza in discesa è già sufficiente a mantenere quella velocità
 * senza pedalare (freewheeling) — in quel caso il rider dovrebbe frenare, non pedalare.
 */
export function powerFromSpeed(speedMS: number, gradientPct: number, params: PhysicsParams): number {
  if (speedMS < 0.1) return 0;
  const wheel = wheelPowerAtSpeed(speedMS, gradientPct, params);
  if (wheel <= 0) return 0;
  const eff = 1 - params.drivetrainLossPct / 100;
  return eff > 0 ? wheel / eff : wheel;
}

/**
 * Stima CdA per inversione algebrica da UN SINGOLO campione medio (velocità, potenza, pendenza).
 * Non sa se il campione rappresenta la posizione "in piano" o "in salita" — è compito di chi
 * chiama decidere a quale campo applicare il risultato (`cda` o `cdaClimbing`), tipicamente
 * in base alla pendenza del campione stesso rispetto alla soglia configurata (vedi
 * `CdaEstimator.tsx`).
 *
 * ATTENZIONE — limite noto non ancora risolto: su tratti a pendenza/vento non uniformi,
 * usare valori medi invece di una regressione multi-punto introduce un bias sistematico
 * (disuguaglianza di Jensen, la potenza richiesta non è lineare nella pendenza/velocità).
 * Da affrontare quando si amplierà la gestione del vento (vedi roadmap, Fase 3).
 */
export function estimateCda(
  speedMS: number,
  powerW: number,
  gradientPct: number,
  params: PhysicsParams
): number | null {
  if (speedMS < 0.5 || powerW < 10) return null;
  const m = params.riderMassKg + params.bikeMassKg;
  const slopeRad = Math.atan(gradientPct / 100);
  const windMS = params.windKmh / 3.6;
  const rel = speedMS + windMS;
  if (Math.abs(rel) < 0.3) return null;
  const effectivePower = powerW * (1 - params.drivetrainLossPct / 100);
  const roll = params.crr * m * GRAVITY * Math.cos(slopeRad);
  const grav = m * GRAVITY * Math.sin(slopeRad);
  const aeroForce = effectivePower / speedMS - roll - grav;
  if (aeroForce <= 0) return null;
  // Coerente con la forza di drag firmata usata in wheelPowerAtSpeed (rel*|rel|).
  const cda = (2 * aeroForce) / (params.airDensity * rel * Math.abs(rel));
  return cda > 0.1 && cda < 0.8 ? cda : null;
}
