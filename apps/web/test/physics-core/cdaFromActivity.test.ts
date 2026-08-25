import { describe, it, expect } from 'vitest';
import {
  estimateCdaFromSamples,
  bucketSamplesByTier,
  bucketSamplesByDistance,
  bucketSamplesByBreakpoints,
  type CdaSample
} from '../../src/physics-core/cdaFromActivity.js';
import { wheelPowerAtSpeed } from '../../src/physics-core/physics.js';
import type { PhysicsParams } from '../../src/physics-core/types.js';

const baseParams: PhysicsParams = {
  riderMassKg: 70,
  bikeMassKg: 9,
  cda: 0.3,
  crr: 0.004,
  airDensity: 1.2,
  drivetrainLossPct: 2,
  windKmh: 0
};

/** Costruisce un campione "perfetto" (nessun rumore) coerente col modello fisico, dato un
 * CdA vero da recuperare — potenza calcolata da wheelPowerAtSpeed/efficienza drivetrain,
 * così la regressione deve ritrovare esattamente (a meno di arrotondamenti) lo stesso CdA. */
function syntheticSample(speedMS: number, gradientPct: number, trueCda: number, windKmh = 0): CdaSample {
  const params = { ...baseParams, cda: trueCda, windKmh };
  const wheelPower = wheelPowerAtSpeed(speedMS, gradientPct, params);
  const powerW = wheelPower / (1 - params.drivetrainLossPct / 100);
  return { speedMS, powerW, gradientPct, windKmh };
}

function syntheticRide(trueCda: number, n = 60): CdaSample[] {
  const samples: CdaSample[] = [];
  for (let i = 0; i < n; i++) {
    // varia velocità e pendenza per evitare un caso degenere (tutti i punti identici)
    const speedMS = 6 + (i % 7); // 6..12 m/s
    const gradientPct = -4 + (i % 9); // -4..4 %
    samples.push(syntheticSample(speedMS, gradientPct, trueCda));
  }
  return samples;
}

describe('estimateCdaFromSamples — recupero esatto su dati sintetici senza rumore', () => {
  it('ritrova il CdA vero da tanti campioni puliti a pendenza/velocità variabile', () => {
    const samples = syntheticRide(0.32);
    const result = estimateCdaFromSamples(samples, baseParams);
    expect(result).not.toBeNull();
    expect(result!.cda).toBeCloseTo(0.32, 3);
    expect(result!.usedSamples).toBeGreaterThanOrEqual(20);
    expect(result!.stdDev).toBeCloseTo(0, 6);
  });

  it('funziona anche con vento noto per-campione, diverso da params.windKmh', () => {
    const samples: CdaSample[] = [];
    for (let i = 0; i < 40; i++) {
      const speedMS = 7 + (i % 5);
      const gradientPct = i % 6;
      samples.push(syntheticSample(speedMS, gradientPct, 0.28, 8));
    }
    // params.windKmh resta 0: la regressione deve usare il vento per-campione (8 km/h), non 0
    const result = estimateCdaFromSamples(samples, baseParams);
    expect(result).not.toBeNull();
    expect(result!.cda).toBeCloseTo(0.28, 3);
  });

  it('è robusto a rumore casuale moderato: la stima resta vicina al vero valore', () => {
    const trueCda = 0.31;
    const samples: CdaSample[] = [];
    let seed = 42;
    const rand = () => {
      // PRNG deterministico banale, per test riproducibili senza dipendenze esterne
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const speedMS = 5 + (i % 11);
      const gradientPct = -6 + (i % 13);
      const clean = syntheticSample(speedMS, gradientPct, trueCda);
      // rumore ±3% sulla potenza misurata, tipico di dati di campo
      const noisyPower = clean.powerW * (1 + (rand() - 0.5) * 0.06);
      samples.push({ ...clean, powerW: noisyPower });
    }
    const result = estimateCdaFromSamples(samples, baseParams);
    expect(result).not.toBeNull();
    expect(result!.cda).toBeCloseTo(trueCda, 1); // entro 0.05 m² con rumore ±3%
  });

  it('ritorna null con troppo pochi campioni validi', () => {
    const samples = syntheticRide(0.3, 10);
    expect(estimateCdaFromSamples(samples, baseParams)).toBeNull();
  });

  it('scarta campioni fermi/troppo lenti (potenza o velocità sotto soglia)', () => {
    // solo salita/piano (nessuna discesa): garantisce potenza sempre ben sopra i 10W,
    // così l'unico campione filtrato è quello fermo aggiunto esplicitamente
    const samples: CdaSample[] = [];
    for (let i = 0; i < 30; i++) {
      samples.push(syntheticSample(6 + (i % 6), i % 8, 0.3));
    }
    samples.push({ speedMS: 0.2, powerW: 5, gradientPct: 0 }); // sotto soglia di validità
    const result = estimateCdaFromSamples(samples, baseParams);
    expect(result).not.toBeNull();
    expect(result!.totalSamples).toBe(31);
    expect(result!.usedSamples).toBe(30); // il campione fermo non viene usato
  });

  it('ritorna null se non ci sono campioni', () => {
    expect(estimateCdaFromSamples([], baseParams)).toBeNull();
  });
});

describe('bucketSamplesByTier', () => {
  it('senza soglie configurate, restituisce un solo bucket "base" con tutti i campioni', () => {
    const samples = syntheticRide(0.3, 25);
    const buckets = bucketSamplesByTier(samples, baseParams);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.target).toBe('base');
    expect(buckets[0]!.samples).toHaveLength(25);
  });

  it('con soglie configurate, smista ogni campione nel bucket della soglia più alta raggiunta', () => {
    const params: PhysicsParams = {
      ...baseParams,
      cdaTiers: [
        { thresholdPct: 4, cda: 0.32 },
        { thresholdPct: 8, cda: 0.34 }
      ]
    };
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0 }, // base
      { speedMS: 8, powerW: 200, gradientPct: 3.9 }, // base (sotto la prima soglia)
      { speedMS: 6, powerW: 250, gradientPct: 5 }, // soglia 4%
      { speedMS: 4, powerW: 300, gradientPct: 9 } // soglia 8%
    ];
    const buckets = bucketSamplesByTier(samples, params);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]!.target).toBe('base');
    expect(buckets[0]!.samples).toHaveLength(2);
    expect(buckets[1]!.target).toBe(0);
    expect(buckets[1]!.thresholdPct).toBe(4);
    expect(buckets[1]!.samples).toHaveLength(1);
    expect(buckets[2]!.target).toBe(1);
    expect(buckets[2]!.thresholdPct).toBe(8);
    expect(buckets[2]!.samples).toHaveLength(1);
  });

  it('non richiede che le soglie siano ordinate in cdaTiers (stessa garanzia di effectiveCda)', () => {
    const params: PhysicsParams = {
      ...baseParams,
      cdaTiers: [
        { thresholdPct: 8, cda: 0.34 },
        { thresholdPct: 4, cda: 0.32 }
      ]
    };
    const samples: CdaSample[] = [{ speedMS: 5, powerW: 280, gradientPct: 9 }];
    const buckets = bucketSamplesByTier(samples, params);
    // la soglia dell'8% (indice 0 nell'array) deve vincere anche se elencata per prima
    const nonEmpty = buckets.find(b => b.samples.length > 0);
    expect(nonEmpty!.thresholdPct).toBe(8);
  });
});

describe('bucketSamplesByDistance', () => {
  it('divide i campioni in tratti di lunghezza fissa in base a distKm', () => {
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 0.5 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 4.9 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 5.1 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 9.9 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 10.5 }
    ];
    const buckets = bucketSamplesByDistance(samples, 5);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ fromKm: 0, toKm: 5 });
    expect(buckets[0]!.samples).toHaveLength(2);
    expect(buckets[1]).toMatchObject({ fromKm: 5, toKm: 10 });
    expect(buckets[1]!.samples).toHaveLength(2);
    expect(buckets[2]).toMatchObject({ fromKm: 10, toKm: 15 });
    expect(buckets[2]!.samples).toHaveLength(1);
  });

  it('ignora i campioni senza distKm', () => {
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 1 },
      { speedMS: 8, powerW: 200, gradientPct: 0 } // senza distKm
    ];
    const buckets = bucketSamplesByDistance(samples, 5);
    const total = buckets.reduce((sum, b) => sum + b.samples.length, 0);
    expect(total).toBe(1);
  });

  it('ritorna array vuoto senza campioni con distKm o con sectionKm non positivo', () => {
    expect(bucketSamplesByDistance([{ speedMS: 8, powerW: 200, gradientPct: 0 }], 5)).toEqual([]);
    expect(bucketSamplesByDistance([{ speedMS: 8, powerW: 200, gradientPct: 0, distKm: 1 }], 0)).toEqual([]);
  });
});

describe('bucketSamplesByBreakpoints', () => {
  it('divide i campioni fra i breakpoint scelti dall\'utente', () => {
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 1 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 4 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 6 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 12 }
    ];
    const buckets = bucketSamplesByBreakpoints(samples, [5, 10]);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ fromKm: 0, toKm: 5 });
    expect(buckets[0]!.samples).toHaveLength(2);
    expect(buckets[1]).toMatchObject({ fromKm: 5, toKm: 10 });
    expect(buckets[1]!.samples).toHaveLength(1);
    expect(buckets[2]).toMatchObject({ fromKm: 10, toKm: Infinity });
    expect(buckets[2]!.samples).toHaveLength(1);
  });

  it('senza breakpoint, un solo bucket con tutti i campioni con distKm', () => {
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 1 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 4 }
    ];
    const buckets = bucketSamplesByBreakpoints(samples, []);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ fromKm: 0, toKm: Infinity });
    expect(buckets[0]!.samples).toHaveLength(2);
  });

  it('deduplica e ordina breakpoint non ordinati/duplicati', () => {
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 3 },
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 7 }
    ];
    const buckets = bucketSamplesByBreakpoints(samples, [5, 5, 2]);
    expect(buckets.map(b => b.fromKm)).toEqual([0, 2, 5]);
  });

  it('ignora i campioni senza distKm', () => {
    const samples: CdaSample[] = [
      { speedMS: 8, powerW: 200, gradientPct: 0, distKm: 1 },
      { speedMS: 8, powerW: 200, gradientPct: 0 }
    ];
    const buckets = bucketSamplesByBreakpoints(samples, [5]);
    const total = buckets.reduce((sum, b) => sum + b.samples.length, 0);
    expect(total).toBe(1);
  });
});
