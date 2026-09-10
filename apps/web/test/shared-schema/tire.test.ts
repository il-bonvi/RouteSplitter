import { describe, it, expect } from 'vitest';
import { TireSchema } from '../../src/shared-schema/tire.js';

const base = {
  id: 't1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  athleteId: 'a1',
  name: 'GP5000 asciutto',
  crr: 0.004
};

describe('TireSchema', () => {
  it('accetta un pneumatico valido', () => {
    expect(() => TireSchema.parse(base)).not.toThrow();
  });

  it('rifiuta un nome vuoto', () => {
    expect(() => TireSchema.parse({ ...base, name: '' })).toThrow();
  });

  it('rifiuta un Crr fuori range plausibile (es. refuso di scala)', () => {
    expect(() => TireSchema.parse({ ...base, crr: 0.4 })).toThrow();
    expect(() => TireSchema.parse({ ...base, crr: 0 })).toThrow();
  });

  it('richiede un athleteId', () => {
    expect(() => TireSchema.parse({ ...base, athleteId: '' })).toThrow();
  });
});
