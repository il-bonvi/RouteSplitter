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

describe('SectionPlanSchema — plannedStartTime e windZones.timeSamples', () => {
  it('plannedStartTime è null di default se non specificato', () => {
    const now = nowIso();
    const parsed = SectionPlanSchema.parse({
      id: 'sp1',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      routeId: 'route-1',
      name: 'Piano gara',
      calcMode: 'speed',
      defaultSpeedKmh: 40,
      breakpoints: validBreakpoints
    });
    expect(parsed.plannedStartTime).toBeNull();
  });

  it('accetta un plannedStartTime "HH:mm" valido', () => {
    const now = nowIso();
    const parsed = SectionPlanSchema.parse({
      id: 'sp1',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      routeId: 'route-1',
      name: 'Piano gara',
      calcMode: 'speed',
      defaultSpeedKmh: 40,
      breakpoints: validBreakpoints,
      plannedStartTime: '07:30'
    });
    expect(parsed.plannedStartTime).toBe('07:30');
  });

  it('rifiuta un plannedStartTime malformato', () => {
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
        breakpoints: validBreakpoints,
        plannedStartTime: '25:99'
      })
    ).toThrow();
  });

  it('windZones.timeSamples è vuoto di default (comportamento storico)', () => {
    const now = nowIso();
    const parsed = SectionPlanSchema.parse({
      id: 'sp1',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      routeId: 'route-1',
      name: 'Piano gara',
      calcMode: 'speed',
      defaultSpeedKmh: 40,
      breakpoints: validBreakpoints,
      windZones: [
        { id: 'ws', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
        { id: 'wf', distKm: 20, fixed: 'finish', speedKmh: 10, directionDeg: 90 }
      ]
    });
    expect(parsed.windZones[1]!.timeSamples).toEqual([]);
  });

  it('pacingStepMeters è 100 di default se non specificato', () => {
    const now = nowIso();
    const parsed = SectionPlanSchema.parse({
      id: 'sp1',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      routeId: 'route-1',
      name: 'Piano gara',
      calcMode: 'speed',
      defaultSpeedKmh: 40,
      breakpoints: validBreakpoints
    });
    expect(parsed.pacingStepMeters).toBe(100);
  });

  it('accetta un pacingStepMeters valido esplicito', () => {
    const now = nowIso();
    const parsed = SectionPlanSchema.parse({
      id: 'sp1',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      routeId: 'route-1',
      name: 'Piano gara',
      calcMode: 'speed',
      defaultSpeedKmh: 40,
      breakpoints: validBreakpoints,
      pacingStepMeters: 500
    });
    expect(parsed.pacingStepMeters).toBe(500);
  });

  it('rifiuta un pacingStepMeters sotto i 50m', () => {
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
        breakpoints: validBreakpoints,
        pacingStepMeters: 10
      })
    ).toThrow();
  });

  it('accetta timeSamples validi su una zona vento', () => {
    const now = nowIso();
    const parsed = SectionPlanSchema.parse({
      id: 'sp1',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      routeId: 'route-1',
      name: 'Piano gara',
      calcMode: 'speed',
      defaultSpeedKmh: 40,
      breakpoints: validBreakpoints,
      windZones: [
        { id: 'ws', distKm: 0, fixed: 'start', speedKmh: null, directionDeg: null },
        {
          id: 'wf',
          distKm: 20,
          fixed: 'finish',
          speedKmh: 10,
          directionDeg: 90,
          timeSamples: [{ id: 't1', minuteOfDay: 480, speedKmh: 12, directionDeg: 80 }]
        }
      ]
    });
    expect(parsed.windZones[1]!.timeSamples).toHaveLength(1);
  });
});
