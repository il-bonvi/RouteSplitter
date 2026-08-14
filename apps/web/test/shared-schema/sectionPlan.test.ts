import { describe, it, expect } from 'vitest';
import { SectionPlanSchema, CreateSectionPlanInputSchema } from '../../src/shared-schema/sectionPlan.js';
import { nowIso } from '../../src/shared-schema/common.js';

const validBreakpoints = [
  { id: 'bp1', distKm: 0, fixed: 'start' as const, sectionLabel: null, speedKmh: null, powerWatts: null },
  { id: 'bp2', distKm: 20, fixed: 'finish' as const, sectionLabel: 'S1', speedKmh: 38, powerWatts: null }
];

describe('SectionPlanSchema', () => {
  it('accetta un piano valido con breakpoint start/finish corretti', () => {
    const now = nowIso();
    expect(() =>
      SectionPlanSchema.parse({
        id: 'sp1',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        routeId: 'route-1',
        name: 'Piano gara',
        calcMode: 'speed',
        defaultSpeedKmh: 40,
        breakpoints: validBreakpoints
      })
    ).not.toThrow();
  });

  it('rifiuta un piano il cui primo breakpoint non è "start"', () => {
    const now = nowIso();
    const badBreakpoints = [{ ...validBreakpoints[0]!, fixed: false as const }, validBreakpoints[1]!];
    expect(() =>
      SectionPlanSchema.parse({
        id: 'sp1',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        routeId: 'route-1',
        name: 'Piano gara',
        calcMode: 'speed',
        defaultSpeedKmh: 40,
        breakpoints: badBreakpoints
      })
    ).toThrow();
  });

  it('rifiuta un piano con meno di 2 breakpoint', () => {
    const now = nowIso();
    expect(() =>
      SectionPlanSchema.parse({
        id: 'sp1',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        routeId: 'route-1',
        name: 'Piano gara',
        calcMode: 'speed',
        defaultSpeedKmh: 40,
        breakpoints: [validBreakpoints[0]!]
      })
    ).toThrow();
  });
});

describe('CreateSectionPlanInputSchema', () => {
  it('applica lo stesso vincolo start/finish anche in creazione', () => {
    expect(() =>
      CreateSectionPlanInputSchema.parse({
        routeId: 'route-1',
        calcMode: 'power',
        breakpoints: [{ ...validBreakpoints[1]!, fixed: 'start' as const }, validBreakpoints[0]!]
      })
    ).toThrow();
  });
});
