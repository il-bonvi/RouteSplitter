import { describe, it, expect } from 'vitest';
import { AthleteSchema } from '../../src/shared-schema/athlete.js';

const base = {
  id: 'a1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  coachId: null,
  name: 'Profilo principale'
};

describe('AthleteSchema', () => {
  it("accetta un atleta minimo (solo nome), CP/W'/peso opzionali", () => {
    expect(() => AthleteSchema.parse(base)).not.toThrow();
  });

  it('accetta CP e W\' entro il range plausibile', () => {
    const withCp = { ...base, criticalPowerW: 245, wPrimeJ: 22000 };
    const parsed = AthleteSchema.parse(withCp);
    expect(parsed.criticalPowerW).toBe(245);
    expect(parsed.wPrimeJ).toBe(22000);
  });

  it('rifiuta un CP fuori range plausibile (es. refuso a 2450W)', () => {
    expect(() => AthleteSchema.parse({ ...base, criticalPowerW: 2450 })).toThrow();
  });

  it('rifiuta un W\' fuori range plausibile', () => {
    expect(() => AthleteSchema.parse({ ...base, wPrimeJ: 500 })).toThrow(); // troppo basso
    expect(() => AthleteSchema.parse({ ...base, wPrimeJ: 999999 })).toThrow(); // troppo alto
  });

  it('accetta un peso plausibile e rifiuta un peso implausibile', () => {
    expect(() => AthleteSchema.parse({ ...base, weightKg: 70 })).not.toThrow();
    expect(() => AthleteSchema.parse({ ...base, weightKg: 7 })).toThrow();
  });
});
