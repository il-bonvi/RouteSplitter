import { describe, it, expect } from 'vitest';
import { ActivitySchema, ActivityPointsPayloadSchema } from '../../src/shared-schema/activity.js';
import { DEFAULT_PHYSICS_PARAMS } from '../../src/shared-schema/physicsParams.js';

const baseActivity = {
  id: 'act1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  athleteId: 'a1',
  routeId: null,
  powerPlanId: null,
  sourceFileName: 'trevigiana.fit',
  activityDate: '2026-06-01T08:00:00.000Z',
  summary: { durationHours: 1.2, distanceKm: 40 },
  physicsParamsSnapshot: DEFAULT_PHYSICS_PARAMS
};

describe('ActivitySchema', () => {
  it('accetta un\'attività minima con solo i campi obbligatori', () => {
    expect(() => ActivitySchema.parse(baseActivity)).not.toThrow();
  });

  it('applica i default per vento e breakpoint quando omessi', () => {
    const parsed = ActivitySchema.parse(baseActivity);
    expect(parsed.windSpeedKmh).toBe(0);
    expect(parsed.windDirectionDeg).toBe(0);
    expect(parsed.sectionBreakpointsKm).toEqual([]);
  });

  it('accetta uno snapshot fisico completo + condizioni di questa uscita', () => {
    const withConditions = {
      ...baseActivity,
      windSpeedKmh: 12,
      windDirectionDeg: 270,
      sectionBreakpointsKm: [10, 25.5]
    };
    const parsed = ActivitySchema.parse(withConditions);
    expect(parsed.windSpeedKmh).toBe(12);
    expect(parsed.sectionBreakpointsKm).toEqual([10, 25.5]);
  });

  it('rifiuta uno snapshot fisico non plausibile (propaga i guardrail di PhysicsParamsSchema)', () => {
    const bad = { ...baseActivity, physicsParamsSnapshot: { ...DEFAULT_PHYSICS_PARAMS, crr: 5 } };
    expect(() => ActivitySchema.parse(bad)).toThrow();
  });
});

describe('ActivityPointsPayloadSchema', () => {
  const point = { lat: 45.1, lon: 11.1, ele: 200, timeSec: 0, powerW: 200, distM: 0 };

  it('accetta un payload con almeno 2 punti', () => {
    const payload = { activityId: 'act1', schemaVersion: 1, points: [point, { ...point, timeSec: 1 }] };
    expect(() => ActivityPointsPayloadSchema.parse(payload)).not.toThrow();
  });

  it('rifiuta un payload con un solo punto', () => {
    const payload = { activityId: 'act1', schemaVersion: 1, points: [point] };
    expect(() => ActivityPointsPayloadSchema.parse(payload)).toThrow();
  });

  it('accetta ele/powerW/distM null (device che non li riporta)', () => {
    const nullable = { ...point, ele: null, powerW: null, distM: null };
    const payload = { activityId: 'act1', schemaVersion: 1, points: [nullable, { ...nullable, timeSec: 1 }] };
    expect(() => ActivityPointsPayloadSchema.parse(payload)).not.toThrow();
  });
});
