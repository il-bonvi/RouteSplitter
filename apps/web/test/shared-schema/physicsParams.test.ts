import { describe, it, expect } from 'vitest';
import { PhysicsParamsSchema, DEFAULT_PHYSICS_PARAMS, PhysicsParamsOverrideSchema } from '../../src/shared-schema/physicsParams.js';

describe('PhysicsParamsSchema', () => {
  it('accetta i parametri di default', () => {
    expect(() => PhysicsParamsSchema.parse(DEFAULT_PHYSICS_PARAMS)).not.toThrow();
  });

  it('rifiuta un CdA inserito per errore in scala sbagliata (es. 2.8 invece di 0.28)', () => {
    const bad = { ...DEFAULT_PHYSICS_PARAMS, cda: 2.8 };
    expect(() => PhysicsParamsSchema.parse(bad)).toThrow();
  });

  it('rifiuta un peso ciclista implausibile (es. refuso "7" invece di "70")', () => {
    const bad = { ...DEFAULT_PHYSICS_PARAMS, riderMassKg: 7 };
    expect(() => PhysicsParamsSchema.parse(bad)).toThrow();
  });

  it('rifiuta un Crr fuori range plausibile', () => {
    const bad = { ...DEFAULT_PHYSICS_PARAMS, crr: 1.5 };
    expect(() => PhysicsParamsSchema.parse(bad)).toThrow();
  });

  it('accetta vento negativo (coda) e positivo (testa) entro il range', () => {
    expect(() => PhysicsParamsSchema.parse({ ...DEFAULT_PHYSICS_PARAMS, windKmh: -40 })).not.toThrow();
    expect(() => PhysicsParamsSchema.parse({ ...DEFAULT_PHYSICS_PARAMS, windKmh: 40 })).not.toThrow();
  });
});

describe('PhysicsParamsOverrideSchema', () => {
  it('accetta un override parziale (solo CdA, es. bici aero specifica)', () => {
    expect(() => PhysicsParamsOverrideSchema.parse({ cda: 0.21 })).not.toThrow();
  });

  it('rifiuta comunque un valore fuori range anche in un override parziale', () => {
    expect(() => PhysicsParamsOverrideSchema.parse({ cda: 5 })).toThrow();
  });

  it('accetta un oggetto vuoto (nessun override)', () => {
    expect(() => PhysicsParamsOverrideSchema.parse({})).not.toThrow();
  });
});
